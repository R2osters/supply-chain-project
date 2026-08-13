import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The raw PostGIS layer.
 *
 * These are the queries that genuinely need the database's spatial index rather than application
 * geometry: they filter *across rows* by distance, which is exactly the shape a GiST index
 * accelerates and exactly the shape that would otherwise mean scanning every vehicle or every
 * position fix. Per-row maths (distance between two known points, deviation from a known
 * polyline) stays in `@scip/shared/geo`, where it is unit-testable without a database.
 *
 * Every query is parameterised through Prisma's tagged templates — no string interpolation of
 * user input into SQL anywhere in this file.
 */

export interface NearbyVehicle {
  id: string;
  plateNumber: string;
  label: string | null;
  type: string;
  status: string;
  latitude: number;
  longitude: number;
  speedKmh: number | null;
  headingDegrees: number | null;
  lastPositionAt: Date;
  distanceKm: number;
}

export interface VehicleNearWarehouse extends NearbyVehicle {
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
}

@Injectable()
export class SpatialRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Vehicles within `radiusKm` of a point, nearest first.
   * `ST_DWithin` on a geography column is index-assisted; `ST_Distance` in the SELECT then only
   * runs on the rows that survived the filter.
   */
  async vehiclesNearPoint(
    companyId: string,
    latitude: number,
    longitude: number,
    radiusKm: number,
    staleAfterMinutes: number,
  ): Promise<NearbyVehicle[]> {
    const cutoff = new Date(Date.now() - staleAfterMinutes * 60_000);

    return this.prisma.$queryRaw<NearbyVehicle[]>`
      SELECT v.id,
             v."plateNumber",
             v.label,
             v.type::text                AS type,
             v.status::text              AS status,
             v."lastLatitude"            AS latitude,
             v."lastLongitude"           AS longitude,
             v."lastSpeedKmh"            AS "speedKmh",
             v."lastHeadingDegrees"      AS "headingDegrees",
             v."lastPositionAt",
             (ST_Distance(
                v."last_geog",
                ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography
              ) / 1000.0)::double precision AS "distanceKm"
        FROM "vehicles" v
       WHERE v."companyId" = ${companyId}
         AND v."last_geog" IS NOT NULL
         AND v."lastPositionAt" >= ${cutoff}
         AND ST_DWithin(
               v."last_geog",
               ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography,
               ${radiusKm * 1000}
             )
       ORDER BY "distanceKm"
       LIMIT 500
    `;
  }

  /**
   * The "which trucks are about to arrive" query from the brief. A lateral join keeps it to one
   * pass: for each warehouse, find the vehicles inside the radius.
   */
  async vehiclesNearWarehouses(
    companyId: string,
    radiusKm: number,
    staleAfterMinutes = 30,
  ): Promise<VehicleNearWarehouse[]> {
    const cutoff = new Date(Date.now() - staleAfterMinutes * 60_000);

    return this.prisma.$queryRaw<VehicleNearWarehouse[]>`
      SELECT w.id                        AS "warehouseId",
             w.code                      AS "warehouseCode",
             w.name                      AS "warehouseName",
             v.id,
             v."plateNumber",
             v.label,
             v.type::text                AS type,
             v.status::text              AS status,
             v."lastLatitude"            AS latitude,
             v."lastLongitude"           AS longitude,
             v."lastSpeedKmh"            AS "speedKmh",
             v."lastHeadingDegrees"      AS "headingDegrees",
             v."lastPositionAt",
             (ST_Distance(v."last_geog", w."geog") / 1000.0)::double precision AS "distanceKm"
        FROM "warehouses" w
        JOIN LATERAL (
               SELECT *
                 FROM "vehicles" veh
                WHERE veh."companyId" = w."companyId"
                  AND veh."last_geog" IS NOT NULL
                  AND veh."lastPositionAt" >= ${cutoff}
                  AND ST_DWithin(veh."last_geog", w."geog", ${radiusKm * 1000})
             ) v ON TRUE
       WHERE w."companyId" = ${companyId}
         AND w."isActive" = TRUE
       ORDER BY "warehouseCode", "distanceKm"
    `;
  }

  /**
   * Whether a point is inside a warehouse's own geofence radius. Used for automatic arrival
   * detection, which is why the radius comes from the warehouse row rather than a parameter.
   */
  async warehousesContainingPoint(
    companyId: string,
    latitude: number,
    longitude: number,
  ): Promise<Array<{ id: string; code: string; name: string; distanceM: number; radiusM: number }>> {
    return this.prisma.$queryRaw`
      SELECT w.id,
             w.code,
             w.name,
             ST_Distance(
               w."geog",
               ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography
             )::double precision AS "distanceM",
             w."geofenceRadiusM"::double precision AS "radiusM"
        FROM "warehouses" w
       WHERE w."companyId" = ${companyId}
         AND ST_DWithin(
               w."geog",
               ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography,
               w."geofenceRadiusM"
             )
       ORDER BY "distanceM"
    `;
  }

  /**
   * Maximum lateral distance between a shipment's actual track and its planned corridor.
   * Computed in the database because it compares every recorded fix against a LineString —
   * pulling the whole track into Node to do it would move megabytes per shipment.
   */
  async maxCorridorDeviationMeters(shipmentId: string): Promise<{
    maxDeviationM: number;
    positions: number;
    worstLatitude: number | null;
    worstLongitude: number | null;
    worstRecordedAt: Date | null;
  } | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        max_deviation_m: number | null;
        positions: bigint;
        worst_latitude: number | null;
        worst_longitude: number | null;
        worst_recorded_at: Date | null;
      }>
    >`
      WITH corridor AS (
        SELECT r."corridor_geog" AS geog
          FROM "shipments" s
          JOIN "routes" r ON r.id = s."routeId"
         WHERE s.id = ${shipmentId}
           AND r."corridor_geog" IS NOT NULL
      ),
      deviations AS (
        SELECT p.latitude,
               p.longitude,
               p."recordedAt",
               ST_Distance(p."geog", c.geog) AS deviation_m
          FROM "gps_positions" p
         CROSS JOIN corridor c
         WHERE p."shipmentId" = ${shipmentId}
      )
      SELECT MAX(deviation_m)::double precision AS max_deviation_m,
             COUNT(*)::bigint                   AS positions,
             (SELECT latitude     FROM deviations ORDER BY deviation_m DESC LIMIT 1) AS worst_latitude,
             (SELECT longitude    FROM deviations ORDER BY deviation_m DESC LIMIT 1) AS worst_longitude,
             (SELECT "recordedAt" FROM deviations ORDER BY deviation_m DESC LIMIT 1) AS worst_recorded_at
        FROM deviations
    `;

    const row = rows[0];
    if (!row || Number(row.positions) === 0) return null;

    return {
      maxDeviationM: Number(row.max_deviation_m ?? 0),
      positions: Number(row.positions),
      worstLatitude: row.worst_latitude,
      worstLongitude: row.worst_longitude,
      worstRecordedAt: row.worst_recorded_at,
    };
  }

  /**
   * Total ground distance covered by a shipment, summed from consecutive fixes.
   * `LAG` over the ordered track does in one query what would otherwise be a loop in Node.
   */
  async travelledDistanceKm(shipmentId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ km: number | null }>>`
      WITH ordered AS (
        SELECT "geog",
               LAG("geog") OVER (ORDER BY "recordedAt") AS previous
          FROM "gps_positions"
         WHERE "shipmentId" = ${shipmentId}
      )
      SELECT (COALESCE(SUM(ST_Distance("geog", previous)), 0) / 1000.0)::double precision AS km
        FROM ordered
       WHERE previous IS NOT NULL
    `;
    return Number(rows[0]?.km ?? 0);
  }

  /** Live map payload: one row per vehicle that has reported recently. */
  async fleetSnapshot(companyId: string, staleAfterMinutes = 60) {
    const cutoff = new Date(Date.now() - staleAfterMinutes * 60_000);

    return this.prisma.$queryRaw<
      Array<{
        vehicleId: string;
        plateNumber: string;
        label: string | null;
        type: string;
        status: string;
        latitude: number;
        longitude: number;
        speedKmh: number | null;
        headingDegrees: number | null;
        lastPositionAt: Date;
        shipmentId: string | null;
        trackingNumber: string | null;
        shipmentStatus: string | null;
        destinationName: string | null;
        estimatedArrivalAt: Date | null;
        delayProbability: number | null;
        driverName: string | null;
        isDemoData: boolean;
      }>
    >`
      SELECT v.id                   AS "vehicleId",
             v."plateNumber",
             v.label,
             v.type::text           AS type,
             v.status::text         AS status,
             v."lastLatitude"       AS latitude,
             v."lastLongitude"      AS longitude,
             v."lastSpeedKmh"       AS "speedKmh",
             v."lastHeadingDegrees" AS "headingDegrees",
             v."lastPositionAt",
             s.id                   AS "shipmentId",
             s."trackingNumber",
             s.status::text         AS "shipmentStatus",
             s."destinationName",
             s."estimatedArrivalAt",
             s."delayProbability",
             CASE WHEN d.id IS NULL THEN NULL
                  ELSE d."firstName" || ' ' || d."lastName" END AS "driverName",
             v."isDemoData"
        FROM "vehicles" v
        LEFT JOIN LATERAL (
               SELECT *
                 FROM "shipments" sh
                WHERE sh."vehicleId" = v.id
                  AND sh.status IN ('LOADING', 'DEPARTED', 'IN_TRANSIT', 'DELAYED')
                ORDER BY sh."plannedDepartureAt" DESC
                LIMIT 1
             ) s ON TRUE
        LEFT JOIN "drivers" d ON d.id = s."driverId"
       WHERE v."companyId" = ${companyId}
         AND v."lastPositionAt" IS NOT NULL
         AND v."lastPositionAt" >= ${cutoff}
       ORDER BY v."plateNumber"
    `;
  }

  /** Deletes position history older than the retention window. */
  async purgePositionsOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const deleted = await this.prisma.$executeRaw(
      Prisma.sql`DELETE FROM "gps_positions" WHERE "recordedAt" < ${cutoff}`,
    );
    return deleted;
  }
}
