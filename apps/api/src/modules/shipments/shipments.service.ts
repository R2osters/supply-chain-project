import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { haversineKm, type LatLng, type ShipmentStatus } from '@scip/shared';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { paginated, safeOrderBy, type PaginatedResult } from '../../common/dto/pagination.dto';
import { requireCompanyId, scopedShipmentWhere } from '../../common/tenancy/tenant-scope';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { DOMAIN_EVENTS, DomainEventsService } from '../events/domain-events.service';
import { computeEta, assessLateness, type EtaResult } from '../eta/eta-engine';
import {
  ACTIVE_STATUSES,
  IN_MOTION_STATUSES,
  SHIPMENT_TRANSITIONS,
  assertTransition,
} from './shipment-status';
import type {
  CreateShipmentDto,
  ShipmentQueryDto,
  UpdateShipmentDto,
} from './shipments.dto';

const SORTABLE = [
  'trackingNumber',
  'status',
  'plannedDepartureAt',
  'plannedArrivalAt',
  'estimatedArrivalAt',
  'delayProbability',
  'createdAt',
] as const;

/** GPS fixes used to estimate the observed average speed of a trip. */
const SPEED_SAMPLE_LIMIT = 60;

@Injectable()
export class ShipmentsService {
  private readonly logger = new Logger(ShipmentsService.name);
  private readonly roadWindingFactor: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEventsService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.roadWindingFactor = config.get('providers', { infer: true }).roadWindingFactor;
  }

  /* ----------------------------------------------------------------- reads */

  async list(user: AuthenticatedUser, query: ShipmentQueryDto): Promise<PaginatedResult<unknown>> {
    const where = scopedShipmentWhere(user, {
      ...(query.status ? { status: query.status } : {}),
      ...(query.activeOnly === 'true' ? { status: { in: ACTIVE_STATUSES } } : {}),
      ...(query.carrierId ? { carrierId: query.carrierId } : {}),
      ...(query.vehicleId ? { vehicleId: query.vehicleId } : {}),
      ...(query.minDelayProbability !== undefined
        ? { delayProbability: { gte: query.minDelayProbability } }
        : {}),
      ...(query.search
        ? {
            OR: [
              { trackingNumber: { contains: query.search, mode: 'insensitive' } },
              { originName: { contains: query.search, mode: 'insensitive' } },
              { destinationName: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    }) as Prisma.ShipmentWhereInput;

    const [data, total] = await Promise.all([
      this.prisma.shipment.findMany({
        where,
        include: {
          carrier: { select: { id: true, name: true, onTimeRate: true } },
          vehicle: { select: { id: true, plateNumber: true, type: true } },
          driver: { select: { id: true, firstName: true, lastName: true } },
          customer: { select: { id: true, name: true } },
          purchaseOrder: { select: { id: true, orderNumber: true } },
          _count: { select: { items: true, anomalies: true, incidents: true } },
        },
        orderBy: safeOrderBy(query, SORTABLE, 'plannedDepartureAt'),
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.shipment.count({ where }),
    ]);

    return paginated(
      data.map((s) => ({
        ...s,
        isLate:
          s.estimatedArrivalAt !== null &&
          s.estimatedArrivalAt.getTime() > s.plannedArrivalAt.getTime(),
      })),
      total,
      query,
    );
  }

  async findOne(user: AuthenticatedUser, id: string) {
    const shipment = await this.prisma.shipment.findFirst({
      where: scopedShipmentWhere(user, { id }) as Prisma.ShipmentWhereInput,
      include: {
        carrier: true,
        vehicle: true,
        driver: true,
        route: true,
        customer: true,
        originWarehouse: { select: { id: true, code: true, name: true } },
        destinationWarehouse: { select: { id: true, code: true, name: true } },
        purchaseOrder: { select: { id: true, orderNumber: true, status: true, supplierId: true } },
        items: { include: { product: { select: { id: true, sku: true, name: true } } } },
        delivery: { include: { proof: true } },
        anomalies: { where: { resolvedAt: null }, orderBy: { detectedAt: 'desc' } },
        incidents: { where: { status: { in: ['OPEN', 'INVESTIGATING'] } } },
      },
    });

    if (!shipment) throw new NotFoundException(`No shipment found with id ${id}`);

    return {
      ...shipment,
      allowedTransitions: SHIPMENT_TRANSITIONS[shipment.status as ShipmentStatus],
    };
  }

  /**
   * The public-facing tracking view: status history, breadcrumb trail, live ETA.
   * Positions are downsampled before leaving the server — a week-long trip at one fix every
   * five seconds is ~120 000 points, which no map needs and no browser enjoys.
   */
  async tracking(user: AuthenticatedUser, id: string, maxPoints = 500) {
    const shipment = await this.findOne(user, id);

    const [events, positionCount] = await Promise.all([
      this.prisma.shipmentEvent.findMany({
        where: { shipmentId: id },
        orderBy: { occurredAt: 'asc' },
      }),
      this.prisma.gpsPosition.count({ where: { shipmentId: id } }),
    ]);

    // Take every Nth row in SQL so the whole track never lands in memory.
    const stride = Math.max(1, Math.ceil(positionCount / maxPoints));
    const positions = await this.prisma.$queryRaw<
      Array<{
        latitude: number;
        longitude: number;
        speedKmh: number | null;
        headingDegrees: number | null;
        recordedAt: Date;
        isSimulated: boolean;
      }>
    >`
      SELECT latitude, longitude, "speedKmh", "headingDegrees", "recordedAt", "isSimulated"
        FROM (
          SELECT latitude, longitude, "speedKmh", "headingDegrees", "recordedAt", "isSimulated",
                 ROW_NUMBER() OVER (ORDER BY "recordedAt") AS rn
            FROM "gps_positions"
           WHERE "shipmentId" = ${id}
        ) numbered
       WHERE rn % ${stride} = 0 OR rn = 1
       ORDER BY "recordedAt"
    `;

    const eta = await this.computeCurrentEta(id);

    return {
      shipment: {
        id: shipment.id,
        trackingNumber: shipment.trackingNumber,
        status: shipment.status,
        origin: {
          name: shipment.originName,
          latitude: shipment.originLatitude,
          longitude: shipment.originLongitude,
        },
        destination: {
          name: shipment.destinationName,
          latitude: shipment.destinationLatitude,
          longitude: shipment.destinationLongitude,
        },
        plannedDepartureAt: shipment.plannedDepartureAt,
        actualDepartureAt: shipment.actualDepartureAt,
        plannedArrivalAt: shipment.plannedArrivalAt,
        estimatedArrivalAt: shipment.estimatedArrivalAt,
        actualArrivalAt: shipment.actualArrivalAt,
        travelledDistanceKm: shipment.travelledDistanceKm,
        plannedDistanceKm: shipment.plannedDistanceKm,
        delayProbability: shipment.delayProbability,
        delayRisk: shipment.delayRisk,
        isDemoData: shipment.isDemoData,
      },
      route: shipment.route
        ? { id: shipment.route.id, name: shipment.route.name, polyline: shipment.route.polyline }
        : null,
      events,
      anomalies: shipment.anomalies,
      positions,
      positionsTotal: positionCount,
      positionsSampledEvery: stride,
      eta,
    };
  }

  /* ---------------------------------------------------------------- create */

  async create(user: AuthenticatedUser, dto: CreateShipmentDto) {
    const companyId = requireCompanyId(user);

    const origin = await this.resolveOrigin(companyId, dto);
    const destination = await this.resolveDestination(companyId, dto);

    await this.assertFleetBelongsToCompany(companyId, dto);

    const route = dto.routeId
      ? await this.prisma.route.findFirst({ where: { id: dto.routeId, companyId } })
      : null;
    if (dto.routeId && !route) throw new BadRequestException('Route not found in your company');

    const products = await this.prisma.product.findMany({
      where: { id: { in: dto.items.map((i) => i.productId) }, companyId },
    });
    if (products.length !== new Set(dto.items.map((i) => i.productId)).size) {
      throw new BadRequestException('One or more products were not found in your company');
    }
    const productById = new Map(products.map((p) => [p.id, p]));

    const plannedDepartureAt = new Date(dto.plannedDepartureAt);
    const vehicle = dto.vehicleId
      ? await this.prisma.vehicle.findUnique({ where: { id: dto.vehicleId } })
      : null;

    const plannedDistanceKm = route
      ? route.distanceKm
      : haversineKm(origin.point, destination.point) * this.roadWindingFactor;

    // A promised arrival is derived from the ETA engine when the caller does not supply one, so
    // every shipment has a deadline to be measured against — "no promise" makes on-time
    // performance unmeasurable.
    const plannedArrivalAt = dto.plannedArrivalAt
      ? new Date(dto.plannedArrivalAt)
      : new Date(
          plannedDepartureAt.getTime() +
            computeEta({
              origin: origin.point,
              destination: destination.point,
              routePolyline: route ? (route.polyline as unknown as LatLng[]) : null,
              nominalSpeedKmh: vehicle?.nominalSpeedKmh ?? 60,
              roadWindingFactor: this.roadWindingFactor,
              now: plannedDepartureAt,
            }).estimatedDurationSeconds * 1000,
        );

    if (plannedArrivalAt.getTime() < plannedDepartureAt.getTime()) {
      throw new BadRequestException('plannedArrivalAt cannot be before plannedDepartureAt');
    }

    const totals = dto.items.reduce(
      (acc, item) => {
        const product = productById.get(item.productId)!;
        return {
          units: acc.units + item.quantity,
          weightKg: acc.weightKg + item.quantity * (product.weightKg ?? 0),
          value: acc.value + item.quantity * Number(product.unitCost),
        };
      },
      { units: 0, weightKg: 0, value: 0 },
    );

    if (vehicle && totals.units > Number(vehicle.capacityUnits)) {
      throw new BadRequestException(
        `Load of ${totals.units} units exceeds vehicle capacity of ${Number(vehicle.capacityUnits)}`,
      );
    }

    const trackingNumber = await this.allocateTrackingNumber(companyId);

    return this.prisma.$transaction(async (tx) => {
      const shipment = await tx.shipment.create({
        data: {
          companyId,
          purchaseOrderId: dto.purchaseOrderId ?? null,
          carrierId: dto.carrierId ?? null,
          vehicleId: dto.vehicleId ?? null,
          driverId: dto.driverId ?? null,
          routeId: dto.routeId ?? null,
          customerId: dto.customerId ?? null,
          originWarehouseId: dto.originWarehouseId ?? null,
          destinationWarehouseId: dto.destinationWarehouseId ?? null,
          trackingNumber,
          status: 'PLANNED',
          originName: origin.name,
          originLatitude: origin.point.latitude,
          originLongitude: origin.point.longitude,
          destinationName: destination.name,
          destinationLatitude: destination.point.latitude,
          destinationLongitude: destination.point.longitude,
          plannedDepartureAt,
          plannedArrivalAt,
          plannedDistanceKm,
          totalUnits: totals.units,
          totalWeightKg: totals.weightKg || null,
          cargoValue: totals.value,
          notes: dto.notes ?? null,
          items: {
            create: dto.items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitValue: Number(productById.get(item.productId)!.unitCost),
              batchNumber: item.batchNumber ?? null,
            })),
          },
        },
        include: { items: true },
      });

      await tx.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          type: 'CREATED',
          description: `Shipment ${trackingNumber} planned from ${origin.name} to ${destination.name}`,
          toStatus: 'PLANNED',
          metadata: { plannedDistanceKm, plannedArrivalAt } as Prisma.InputJsonValue,
        },
      });

      return shipment;
    });
  }

  private async resolveOrigin(companyId: string, dto: CreateShipmentDto) {
    if (dto.originWarehouseId) {
      const warehouse = await this.prisma.warehouse.findFirst({
        where: { id: dto.originWarehouseId, companyId },
      });
      if (!warehouse) throw new BadRequestException('Origin warehouse not found in your company');
      return {
        name: dto.originName ?? warehouse.name,
        point: { latitude: warehouse.latitude, longitude: warehouse.longitude },
      };
    }

    if (
      dto.originName === undefined ||
      dto.originLatitude === undefined ||
      dto.originLongitude === undefined
    ) {
      throw new BadRequestException(
        'Provide originWarehouseId, or all of originName, originLatitude and originLongitude',
      );
    }
    return {
      name: dto.originName,
      point: { latitude: dto.originLatitude, longitude: dto.originLongitude },
    };
  }

  private async resolveDestination(companyId: string, dto: CreateShipmentDto) {
    if (dto.destinationWarehouseId) {
      const warehouse = await this.prisma.warehouse.findFirst({
        where: { id: dto.destinationWarehouseId, companyId },
      });
      if (!warehouse) {
        throw new BadRequestException('Destination warehouse not found in your company');
      }
      return {
        name: dto.destinationName ?? warehouse.name,
        point: { latitude: warehouse.latitude, longitude: warehouse.longitude },
      };
    }

    if (dto.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: { id: dto.customerId, companyId },
      });
      if (!customer) throw new BadRequestException('Customer not found in your company');
      if (customer.latitude === null || customer.longitude === null) {
        throw new BadRequestException(
          `Customer ${customer.name} has no coordinates; set them or pass explicit destination coordinates`,
        );
      }
      return {
        name: dto.destinationName ?? customer.name,
        point: { latitude: customer.latitude, longitude: customer.longitude },
      };
    }

    if (
      dto.destinationName === undefined ||
      dto.destinationLatitude === undefined ||
      dto.destinationLongitude === undefined
    ) {
      throw new BadRequestException(
        'Provide destinationWarehouseId, customerId, or all of destinationName, destinationLatitude and destinationLongitude',
      );
    }
    return {
      name: dto.destinationName,
      point: { latitude: dto.destinationLatitude, longitude: dto.destinationLongitude },
    };
  }

  private async assertFleetBelongsToCompany(companyId: string, dto: CreateShipmentDto) {
    const checks: Array<[string | undefined, () => Promise<unknown>, string]> = [
      [dto.carrierId, () => this.prisma.carrier.findFirst({ where: { id: dto.carrierId, companyId } }), 'Carrier'],
      [dto.vehicleId, () => this.prisma.vehicle.findFirst({ where: { id: dto.vehicleId, companyId } }), 'Vehicle'],
      [dto.driverId, () => this.prisma.driver.findFirst({ where: { id: dto.driverId, companyId } }), 'Driver'],
      [dto.purchaseOrderId, () => this.prisma.purchaseOrder.findFirst({ where: { id: dto.purchaseOrderId, companyId } }), 'Purchase order'],
    ];

    for (const [id, find, label] of checks) {
      if (!id) continue;
      if (!(await find())) throw new BadRequestException(`${label} not found in your company`);
    }
  }

  /**
   * `SHP-<year><month>-<random>`. Random rather than sequential because a tracking number is
   * handed to customers and carriers: a guessable sequence leaks shipment volume and lets anyone
   * enumerate other people's consignments.
   */
  private async allocateTrackingNumber(companyId: string): Promise<string> {
    const now = new Date();
    const prefix = `SHP-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-`;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const candidate = `${prefix}${randomBytes(4).toString('hex').toUpperCase()}`;
      const taken = await this.prisma.shipment.findFirst({
        where: { companyId, trackingNumber: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }
    throw new BadRequestException('Could not allocate a tracking number; please retry');
  }

  /* ---------------------------------------------------------------- update */

  async update(user: AuthenticatedUser, id: string, dto: UpdateShipmentDto) {
    const shipment = await this.findOne(user, id);
    if (['DELIVERED', 'CANCELLED'].includes(shipment.status)) {
      throw new BadRequestException(`A ${shipment.status} shipment can no longer be edited`);
    }

    await this.assertFleetBelongsToCompany(shipment.companyId, dto as CreateShipmentDto);

    return this.prisma.shipment.update({
      where: { id },
      data: {
        ...(dto.carrierId !== undefined ? { carrierId: dto.carrierId } : {}),
        ...(dto.vehicleId !== undefined ? { vehicleId: dto.vehicleId } : {}),
        ...(dto.driverId !== undefined ? { driverId: dto.driverId } : {}),
        ...(dto.routeId !== undefined ? { routeId: dto.routeId } : {}),
        ...(dto.plannedDepartureAt ? { plannedDepartureAt: new Date(dto.plannedDepartureAt) } : {}),
        ...(dto.plannedArrivalAt ? { plannedArrivalAt: new Date(dto.plannedArrivalAt) } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });
  }

  /* ------------------------------------------------------------ transition */

  async transition(
    user: AuthenticatedUser,
    id: string,
    to: ShipmentStatus,
    note?: string,
    location?: LatLng,
  ) {
    const shipment = await this.findOne(user, id);
    const from = shipment.status as ShipmentStatus;
    assertTransition(from, to);

    const now = new Date();
    const timestamps: Prisma.ShipmentUpdateInput = {};
    if (to === 'DEPARTED' && !shipment.actualDepartureAt) timestamps.actualDepartureAt = now;
    if (to === 'ARRIVED' && !shipment.actualArrivalAt) timestamps.actualArrivalAt = now;
    if (to === 'DELIVERED') {
      timestamps.deliveredAt = now;
      if (!shipment.actualArrivalAt) timestamps.actualArrivalAt = now;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.shipment.update({
        where: { id },
        data: { status: to, ...timestamps },
      });

      await tx.shipmentEvent.create({
        data: {
          shipmentId: id,
          type: to === 'DEPARTED' ? 'DEPARTED' : to === 'ARRIVED' ? 'ARRIVED' : to === 'DELIVERED' ? 'DELIVERED' : 'STATUS_CHANGED',
          description: note ?? `Status changed from ${from} to ${to}`,
          fromStatus: from,
          toStatus: to,
          latitude: location?.latitude ?? null,
          longitude: location?.longitude ?? null,
          isDemoData: shipment.isDemoData,
        },
      });

      // The vehicle's availability must follow the shipment, or dispatch will double-book it.
      if (shipment.vehicleId) {
        if (IN_MOTION_STATUSES.includes(to)) {
          await tx.vehicle.update({
            where: { id: shipment.vehicleId },
            data: { status: 'IN_TRANSIT' },
          });
        } else if (['DELIVERED', 'CANCELLED'].includes(to)) {
          await tx.vehicle.update({
            where: { id: shipment.vehicleId },
            data: { status: 'AVAILABLE' },
          });
        }
      }

      if (to === 'DELAYED') {
        await this.events.publish(tx, {
          companyId: shipment.companyId,
          type: DOMAIN_EVENTS.SHIPMENT_DELAYED,
          subjectType: 'SHIPMENT',
          subjectId: id,
          payload: {
            trackingNumber: shipment.trackingNumber,
            purchaseOrderId: shipment.purchaseOrderId,
            plannedArrivalAt: shipment.plannedArrivalAt,
            estimatedArrivalAt: shipment.estimatedArrivalAt,
            productIds: shipment.items.map((i) => i.productId),
          },
        });
      }

      if (to === 'DELIVERED') {
        await this.events.publish(tx, {
          companyId: shipment.companyId,
          type: DOMAIN_EVENTS.SHIPMENT_DELIVERED,
          subjectType: 'SHIPMENT',
          subjectId: id,
          payload: {
            trackingNumber: shipment.trackingNumber,
            onTime: now.getTime() <= shipment.plannedArrivalAt.getTime(),
            purchaseOrderId: shipment.purchaseOrderId,
          },
        });
      }

      return result;
    });

    if (to === 'DELIVERED' && shipment.carrierId) {
      await this.updateCarrierPerformance(shipment.carrierId);
    }

    return updated;
  }

  /** Recomputes a carrier's on-time rate from its completed shipments. */
  private async updateCarrierPerformance(carrierId: string): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      Array<{ total: bigint; on_time: bigint; avg_delay_hours: number | null }>
    >`
      SELECT COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE "deliveredAt" <= "plannedArrivalAt")::bigint AS on_time,
             AVG(GREATEST(EXTRACT(EPOCH FROM ("deliveredAt" - "plannedArrivalAt")) / 3600, 0))
               ::double precision AS avg_delay_hours
        FROM "shipments"
       WHERE "carrierId" = ${carrierId}
         AND status = 'DELIVERED'
         AND "deliveredAt" IS NOT NULL
    `;

    const row = rows[0];
    const total = Number(row?.total ?? 0);
    if (total === 0) return;

    await this.prisma.carrier.update({
      where: { id: carrierId },
      data: {
        shipmentsCompleted: total,
        onTimeRate: Number(row.on_time) / total,
        averageDelayHours: Number(row.avg_delay_hours ?? 0),
      },
    });
  }

  /* ------------------------------------------------------------------- ETA */

  /**
   * Recomputes the ETA from the latest telemetry and persists it. Called after every GPS batch
   * and on demand. Publishes a delay event the first time a shipment crosses into "certainly
   * late", not on every recomputation — otherwise OPTIMIZE would be re-planning every 5 seconds.
   */
  async computeCurrentEta(shipmentId: string): Promise<
    (EtaResult & { lateness: ReturnType<typeof assessLateness>; basedOnSamples: number }) | null
  > {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: { vehicle: true, route: true, carrier: true },
    });
    if (!shipment) return null;
    if (['DELIVERED', 'CANCELLED'].includes(shipment.status)) return null;

    const recent = await this.prisma.gpsPosition.findMany({
      where: { shipmentId, speedKmh: { not: null } },
      orderBy: { recordedAt: 'desc' },
      take: SPEED_SAMPLE_LIMIT,
      select: { latitude: true, longitude: true, speedKmh: true, recordedAt: true },
    });

    // Stationary fixes (loading, traffic lights, rest stops) are excluded from the *speed* mean:
    // including them conflates "stopped" with "slow" and produces an ETA that keeps sliding.
    const moving = recent.filter((p) => (p.speedKmh ?? 0) > 3);
    const observedAverageSpeedKmh =
      moving.length > 0 ? moving.reduce((s, p) => s + (p.speedKmh ?? 0), 0) / moving.length : null;

    const latest = recent[0];
    const currentLocation: LatLng | null =
      latest && shipment.status !== 'PLANNED'
        ? { latitude: latest.latitude, longitude: latest.longitude }
        : null;

    const eta = computeEta({
      currentLocation,
      origin: { latitude: shipment.originLatitude, longitude: shipment.originLongitude },
      destination: {
        latitude: shipment.destinationLatitude,
        longitude: shipment.destinationLongitude,
      },
      routePolyline: shipment.route ? (shipment.route.polyline as unknown as LatLng[]) : null,
      nominalSpeedKmh: shipment.vehicle?.nominalSpeedKmh ?? 60,
      observedAverageSpeedKmh,
      observedSampleCount: moving.length,
      roadWindingFactor: this.roadWindingFactor,
    });

    const lateness = assessLateness(eta, shipment.plannedArrivalAt);

    const wasLate = shipment.status === 'DELAYED';
    await this.prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        estimatedArrivalAt: eta.estimatedArrival,
        etaConfidence: eta.confidenceScore,
        lastEtaComputedAt: new Date(),
      },
    });

    if (lateness.certainlyLate && !wasLate && IN_MOTION_STATUSES.includes(shipment.status as ShipmentStatus)) {
      await this.prisma.$transaction(async (tx) => {
        await tx.shipment.update({ where: { id: shipmentId }, data: { status: 'DELAYED' } });
        await tx.shipmentEvent.create({
          data: {
            shipmentId,
            type: 'DELAY_DETECTED',
            description: `Projected ${lateness.minutesLate.toFixed(0)} minutes late; even the optimistic end of the arrival window misses the promise`,
            fromStatus: shipment.status,
            toStatus: 'DELAYED',
            metadata: {
              estimatedArrival: eta.estimatedArrival,
              plannedArrival: shipment.plannedArrivalAt,
              confidence: eta.confidenceScore,
            } as Prisma.InputJsonValue,
            isDemoData: shipment.isDemoData,
          },
        });
        await this.events.publish(tx, {
          companyId: shipment.companyId,
          type: DOMAIN_EVENTS.SHIPMENT_DELAYED,
          subjectType: 'SHIPMENT',
          subjectId: shipmentId,
          payload: {
            trackingNumber: shipment.trackingNumber,
            purchaseOrderId: shipment.purchaseOrderId,
            minutesLate: lateness.minutesLate,
          },
        });
      });
    }

    return { ...eta, lateness, basedOnSamples: moving.length };
  }

  async recomputeEta(user: AuthenticatedUser, id: string) {
    await this.findOne(user, id);
    const eta = await this.computeCurrentEta(id);
    if (!eta) {
      throw new BadRequestException('This shipment is complete; there is no ETA to compute');
    }
    return eta;
  }

  /** Batch recompute for every moving shipment. Driven by the scheduler. */
  async recomputeAllActive(companyId?: string): Promise<{ recomputed: number }> {
    const shipments = await this.prisma.shipment.findMany({
      where: {
        status: { in: IN_MOTION_STATUSES },
        ...(companyId ? { companyId } : {}),
      },
      select: { id: true },
    });

    let recomputed = 0;
    for (const { id } of shipments) {
      try {
        await this.computeCurrentEta(id);
        recomputed += 1;
      } catch (error) {
        this.logger.error(
          `ETA recompute failed for shipment ${id}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    return { recomputed };
  }
}
