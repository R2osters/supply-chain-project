import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { haversineKm, type LatLng } from '@scip/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { companyFilter, requireCompanyId } from '../../common/tenancy/tenant-scope';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { DOMAIN_EVENTS, DomainEventsService } from '../events/domain-events.service';
import { HazardsService } from '../hazards/hazards.service';
import { AiClientService } from './ai-client.service';

const DAY_MS = 86_400_000;

/**
 * Turns database state into AI-service requests and the answers back into database state.
 *
 * This is where the two halves of the platform actually meet: TRACK's tables are the input to
 * OPTIMIZE's models, and OPTIMIZE's output lands back in TRACK's tables as forecasts, risks and
 * recommendations that a user can act on. Keeping that translation in one service means the
 * shape of a request to the Python side is defined once, not re-derived in six controllers.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiClientService,
    private readonly events: DomainEventsService,
    private readonly hazards: HazardsService,
  ) {}

  /* --------------------------------------------------------------- forecast */

  /**
   * Forecasts one product from its own demand history.
   *
   * History comes from `demand_history`, which is written by outbound movements. A product with
   * no history is refused rather than forecast from nothing.
   */
  async forecastProduct(
    user: AuthenticatedUser,
    productId: string,
    horizonDays: 7 | 30 | 90 | 180 = 30,
  ) {
    const companyId = requireCompanyId(user);
    const product = await this.prisma.product.findFirst({
      where: { id: productId, companyId },
    });
    if (!product) throw new NotFoundException('Product not found in your company');

    const history = await this.prisma.demandHistory.findMany({
      where: { productId },
      orderBy: { date: 'asc' },
      select: { date: true, quantity: true },
    });

    if (history.length === 0) {
      throw new BadRequestException(
        `${product.sku} has no demand history. Record sales or outbound movements before forecasting.`,
      );
    }

    const response = await this.ai.post<ForecastResponse>(
      '/forecast',
      {
        productId,
        sku: product.sku,
        history: history.map((row) => ({
          date: row.date.toISOString().slice(0, 10),
          quantity: Number(row.quantity),
        })),
        horizonDays,
        serviceLevel: product.serviceLevel,
      },
      { record: { companyId, task: 'FORECAST', subjectType: 'PRODUCT', subjectId: productId } },
    );

    const stored = await this.prisma.forecast.create({
      data: {
        companyId,
        productId,
        horizonDays,
        modelName: response.selectedModel,
        points: response.forecast as unknown as Prisma.InputJsonValue,
        evaluations: response.evaluations as unknown as Prisma.InputJsonValue,
        residualStd: response.residualStd ?? 0,
        mae: pickMetric(response, 'mae'),
        rmse: pickMetric(response, 'rmse'),
        mape: pickMetricNullable(response, 'mape'),
        wape: pickMetric(response, 'wape'),
        dataQuality: response.dataQuality as unknown as Prisma.InputJsonValue,
        explanation: response.explanation as unknown as Prisma.InputJsonValue,
        isDemoData: product.isDemoData,
      },
    });

    await this.events.publishStandalone({
      companyId,
      type: DOMAIN_EVENTS.FORECAST_UPDATED,
      subjectType: 'PRODUCT',
      subjectId: productId,
      payload: { forecastId: stored.id, model: response.selectedModel, horizonDays },
    });

    return { ...response, forecastId: stored.id };
  }

  async latestForecast(user: AuthenticatedUser, productId: string) {
    const forecast = await this.prisma.forecast.findFirst({
      where: { productId, ...companyFilter(user) },
      orderBy: { generatedAt: 'desc' },
      include: { product: { select: { sku: true, name: true } } },
    });
    if (!forecast) {
      throw new NotFoundException(
        'No forecast has been generated for this product yet. POST /ai/forecast/:productId first.',
      );
    }
    return forecast;
  }

  /* ------------------------------------------------------------- delay / ETA */

  /** Predicts the delay probability for a shipment and caches it on the row. */
  async predictShipmentDelay(user: AuthenticatedUser, shipmentId: string) {
    const companyId = requireCompanyId(user);
    const shipment = await this.prisma.shipment.findFirst({
      where: { id: shipmentId, companyId },
      include: {
        carrier: true,
        vehicle: true,
        route: true,
        purchaseOrder: { include: { supplier: true } },
      },
    });
    if (!shipment) throw new NotFoundException('Shipment not found in your company');

    const recent = await this.prisma.gpsPosition.findMany({
      where: { shipmentId, speedKmh: { not: null } },
      orderBy: { recordedAt: 'desc' },
      take: 60,
      select: { speedKmh: true },
    });
    const moving = recent.filter((p) => (p.speedKmh ?? 0) > 3);
    const observedAverageSpeedKmh =
      moving.length > 0
        ? moving.reduce((sum, p) => sum + (p.speedKmh ?? 0), 0) / moving.length
        : null;

    const plannedDurationHours =
      (shipment.plannedArrivalAt.getTime() - shipment.plannedDepartureAt.getTime()) / 3_600_000;

    const departure = shipment.actualDepartureAt ?? shipment.plannedDepartureAt;
    const weatherSeverity = await this.weatherSeverityForShipment(shipmentId);

    const response = await this.ai.post<DelayResponse>(
      '/predict-delay',
      {
        shipmentId,
        distanceKm: shipment.plannedDistanceKm,
        plannedDurationHours: Math.max(plannedDurationHours, 0),
        departureHour: departure.getHours(),
        departureDayOfWeek: departure.getDay(),
        vehicleType: shipment.vehicle?.type ?? 'TRUCK_MEDIUM',
        carrierOnTimeRate: shipment.carrier?.onTimeRate ?? 0.85,
        carrierAverageDelayHours: shipment.carrier?.averageDelayHours ?? 0,
        supplierReliabilityScore: shipment.purchaseOrder?.supplier?.reliabilityScore ?? null,
        weatherSeverity,
        // No traffic provider feeds the model yet; congestion stays neutral and the AI service's
        // explanation says so rather than inventing conditions.
        trafficCongestion: 0,
        routeIncidentRate: shipment.route?.incidentRate ?? 0,
        observedAverageSpeedKmh,
        stopsCount: null,
      },
      { record: { companyId, task: 'DELAY', subjectType: 'SHIPMENT', subjectId: shipmentId } },
    );

    await this.prisma.shipment.update({
      where: { id: shipmentId },
      data: { delayProbability: response.delayProbability, delayRisk: response.risk },
    });

    return response;
  }

  /**
   * Open-Meteo severity (0..1) where the shipment last reported. Falls back to 0 — the model's
   * "no adverse weather" — when there is no GPS fix yet or the weather service is down: a free
   * upstream being unavailable must never block a delay prediction. The fallback is therefore
   * optimistic, which is why it is only a fallback.
   */
  private async weatherSeverityForShipment(shipmentId: string): Promise<number> {
    const lastFix = await this.prisma.gpsPosition.findFirst({
      where: { shipmentId },
      orderBy: { recordedAt: 'desc' },
      select: { latitude: true, longitude: true },
    });
    if (!lastFix) return 0;
    return (await this.hazards.weatherSeverityAt(lastFix.latitude, lastFix.longitude)) ?? 0;
  }

  /** Refreshes the delay probability for every shipment currently on the road. */
  async predictAllActiveDelays(user: AuthenticatedUser) {
    const companyId = requireCompanyId(user);
    const shipments = await this.prisma.shipment.findMany({
      where: { companyId, status: { in: ['DEPARTED', 'IN_TRANSIT', 'DELAYED'] } },
      select: { id: true },
    });

    let updated = 0;
    let failed = 0;
    for (const { id } of shipments) {
      try {
        await this.predictShipmentDelay(user, id);
        updated += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(`Delay prediction failed for ${id}: ${error}`);
      }
    }
    return { shipments: shipments.length, updated, failed };
  }

  /* ---------------------------------------------------------------- anomaly */

  /** Runs anomaly detection over a shipment's track and persists anything new. */
  async detectShipmentAnomalies(user: AuthenticatedUser, shipmentId: string) {
    const companyId = requireCompanyId(user);
    const shipment = await this.prisma.shipment.findFirst({
      where: { id: shipmentId, companyId },
      include: { route: true },
    });
    if (!shipment) throw new NotFoundException('Shipment not found in your company');

    const positions = await this.prisma.gpsPosition.findMany({
      where: { shipmentId },
      orderBy: { recordedAt: 'asc' },
      select: {
        latitude: true,
        longitude: true,
        speedKmh: true,
        headingDegrees: true,
        recordedAt: true,
      },
      take: 5000,
    });

    if (positions.length < 2) {
      return {
        shipmentId,
        anomalies: [],
        positionsAnalysed: positions.length,
        explanation: {
          summary: 'Not enough telemetry to analyse.',
          reasons: ['Fewer than two position fixes have been recorded for this shipment.'],
          assumptions: [],
        },
      };
    }

    const proof = await this.prisma.proofOfDelivery.findFirst({
      where: { delivery: { shipmentId } },
      select: { latitude: true, longitude: true },
    });

    const plannedDurationHours =
      (shipment.plannedArrivalAt.getTime() - shipment.plannedDepartureAt.getTime()) / 3_600_000;

    const response = await this.ai.post<AnomalyResponse>(
      '/detect-anomaly',
      {
        shipmentId,
        positions: positions.map((p) => ({
          latitude: p.latitude,
          longitude: p.longitude,
          speedKmh: p.speedKmh,
          headingDegrees: p.headingDegrees,
          recordedAt: p.recordedAt.toISOString(),
        })),
        plannedRoute: shipment.route
          ? (shipment.route.polyline as unknown as LatLng[])
          : null,
        plannedDurationHours: Math.max(plannedDurationHours, 0),
        corridorToleranceMeters: shipment.route?.corridorToleranceM ?? 2000,
        declaredDestination: {
          latitude: shipment.destinationLatitude,
          longitude: shipment.destinationLongitude,
        },
        deliveryPoint:
          proof?.latitude != null && proof?.longitude != null
            ? { latitude: proof.latitude, longitude: proof.longitude }
            : null,
      },
      { record: { companyId, task: 'ANOMALY', subjectType: 'SHIPMENT', subjectId: shipmentId } },
    );

    const persisted = await this.persistAnomalies(shipment.id, shipment.isDemoData, response);
    return { ...response, persisted };
  }

  /**
   * Stores anomalies, skipping any of the same type that is already open.
   *
   * Re-running detection on a growing track re-reports the same stop or deviation every time.
   * Deduplicating on (shipment, type, unresolved) is what keeps the anomaly list readable
   * instead of turning into a log.
   */
  private async persistAnomalies(
    shipmentId: string,
    isDemoData: boolean,
    response: AnomalyResponse,
  ): Promise<number> {
    if (response.anomalies.length === 0) {
      await this.prisma.shipment.update({
        where: { id: shipmentId },
        data: { hasOpenAnomaly: false },
      });
      return 0;
    }

    const open = await this.prisma.anomaly.findMany({
      where: { shipmentId, resolvedAt: null },
      select: { type: true },
    });
    const alreadyOpen = new Set(open.map((a) => a.type));

    let created = 0;
    for (const anomaly of response.anomalies) {
      if (alreadyOpen.has(anomaly.type as never)) continue;

      await this.prisma.anomaly.create({
        data: {
          shipmentId,
          type: anomaly.type as never,
          severity: anomaly.severity,
          score: anomaly.score,
          description: anomaly.description,
          latitude: anomaly.location?.latitude ?? null,
          longitude: anomaly.location?.longitude ?? null,
          evidence: anomaly.evidence as unknown as Prisma.InputJsonValue,
          detectedAt: new Date(anomaly.detectedAt),
          isDemoData,
        },
      });
      created += 1;
    }

    if (created > 0) {
      await this.prisma.$transaction(async (tx) => {
        const shipment = await tx.shipment.update({
          where: { id: shipmentId },
          data: { hasOpenAnomaly: true },
        });
        await tx.shipmentEvent.create({
          data: {
            shipmentId,
            type: 'ANOMALY_DETECTED',
            description: `${created} anomaly(ies) detected: ${response.anomalies
              .slice(0, 3)
              .map((a) => a.type)
              .join(', ')}`,
            metadata: { anomalies: response.anomalies } as Prisma.InputJsonValue,
            isDemoData,
          },
        });
        await this.events.publish(tx, {
          companyId: shipment.companyId,
          type: DOMAIN_EVENTS.SHIPMENT_ANOMALY,
          subjectType: 'SHIPMENT',
          subjectId: shipmentId,
          payload: {
            trackingNumber: shipment.trackingNumber,
            types: response.anomalies.map((a) => a.type),
          },
        });
      });
    }

    return created;
  }

  /* ------------------------------------------------------- optimisation ---- */

  /** Allocates a quantity across the suppliers that actually carry the product. */
  async allocate(
    user: AuthenticatedUser,
    input: {
      productId: string;
      quantity: number;
      budget?: number;
      requiredWithinDays?: number;
      maxSupplierSharePercent?: number;
    },
  ) {
    const companyId = requireCompanyId(user);
    const product = await this.prisma.product.findFirst({
      where: { id: input.productId, companyId },
    });
    if (!product) throw new NotFoundException('Product not found in your company');

    const offers = await this.prisma.supplierProduct.findMany({
      where: { productId: input.productId, validUntil: null, supplier: { isActive: true } },
      include: { supplier: true },
    });

    if (offers.length === 0) {
      throw new BadRequestException(
        `No active supplier carries ${product.sku}. Add a supplier price list before allocating.`,
      );
    }

    const warehouse = await this.prisma.warehouse.findFirst({
      where: { companyId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });

    const response = await this.ai.post<AllocationResponse>(
      '/supplier/allocation',
      {
        productId: input.productId,
        demandQuantity: input.quantity,
        suppliers: offers.map((offer) => ({
          supplierId: offer.supplierId,
          name: offer.supplier.name,
          unitPrice: Number(offer.unitPrice),
          leadTimeDays: offer.leadTimeDays,
          leadTimeStdDevDays: offer.supplier.observedLeadTimeStdDays,
          onTimeDeliveryRate: offer.supplier.onTimeDeliveryRate,
          qualityAcceptanceRate: offer.supplier.qualityAcceptanceRate,
          fillRate: offer.supplier.fillRate,
          minimumOrderQuantity: Number(offer.minimumOrderQuantity),
          capacityUnits: Number(offer.capacityPerCycle),
          cancellationRate: offer.supplier.cancellationRate,
          distanceKm: distanceBetween(offer.supplier, warehouse),
        })),
        budget: input.budget ?? null,
        requiredWithinDays: input.requiredWithinDays ?? null,
        maxSupplierSharePercent: input.maxSupplierSharePercent ?? null,
      },
      {
        record: {
          companyId,
          task: 'ALLOCATION',
          subjectType: 'PRODUCT',
          subjectId: input.productId,
        },
      },
    );

    await this.prisma.optimizationRun.create({
      data: {
        companyId,
        kind: 'SUPPLIER_ALLOCATION',
        status: response.status,
        input: input as unknown as Prisma.InputJsonValue,
        output: response as unknown as Prisma.InputJsonValue,
        objectiveValue: response.objectiveValue ?? null,
        constraints: response.constraints ?? [],
        assumptions: response.explanation?.assumptions ?? [],
        solverName: 'OR-Tools CBC',
        solverWallTimeMs: response.solverWallTimeMs ?? null,
        triggeredById: user.id,
        isDemoData: product.isDemoData,
      },
    });

    return response;
  }

  /** Plans routes for a set of customers from a warehouse using the company's own fleet. */
  async optimizeRoutes(
    user: AuthenticatedUser,
    input: {
      warehouseId: string;
      customerIds: string[];
      vehicleIds?: string[];
      demandPerCustomer?: Record<string, number>;
      fuelPricePerLiter?: number;
    },
  ) {
    const companyId = requireCompanyId(user);

    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id: input.warehouseId, companyId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found in your company');

    const customers = await this.prisma.customer.findMany({
      where: { id: { in: input.customerIds }, companyId, isActive: true },
    });
    const located = customers.filter((c) => c.latitude !== null && c.longitude !== null);

    if (located.length === 0) {
      throw new BadRequestException(
        'None of the selected customers has coordinates. Set them before planning routes.',
      );
    }
    if (located.length < customers.length) {
      this.logger.warn(
        `${customers.length - located.length} customer(s) skipped: no coordinates recorded`,
      );
    }

    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        companyId,
        ...(input.vehicleIds?.length ? { id: { in: input.vehicleIds } } : { status: 'AVAILABLE' }),
      },
    });
    if (vehicles.length === 0) {
      throw new BadRequestException('No vehicle is available for routing');
    }

    const response = await this.ai.post<RouteResponse>(
      '/route/optimize',
      {
        depot: { latitude: warehouse.latitude, longitude: warehouse.longitude },
        depotName: warehouse.name,
        stops: located.map((customer) => ({
          id: customer.id,
          name: customer.name,
          location: { latitude: customer.latitude!, longitude: customer.longitude! },
          demandUnits: input.demandPerCustomer?.[customer.id] ?? 100,
          serviceMinutes: 15,
          windowStartMinutes: customer.windowStartMinutes,
          windowEndMinutes: customer.windowEndMinutes,
        })),
        vehicles: vehicles.map((vehicle) => ({
          id: vehicle.id,
          name: vehicle.label ?? vehicle.plateNumber,
          capacityUnits: Number(vehicle.capacityUnits),
          costPerKm: Number(vehicle.costPerKm),
          fuelConsumptionLPer100km: vehicle.fuelConsumptionLPer100Km,
          averageSpeedKmh: vehicle.nominalSpeedKmh,
        })),
        fuelPricePerLiter: input.fuelPricePerLiter ?? 1.35,
      },
      { record: { companyId, task: 'ROUTE', subjectType: 'WAREHOUSE', subjectId: warehouse.id } },
    );

    await this.prisma.optimizationRun.create({
      data: {
        companyId,
        kind: 'ROUTE_VRP',
        status: response.status,
        input: input as unknown as Prisma.InputJsonValue,
        output: response as unknown as Prisma.InputJsonValue,
        objectiveValue: response.objectiveValue ?? null,
        constraints: response.constraints ?? [],
        assumptions: response.explanation?.assumptions ?? [],
        solverName: 'OR-Tools routing (guided local search)',
        solverWallTimeMs: response.solverWallTimeMs ?? null,
        triggeredById: user.id,
        isDemoData: warehouse.isDemoData,
      },
    });

    return response;
  }

  /* ------------------------------------------------------ risk & advice ---- */

  /** Builds the whole-company snapshot the risk and recommendation engines consume. */
  private async companySnapshot(companyId: string) {
    const [inventories, suppliers, shipments] = await Promise.all([
      this.prisma.inventory.findMany({
        where: { companyId },
        include: { product: true, warehouse: { select: { id: true } } },
      }),
      this.prisma.supplier.findMany({
        where: { companyId, isActive: true },
        include: { products: { where: { validUntil: null } } },
      }),
      this.prisma.shipment.findMany({
        where: { companyId, status: { in: ['DEPARTED', 'IN_TRANSIT', 'DELAYED'] } },
        include: { items: { select: { productId: true } } },
      }),
    ]);

    // Demand statistics come from the movement ledger: mean and standard deviation of daily
    // outbound quantity over the last 90 days. Using the ledger rather than a stored field means
    // the numbers cannot drift out of step with what actually happened.
    const demandStats = await this.prisma.$queryRaw<
      Array<{ productId: string; mean_daily: number | null; std_daily: number | null }>
    >`
      WITH daily AS (
        SELECT "productId", DATE("occurredAt") AS day, SUM(quantity) AS qty
          FROM "inventory_movements"
         WHERE "companyId" = ${companyId}
           AND type = 'OUT'
           AND "occurredAt" >= NOW() - INTERVAL '90 days'
         GROUP BY "productId", DATE("occurredAt")
      )
      SELECT "productId",
             AVG(qty)::double precision        AS mean_daily,
             STDDEV_SAMP(qty)::double precision AS std_daily
        FROM daily
       GROUP BY "productId"
    `;
    const statsByProduct = new Map(
      demandStats.map((row) => [
        row.productId,
        { mean: Number(row.mean_daily ?? 0), std: Number(row.std_daily ?? 0) },
      ]),
    );

    const totalSpend = suppliers.reduce(
      (sum, supplier) =>
        sum +
        supplier.products.reduce(
          (inner, offer) => inner + Number(offer.unitPrice) * Number(offer.capacityPerCycle),
          0,
        ),
      0,
    );

    /**
     * One entry per *product*, not per inventory row.
     *
     * `inventory` is keyed by (product, warehouse), so a SKU stocked in three DCs produced three
     * rows — and the recommendation engine, which keys on productId, emitted three near-identical
     * "order SKU-010" recommendations that differed only by rounding. Stock is network-wide for
     * the ordering decision, so it is summed here, and the warehouse holding the largest share
     * becomes the receiving location on the resulting purchase order.
     */
    const byProduct = new Map<
      string,
      {
        productId: string;
        sku: string;
        currentStock: number;
        reservedStock: number;
        incomingQuantity: number;
        unitCost: number;
        serviceLevel: number;
        warehouseId: string;
        largestShare: number;
      }
    >();

    for (const row of inventories) {
      const available = Number(row.availableStock);
      const existing = byProduct.get(row.productId);

      if (!existing) {
        byProduct.set(row.productId, {
          productId: row.productId,
          sku: row.product.sku,
          currentStock: available,
          reservedStock: Number(row.reservedStock),
          incomingQuantity: Number(row.incomingStock),
          unitCost: Number(row.product.unitCost),
          serviceLevel: row.product.serviceLevel,
          warehouseId: row.warehouseId,
          largestShare: available,
        });
        continue;
      }

      existing.currentStock += available;
      existing.reservedStock += Number(row.reservedStock);
      existing.incomingQuantity += Number(row.incomingStock);
      if (available > existing.largestShare) {
        existing.largestShare = available;
        existing.warehouseId = row.warehouseId;
      }
    }

    const products = [...byProduct.values()].map((entry) => {
      const stats = statsByProduct.get(entry.productId);
      const leadTimes = suppliers
        .filter((s) => s.products.some((p) => p.productId === entry.productId))
        .map((s) => s.observedLeadTimeDays);
      const leadTimeStds = suppliers
        .filter((s) => s.products.some((p) => p.productId === entry.productId))
        .map((s) => s.observedLeadTimeStdDays);

      // The fastest supplier defines the achievable lead time, and its own variability is what
      // the buffer has to absorb — taking the minimum lead time with zero variance would
      // understate safety stock for exactly the products that need it most.
      const fastestIndex =
        leadTimes.length > 0 ? leadTimes.indexOf(Math.min(...leadTimes)) : -1;

      return {
        productId: entry.productId,
        sku: entry.sku,
        currentStock: entry.currentStock,
        reservedStock: entry.reservedStock,
        averageDailyDemand: stats?.mean ?? 0,
        demandStdDev: stats?.std ?? 0,
        leadTimeDays: fastestIndex >= 0 ? leadTimes[fastestIndex] : 7,
        leadTimeStdDevDays: fastestIndex >= 0 ? leadTimeStds[fastestIndex] : 0,
        incomingQuantity: entry.incomingQuantity,
        incomingArrivalDays: null,
        unitCost: entry.unitCost,
        serviceLevel: entry.serviceLevel,
        warehouseId: entry.warehouseId,
        orderingCost: null,
      };
    });

    return {
      products,
      suppliers: suppliers.map((supplier) => {
        const spend = supplier.products.reduce(
          (sum, offer) => sum + Number(offer.unitPrice) * Number(offer.capacityPerCycle),
          0,
        );
        const cheapest = supplier.products.reduce<number | null>(
          (min, offer) =>
            min === null ? Number(offer.unitPrice) : Math.min(min, Number(offer.unitPrice)),
          null,
        );

        return {
          supplierId: supplier.id,
          name: supplier.name,
          onTimeDeliveryRate: supplier.onTimeDeliveryRate,
          qualityAcceptanceRate: supplier.qualityAcceptanceRate,
          sharePercent: totalSpend > 0 ? spend / totalSpend : 0,
          country: supplier.country,
          leadTimeStdDevDays: supplier.observedLeadTimeStdDays,
          unitPrice: cheapest,
          leadTimeDays: supplier.observedLeadTimeDays,
          capacityUnits: supplier.products.reduce(
            (sum, offer) => sum + Number(offer.capacityPerCycle),
            0,
          ),
          minimumOrderQuantity: supplier.products.reduce(
            (max, offer) => Math.max(max, Number(offer.minimumOrderQuantity)),
            0,
          ),
          distanceKm: null,
          productIds: supplier.products.map((offer) => offer.productId),
        };
      }),
      shipments: shipments.map((shipment) => ({
        shipmentId: shipment.id,
        trackingNumber: shipment.trackingNumber,
        delayProbability: shipment.delayProbability ?? 0,
        valueAtRisk: Number(shipment.cargoValue),
        status: shipment.status,
        productIds: shipment.items.map((item) => item.productId),
      })),
    };
  }

  async analyseRisk(user: AuthenticatedUser) {
    const companyId = requireCompanyId(user);
    const [snapshot, hazards] = await Promise.all([
      this.companySnapshot(companyId),
      this.hazardExposuresForRisk(companyId),
    ]);

    const response = await this.ai.post<RiskResponse>(
      '/risk/analyze',
      { companyId, ...snapshot, hazards },
      { record: { companyId, task: 'RISK', subjectType: 'COMPANY', subjectId: companyId } },
    );

    // Replace the previous snapshot: risk is a current picture, not a log.
    await this.prisma.$transaction([
      this.prisma.risk.deleteMany({ where: { companyId, resolvedAt: null } }),
      this.prisma.risk.createMany({
        data: response.findings.map((finding) => ({
          companyId,
          category: finding.category as never,
          subjectType: finding.subjectType,
          subjectId: finding.subjectId,
          subjectLabel: finding.subject,
          probability: finding.probability,
          impact: finding.impact,
          score: finding.score,
          level: finding.level,
          recommendedAction: finding.recommendedAction,
          explanation: finding.explanation as unknown as Prisma.InputJsonValue,
        })),
      }),
    ]);

    return response;
  }

  /**
   * Live natural-hazard exposure of the company's sites and shipments, in the shape the risk
   * engine reads. `undefined` (the field is then omitted) when no hazard feed answered: an empty
   * list would tell the engine "feeds checked, nothing nearby", which is a different claim from
   * "feeds unreachable", and its assumptions text distinguishes the two.
   */
  private async hazardExposuresForRisk(companyId: string) {
    try {
      const { exposures, sources } = await this.hazards.companyExposure(companyId);
      const anyFeedAnswered = sources.some((s) => s.status === 'OK' || s.status === 'STALE');
      if (!anyFeedAnswered) return undefined;
      return exposures.slice(0, 200).map((exposure) => ({
        hazardId: exposure.hazardId,
        kind: exposure.hazardKind,
        title: exposure.hazardTitle,
        severity: exposure.severity,
        subjectType: exposure.subjectType,
        subjectId: exposure.subjectId,
        subjectLabel: exposure.subjectLabel,
        distanceKm: exposure.distanceKm,
      }));
    } catch (error) {
      this.logger.warn(`Hazard exposure unavailable for risk analysis: ${error}`);
      return undefined;
    }
  }

  async generateRecommendations(user: AuthenticatedUser) {
    const companyId = requireCompanyId(user);
    const snapshot = await this.companySnapshot(companyId);

    const response = await this.ai.post<RecommendationsResponse>(
      '/recommendations/generate',
      { companyId, ...snapshot },
      {
        record: {
          companyId,
          task: 'RECOMMENDATIONS',
          subjectType: 'COMPANY',
          subjectId: companyId,
        },
      },
    );

    let created = 0;
    for (const recommendation of response.recommendations) {
      // Supersede rather than duplicate: an open recommendation of the same type for the same
      // subject is replaced, so the list stays a to-do list and not a history.
      const existing = await this.prisma.recommendation.findFirst({
        where: {
          companyId,
          type: recommendation.type as never,
          subjectType: recommendation.subjectType,
          subjectId: recommendation.subjectId,
          status: 'OPEN',
        },
      });

      const data = {
        companyId,
        type: recommendation.type as never,
        priority: recommendation.priority,
        title: recommendation.title,
        subjectType: recommendation.subjectType,
        subjectId: recommendation.subjectId,
        payload: recommendation.payload as unknown as Prisma.InputJsonValue,
        explanation: recommendation.explanation as unknown as Prisma.InputJsonValue,
        estimatedCostDelta: recommendation.estimatedImpact?.costDelta ?? null,
        estimatedRiskDelta: recommendation.estimatedImpact?.riskDelta ?? null,
        estimatedServiceLevelDelta: recommendation.estimatedImpact?.serviceLevelDelta ?? null,
        expiresAt: recommendation.expiresAt ? new Date(recommendation.expiresAt) : null,
      };

      if (existing) {
        await this.prisma.recommendation.update({ where: { id: existing.id }, data });
      } else {
        await this.prisma.recommendation.create({ data });
        created += 1;
      }
    }

    return { ...response, newRecommendations: created };
  }

  /* -------------------------------------------------------------- scenario */

  async simulateScenario(
    user: AuthenticatedUser,
    input: {
      productId: string;
      horizonDays?: number;
      levers?: Record<string, number>;
      iterations?: number;
      name?: string;
    },
  ) {
    const companyId = requireCompanyId(user);
    const product = await this.prisma.product.findFirst({
      where: { id: input.productId, companyId },
    });
    if (!product) throw new NotFoundException('Product not found in your company');

    const snapshot = await this.companySnapshot(companyId);
    const productSnapshot = snapshot.products.find((p) => p.productId === input.productId);
    if (!productSnapshot) {
      throw new BadRequestException(
        `${product.sku} has no inventory record, so there is nothing to simulate.`,
      );
    }
    if (productSnapshot.averageDailyDemand <= 0) {
      throw new BadRequestException(
        `${product.sku} has no outbound movement in the last 90 days; a simulation would model nothing.`,
      );
    }

    const response = await this.ai.post<ScenarioResponse>(
      '/scenario/simulate',
      {
        productId: input.productId,
        sku: product.sku,
        horizonDays: input.horizonDays ?? 90,
        baseline: {
          averageDailyDemand: productSnapshot.averageDailyDemand,
          demandStdDev: productSnapshot.demandStdDev,
          currentStock: productSnapshot.currentStock,
          unitCost: productSnapshot.unitCost,
          leadTimeDays: productSnapshot.leadTimeDays,
          leadTimeStdDevDays: productSnapshot.leadTimeStdDevDays,
          holdingCostPerUnitPerDay: (productSnapshot.unitCost * 0.25) / 365,
          stockoutPenaltyPerUnit: productSnapshot.unitCost * 2,
          transportCostPerOrder: 500,
          orderingCost: 250,
          serviceLevel: productSnapshot.serviceLevel,
        },
        levers: input.levers ?? {},
        iterations: input.iterations ?? 2000,
      },
      { record: { companyId, task: 'SCENARIO', subjectType: 'PRODUCT', subjectId: input.productId } },
    );

    const scenario = await this.prisma.scenario.create({
      data: {
        companyId,
        name: input.name ?? `${product.sku} — ${new Date().toISOString().slice(0, 10)}`,
        productId: input.productId,
        levers: (input.levers ?? {}) as Prisma.InputJsonValue,
        results: response.cases as unknown as Prisma.InputJsonValue,
        iterations: response.iterations,
        isDemoData: product.isDemoData,
      },
    });

    return { ...response, scenarioId: scenario.id };
  }
}

/* ------------------------------------------------------------------ helpers */

function distanceBetween(
  supplier: { latitude: number | null; longitude: number | null },
  warehouse: { latitude: number; longitude: number } | null,
): number | null {
  if (!warehouse || supplier.latitude === null || supplier.longitude === null) return null;
  return Math.round(
    haversineKm(
      { latitude: supplier.latitude, longitude: supplier.longitude },
      { latitude: warehouse.latitude, longitude: warehouse.longitude },
    ),
  );
}

function pickMetric(response: ForecastResponse, metric: 'mae' | 'rmse' | 'wape'): number {
  const selected = response.evaluations?.find((e) => e.selected);
  return selected?.[metric] ?? 0;
}

function pickMetricNullable(response: ForecastResponse, metric: 'mape'): number | null {
  const selected = response.evaluations?.find((e) => e.selected);
  return selected?.[metric] ?? null;
}

/* ------------------------------------------------- AI service response shapes */

interface ExplanationShape {
  summary: string;
  reasons: string[];
  assumptions: string[];
}

interface ForecastResponse {
  forecast: Array<{ date: string; demand: number; lowerBound: number; upperBound: number }>;
  selectedModel: string;
  evaluations: Array<{
    model: string;
    mae: number | null;
    rmse: number | null;
    mape: number | null;
    wape: number | null;
    selected: boolean;
  }>;
  residualStd: number | null;
  dataQuality: unknown;
  explanation: ExplanationShape;
}

interface DelayResponse {
  delayProbability: number;
  risk: string;
  expectedDelayHours: number;
  explanation: ExplanationShape;
}

interface AnomalyResponse {
  shipmentId: string;
  anomalies: Array<{
    type: string;
    severity: string;
    score: number;
    detectedAt: string;
    location: { latitude: number; longitude: number } | null;
    description: string;
    evidence: Record<string, unknown>;
  }>;
  positionsAnalysed: number;
  explanation: ExplanationShape;
}

interface AllocationResponse {
  status: string;
  lines: Array<{ supplierId: string; name: string; quantity: number; unitPrice: number }>;
  objectiveValue: number | null;
  constraints: string[];
  solverWallTimeMs: number;
  explanation: ExplanationShape;
}

interface RouteResponse {
  status: string;
  routes: unknown[];
  objectiveValue: number | null;
  constraints: string[];
  solverWallTimeMs: number;
  explanation: ExplanationShape;
}

interface RiskResponse {
  findings: Array<{
    category: string;
    probability: number;
    impact: number;
    score: number;
    level: string;
    subject: string;
    subjectType: string;
    subjectId: string;
    recommendedAction: string;
    explanation: ExplanationShape;
  }>;
  supplyChainHealthScore: number;
  healthBreakdown: Record<string, number>;
  explanation: ExplanationShape;
}

interface RecommendationsResponse {
  recommendations: Array<{
    type: string;
    priority: string;
    title: string;
    subjectType: string;
    subjectId: string;
    payload: Record<string, unknown>;
    estimatedImpact: {
      costDelta: number | null;
      riskDelta: number | null;
      serviceLevelDelta: number | null;
    };
    explanation: ExplanationShape;
    expiresAt: string | null;
  }>;
  explanation: ExplanationShape;
}

interface ScenarioResponse {
  cases: unknown[];
  iterations: number;
  explanation: ExplanationShape;
}
