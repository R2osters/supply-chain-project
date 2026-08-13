import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { haversineKm } from '@scip/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { companyFilter, requireCompanyId } from '../../common/tenancy/tenant-scope';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { ShipmentsService } from '../shipments/shipments.service';
import type { GpsFixDto, IngestGpsDto, NearbyQueryDto } from './gps.dto';
import { SpatialRepository } from './spatial.repository';
import { TrackingGateway } from './tracking.gateway';

/** Fixes further in the future than this are clock-skew or spoofing, and are rejected. */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/** Two consecutive fixes implying a speed above this are physically impossible for road freight. */
const IMPLAUSIBLE_SPEED_KMH = 250;

/** Fixes closer together than this add noise without adding information. */
const MIN_FIX_SEPARATION_M = 5;

@Injectable()
export class GpsService {
  private readonly logger = new Logger(GpsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly spatial: SpatialRepository,
    private readonly gateway: TrackingGateway,
    private readonly shipments: ShipmentsService,
  ) {}

  /**
   * Telemetry ingest.
   *
   * Devices are not trustworthy narrators: they buffer while out of coverage and replay out of
   * order, they occasionally emit a fix from the middle of the ocean, and their clocks drift. So
   * every batch is sorted, filtered and sanity-checked before it is allowed to move a vehicle on
   * the map. Rejected fixes are counted and returned rather than silently dropped — a device
   * whose fixes are all being discarded is an operational problem someone needs to see.
   */
  async ingest(user: AuthenticatedUser, dto: IngestGpsDto) {
    const companyId = requireCompanyId(user);

    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: dto.vehicleId, companyId },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found in your company');

    // A DRIVER may only post telemetry for a vehicle on one of their own shipments.
    if (user.role === 'DRIVER') {
      const own = await this.prisma.shipment.findFirst({
        where: {
          vehicleId: dto.vehicleId,
          driver: { userId: user.id },
          status: { in: ['LOADING', 'DEPARTED', 'IN_TRANSIT', 'DELAYED'] },
        },
        select: { id: true },
      });
      if (!own) {
        throw new BadRequestException('You are not assigned to an active shipment on this vehicle');
      }
    }

    const shipmentId = await this.resolveShipmentId(companyId, dto);

    const now = Date.now();
    const sorted = [...dto.fixes].sort(
      (a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime(),
    );

    const rejected: Array<{ recordedAt: string; reason: string }> = [];
    const accepted: GpsFixDto[] = [];

    let previous = vehicle.lastPositionAt
      ? {
          latitude: vehicle.lastLatitude!,
          longitude: vehicle.lastLongitude!,
          at: vehicle.lastPositionAt.getTime(),
        }
      : null;

    for (const fix of sorted) {
      const at = new Date(fix.recordedAt).getTime();

      if (!Number.isFinite(at)) {
        rejected.push({ recordedAt: fix.recordedAt, reason: 'unparseable timestamp' });
        continue;
      }
      if (at > now + MAX_FUTURE_SKEW_MS) {
        rejected.push({ recordedAt: fix.recordedAt, reason: 'timestamp is in the future' });
        continue;
      }

      if (previous) {
        const distanceKm = haversineKm(
          { latitude: previous.latitude, longitude: previous.longitude },
          { latitude: fix.latitude, longitude: fix.longitude },
        );
        const hours = (at - previous.at) / 3_600_000;

        if (hours > 0) {
          const impliedSpeed = distanceKm / hours;
          if (impliedSpeed > IMPLAUSIBLE_SPEED_KMH) {
            rejected.push({
              recordedAt: fix.recordedAt,
              reason: `implied speed ${impliedSpeed.toFixed(0)} km/h from the previous fix is not physically plausible`,
            });
            continue;
          }
        } else if (hours === 0 && distanceKm * 1000 > MIN_FIX_SEPARATION_M) {
          rejected.push({ recordedAt: fix.recordedAt, reason: 'two positions at the same instant' });
          continue;
        }

        if (distanceKm * 1000 < MIN_FIX_SEPARATION_M && hours * 3600 < 30) {
          // Parked vehicle jitter. Not an error, just not worth storing.
          rejected.push({ recordedAt: fix.recordedAt, reason: 'below the minimum movement threshold' });
          continue;
        }
      }

      accepted.push(fix);
      previous = { latitude: fix.latitude, longitude: fix.longitude, at };
    }

    if (accepted.length === 0) {
      return {
        vehicleId: dto.vehicleId,
        shipmentId,
        accepted: 0,
        rejected: rejected.length,
        rejectedDetail: rejected,
        message: 'No fix in this batch passed validation',
      };
    }

    await this.prisma.gpsPosition.createMany({
      data: accepted.map((fix) => ({
        vehicleId: dto.vehicleId,
        shipmentId,
        latitude: fix.latitude,
        longitude: fix.longitude,
        speedKmh: fix.speedKmh ?? null,
        headingDegrees: fix.headingDegrees ?? null,
        altitudeM: fix.altitudeM ?? null,
        accuracyM: fix.accuracyM ?? null,
        isSimulated: false,
        recordedAt: new Date(fix.recordedAt),
      })),
      skipDuplicates: true,
    });

    const last = accepted[accepted.length - 1];

    // The denormalised position is only moved forward in time, so a late-arriving buffered batch
    // from an hour ago cannot drag the live map backwards.
    await this.prisma.vehicle.updateMany({
      where: {
        id: dto.vehicleId,
        OR: [{ lastPositionAt: null }, { lastPositionAt: { lt: new Date(last.recordedAt) } }],
      },
      data: {
        lastLatitude: last.latitude,
        lastLongitude: last.longitude,
        lastSpeedKmh: last.speedKmh ?? null,
        lastHeadingDegrees: last.headingDegrees ?? null,
        lastPositionAt: new Date(last.recordedAt),
      },
    });

    let eta = null;
    if (shipmentId) {
      const travelled = await this.spatial.travelledDistanceKm(shipmentId);
      await this.prisma.shipment.update({
        where: { id: shipmentId },
        data: { travelledDistanceKm: travelled },
      });
      eta = await this.shipments.computeCurrentEta(shipmentId);
    }

    this.gateway.emitPosition(companyId, shipmentId, {
      vehicleId: dto.vehicleId,
      shipmentId,
      latitude: last.latitude,
      longitude: last.longitude,
      speedKmh: last.speedKmh ?? null,
      headingDegrees: last.headingDegrees ?? null,
      recordedAt: last.recordedAt,
      estimatedArrivalAt: eta?.estimatedArrival ?? null,
      isSimulated: false,
    });

    return {
      vehicleId: dto.vehicleId,
      shipmentId,
      accepted: accepted.length,
      rejected: rejected.length,
      rejectedDetail: rejected,
      estimatedArrival: eta?.estimatedArrival ?? null,
      etaConfidence: eta?.confidenceScore ?? null,
    };
  }

  private async resolveShipmentId(companyId: string, dto: IngestGpsDto): Promise<string | null> {
    if (dto.shipmentId) {
      const shipment = await this.prisma.shipment.findFirst({
        where: { id: dto.shipmentId, companyId },
        select: { id: true, vehicleId: true },
      });
      if (!shipment) throw new NotFoundException('Shipment not found in your company');
      if (shipment.vehicleId && shipment.vehicleId !== dto.vehicleId) {
        throw new BadRequestException('That shipment is assigned to a different vehicle');
      }
      return shipment.id;
    }

    const active = await this.prisma.shipment.findFirst({
      where: {
        companyId,
        vehicleId: dto.vehicleId,
        status: { in: ['LOADING', 'DEPARTED', 'IN_TRANSIT', 'DELAYED'] },
      },
      orderBy: { plannedDepartureAt: 'desc' },
      select: { id: true },
    });
    return active?.id ?? null;
  }

  /* ----------------------------------------------------------------- reads */

  async history(user: AuthenticatedUser, vehicleId: string, from?: string, to?: string, limit = 1000) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, ...companyFilter(user) },
      select: { id: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found in your company');

    return this.prisma.gpsPosition.findMany({
      where: {
        vehicleId,
        ...(from || to
          ? {
              recordedAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { recordedAt: 'desc' },
      take: Math.min(limit, 5000),
    });
  }

  nearby(user: AuthenticatedUser, query: NearbyQueryDto) {
    return this.spatial.vehiclesNearPoint(
      requireCompanyId(user),
      query.latitude,
      query.longitude,
      query.radiusKm ?? 20,
      query.staleAfterMinutes ?? 30,
    );
  }

  nearWarehouses(user: AuthenticatedUser, radiusKm = 20) {
    return this.spatial.vehiclesNearWarehouses(requireCompanyId(user), radiusKm);
  }

  fleet(user: AuthenticatedUser) {
    return this.spatial.fleetSnapshot(requireCompanyId(user));
  }
}
