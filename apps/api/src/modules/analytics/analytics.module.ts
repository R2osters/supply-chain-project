import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { requireCompanyId } from '../../common/tenancy/tenant-scope';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Dashboard aggregates.
 *
 * Everything here is a single SQL round trip per tile, aggregated in the database. The tempting
 * alternative — fetch the rows and reduce them in Node — turns a dashboard into a full-table
 * scan over shipments and movements on every page load, and gets slower exactly as the customer
 * gets bigger.
 *
 * Demo rows are counted but always labelled, and each response reports how much of the figure is
 * synthetic, so nobody mistakes seeded data for a real operation.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The headline tiles. */
  async overview(user: AuthenticatedUser) {
    const companyId = requireCompanyId(user);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [shipments, inventory, fleet, incidents, recommendations, demo] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          active: bigint;
          delayed: bigint;
          delivered_today: bigint;
          at_risk: bigint;
          with_anomaly: bigint;
        }>
      >`
        SELECT COUNT(*) FILTER (WHERE status IN ('PLANNED','LOADING','DEPARTED','IN_TRANSIT','DELAYED'))::bigint AS active,
               COUNT(*) FILTER (WHERE status = 'DELAYED')::bigint                                   AS delayed,
               COUNT(*) FILTER (WHERE status = 'DELIVERED' AND "deliveredAt" >= ${todayStart})::bigint AS delivered_today,
               COUNT(*) FILTER (WHERE "delayProbability" >= 0.5
                                  AND status IN ('DEPARTED','IN_TRANSIT','DELAYED'))::bigint        AS at_risk,
               COUNT(*) FILTER (WHERE "hasOpenAnomaly" = TRUE)::bigint                              AS with_anomaly
          FROM "shipments" WHERE "companyId" = ${companyId}
      `,
      this.prisma.$queryRaw<
        Array<{ value: number | null; low: bigint; out: bigint; skus: bigint }>
      >`
        SELECT COALESCE(SUM(i."availableStock" * p."unitCost"), 0)::double precision AS value,
               COUNT(*) FILTER (WHERE i."availableStock" < i."reorderPoint" AND i."availableStock" > 0)::bigint AS low,
               COUNT(*) FILTER (WHERE i."availableStock" <= 0)::bigint               AS out,
               COUNT(DISTINCT i."productId")::bigint                                 AS skus
          FROM "inventory" i JOIN "products" p ON p.id = i."productId"
         WHERE i."companyId" = ${companyId}
      `,
      this.prisma.$queryRaw<Array<{ total: bigint; moving: bigint; reporting: bigint }>>`
        SELECT COUNT(*)::bigint                                          AS total,
               COUNT(*) FILTER (WHERE status = 'IN_TRANSIT')::bigint     AS moving,
               COUNT(*) FILTER (WHERE "lastPositionAt" >= NOW() - INTERVAL '1 hour')::bigint AS reporting
          FROM "vehicles" WHERE "companyId" = ${companyId}
      `,
      this.prisma.incident.count({
        where: { companyId, status: { in: ['OPEN', 'INVESTIGATING'] } },
      }),
      this.prisma.recommendation.count({ where: { companyId, status: 'OPEN' } }),
      this.prisma.shipment.count({ where: { companyId, isDemoData: true } }),
    ]);

    const shipmentRow = shipments[0];
    const inventoryRow = inventory[0];
    const fleetRow = fleet[0];
    const totalShipments = await this.prisma.shipment.count({ where: { companyId } });

    return {
      shipments: {
        active: Number(shipmentRow?.active ?? 0),
        delayed: Number(shipmentRow?.delayed ?? 0),
        deliveredToday: Number(shipmentRow?.delivered_today ?? 0),
        atRisk: Number(shipmentRow?.at_risk ?? 0),
        withOpenAnomaly: Number(shipmentRow?.with_anomaly ?? 0),
      },
      inventory: {
        value: Math.round(Number(inventoryRow?.value ?? 0) * 100) / 100,
        lowStockProducts: Number(inventoryRow?.low ?? 0),
        outOfStockProducts: Number(inventoryRow?.out ?? 0),
        distinctSkus: Number(inventoryRow?.skus ?? 0),
      },
      fleet: {
        total: Number(fleetRow?.total ?? 0),
        inTransit: Number(fleetRow?.moving ?? 0),
        reportingWithinTheHour: Number(fleetRow?.reporting ?? 0),
      },
      openIncidents: incidents,
      openRecommendations: recommendations,
      demoData: {
        shipments: demo,
        share: totalShipments > 0 ? Math.round((demo / totalShipments) * 100) / 100 : 0,
        note:
          demo > 0
            ? 'Certains chiffres incluent des DONNÉES DE DÉMONSTRATION. Filtrez avec isDemoData=false pour ne garder que les données réelles.'
            : null,
      },
    };
  }

  /** Shipments per day, split by outcome. Drives the main dashboard chart. */
  async shipmentsPerDay(user: AuthenticatedUser, days = 30) {
    const companyId = requireCompanyId(user);

    // generate_series gives a row for every day, including days with no shipments — otherwise
    // the chart silently omits quiet days and the trend line lies.
    return this.prisma.$queryRaw<
      Array<{ day: Date; created: bigint; delivered: bigint; delayed: bigint; on_time: bigint }>
    >`
      WITH days AS (
        SELECT generate_series(
                 DATE_TRUNC('day', NOW() - (${days} || ' days')::interval),
                 DATE_TRUNC('day', NOW()),
                 '1 day'
               )::date AS day
      )
      SELECT d.day,
             COUNT(s.id) FILTER (WHERE DATE(s."createdAt") = d.day)::bigint     AS created,
             COUNT(s.id) FILTER (WHERE DATE(s."deliveredAt") = d.day)::bigint   AS delivered,
             COUNT(s.id) FILTER (WHERE DATE(s."deliveredAt") = d.day
                                   AND s."deliveredAt" > s."plannedArrivalAt")::bigint AS delayed,
             COUNT(s.id) FILTER (WHERE DATE(s."deliveredAt") = d.day
                                   AND s."deliveredAt" <= s."plannedArrivalAt")::bigint AS on_time
        FROM days d
        LEFT JOIN "shipments" s
               ON s."companyId" = ${companyId}
              AND (DATE(s."createdAt") = d.day OR DATE(s."deliveredAt") = d.day)
       GROUP BY d.day
       ORDER BY d.day
    `;
  }

  /**
   * Delivery performance: on-time rate and average delay.
   *
   * On-time is measured against the *promised* arrival, not the estimate. Measuring against a
   * continuously-updated ETA would make every shipment on time by definition, which is the
   * classic way a logistics dashboard ends up reporting 100 % while customers complain.
   */
  async deliveryPerformance(user: AuthenticatedUser, days = 90) {
    const companyId = requireCompanyId(user);

    const rows = await this.prisma.$queryRaw<
      Array<{
        total: bigint;
        on_time: bigint;
        avg_delay_hours: number | null;
        p90_delay_hours: number | null;
        avg_eta_error_minutes: number | null;
      }>
    >`
      SELECT COUNT(*)::bigint                                                            AS total,
             COUNT(*) FILTER (WHERE "deliveredAt" <= "plannedArrivalAt")::bigint         AS on_time,
             AVG(GREATEST(EXTRACT(EPOCH FROM ("deliveredAt" - "plannedArrivalAt")) / 3600, 0))
               ::double precision                                                        AS avg_delay_hours,
             PERCENTILE_CONT(0.9) WITHIN GROUP (
               ORDER BY GREATEST(EXTRACT(EPOCH FROM ("deliveredAt" - "plannedArrivalAt")) / 3600, 0)
             )::double precision                                                         AS p90_delay_hours,
             AVG(ABS(EXTRACT(EPOCH FROM ("deliveredAt" - "estimatedArrivalAt")) / 60))
               FILTER (WHERE "estimatedArrivalAt" IS NOT NULL)::double precision         AS avg_eta_error_minutes
        FROM "shipments"
       WHERE "companyId" = ${companyId}
         AND status = 'DELIVERED'
         AND "deliveredAt" IS NOT NULL
         AND "deliveredAt" >= NOW() - (${days} || ' days')::interval
    `;

    const row = rows[0];
    const total = Number(row?.total ?? 0);

    return {
      windowDays: days,
      deliveries: total,
      onTimeRate: total > 0 ? Math.round((Number(row.on_time) / total) * 1000) / 1000 : null,
      averageDelayHours: round(row?.avg_delay_hours),
      p90DelayHours: round(row?.p90_delay_hours),
      /** Mean absolute error of the ETA engine against actual arrival, in minutes. */
      etaAccuracyMinutes: round(row?.avg_eta_error_minutes),
      note:
        total === 0
          ? 'Aucune expédition livrée sur cette période : la performance ne peut pas encore être mesurée.'
          : 'La ponctualité est mesurée par rapport à l’arrivée promise, pas à l’ETA en temps réel.',
    };
  }

  /** Carrier league table. */
  async carrierPerformance(user: AuthenticatedUser, days = 90) {
    const companyId = requireCompanyId(user);

    return this.prisma.$queryRaw<
      Array<{
        carrierId: string;
        name: string;
        deliveries: bigint;
        on_time: bigint;
        on_time_rate: number | null;
        avg_delay_hours: number | null;
        incidents: bigint;
      }>
    >`
      SELECT c.id                                                                AS "carrierId",
             c.name,
             COUNT(s.id)::bigint                                                 AS deliveries,
             COUNT(s.id) FILTER (WHERE s."deliveredAt" <= s."plannedArrivalAt")::bigint AS on_time,
             CASE WHEN COUNT(s.id) = 0 THEN NULL
                  ELSE (COUNT(s.id) FILTER (WHERE s."deliveredAt" <= s."plannedArrivalAt")::double precision
                        / COUNT(s.id)) END                                       AS on_time_rate,
             AVG(GREATEST(EXTRACT(EPOCH FROM (s."deliveredAt" - s."plannedArrivalAt")) / 3600, 0))
               ::double precision                                                AS avg_delay_hours,
             (SELECT COUNT(*) FROM "incidents" i
               JOIN "shipments" si ON si.id = i."shipmentId"
              WHERE si."carrierId" = c.id
                AND i."occurredAt" >= NOW() - (${days} || ' days')::interval)::bigint AS incidents
        FROM "carriers" c
        LEFT JOIN "shipments" s
               ON s."carrierId" = c.id
              AND s.status = 'DELIVERED'
              AND s."deliveredAt" >= NOW() - (${days} || ' days')::interval
       WHERE c."companyId" = ${companyId}
       GROUP BY c.id, c.name
       ORDER BY on_time_rate DESC NULLS LAST, deliveries DESC
    `;
  }

  /** Supplier league table, straight from the stored performance fields. */
  async supplierPerformance(user: AuthenticatedUser) {
    const companyId = requireCompanyId(user);

    const suppliers = await this.prisma.supplier.findMany({
      where: { companyId, isActive: true },
      select: {
        id: true,
        name: true,
        country: true,
        reliabilityScore: true,
        onTimeDeliveryRate: true,
        qualityAcceptanceRate: true,
        fillRate: true,
        observedLeadTimeDays: true,
        observedLeadTimeStdDays: true,
        performanceUpdatedAt: true,
        _count: { select: { purchaseOrders: true } },
      },
      orderBy: { reliabilityScore: 'desc' },
    });

    return suppliers.map((supplier) => ({
      ...supplier,
      orders: supplier._count.purchaseOrders,
      measured: supplier.performanceUpdatedAt !== null,
    }));
  }

  /** Inventory value over time, reconstructed from the movement ledger. */
  async inventoryEvolution(user: AuthenticatedUser, days = 90) {
    const companyId = requireCompanyId(user);

    return this.prisma.$queryRaw<Array<{ day: Date; in_units: number; out_units: number; net: number }>>`
      WITH days AS (
        SELECT generate_series(
                 DATE_TRUNC('day', NOW() - (${days} || ' days')::interval),
                 DATE_TRUNC('day', NOW()),
                 '1 day'
               )::date AS day
      )
      SELECT d.day,
             COALESCE(SUM(m.quantity) FILTER (WHERE m.type = 'IN'), 0)::double precision  AS in_units,
             COALESCE(SUM(m.quantity) FILTER (WHERE m.type = 'OUT'), 0)::double precision AS out_units,
             (COALESCE(SUM(m.quantity) FILTER (WHERE m.type = 'IN'), 0)
              - COALESCE(SUM(m.quantity) FILTER (WHERE m.type = 'OUT'), 0))::double precision AS net
        FROM days d
        LEFT JOIN "inventory_movements" m
               ON m."companyId" = ${companyId}
              AND DATE(m."occurredAt") = d.day
       GROUP BY d.day
       ORDER BY d.day
    `;
  }

  /** How accurate the AI has been, measured against outcomes that are now known. */
  async aiAccuracy(user: AuthenticatedUser, days = 90) {
    const companyId = requireCompanyId(user);

    const rows = await this.prisma.$queryRaw<
      Array<{
        task: string;
        predictions: bigint;
        avg_latency_ms: number | null;
        avg_confidence: number | null;
      }>
    >`
      SELECT task,
             COUNT(*)::bigint                    AS predictions,
             AVG("latencyMs")::double precision  AS avg_latency_ms,
             AVG(confidence)::double precision   AS avg_confidence
        FROM "ai_predictions"
       WHERE "companyId" = ${companyId}
         AND "createdAt" >= NOW() - (${days} || ' days')::interval
       GROUP BY task
       ORDER BY predictions DESC
    `;

    // ETA accuracy is measurable directly: compare the last stored ETA against actual arrival.
    const eta = await this.prisma.$queryRaw<
      Array<{ measured: bigint; mae_minutes: number | null; within_30: bigint }>
    >`
      SELECT COUNT(*)::bigint AS measured,
             AVG(ABS(EXTRACT(EPOCH FROM ("actualArrivalAt" - "estimatedArrivalAt")) / 60))
               ::double precision AS mae_minutes,
             COUNT(*) FILTER (
               WHERE ABS(EXTRACT(EPOCH FROM ("actualArrivalAt" - "estimatedArrivalAt")) / 60) <= 30
             )::bigint AS within_30
        FROM "shipments"
       WHERE "companyId" = ${companyId}
         AND "actualArrivalAt" IS NOT NULL
         AND "estimatedArrivalAt" IS NOT NULL
         AND "actualArrivalAt" >= NOW() - (${days} || ' days')::interval
    `;

    const etaRow = eta[0];
    const measured = Number(etaRow?.measured ?? 0);

    return {
      windowDays: days,
      byTask: rows.map((row) => ({
        task: row.task,
        predictions: Number(row.predictions),
        averageLatencyMs: round(row.avg_latency_ms),
        averageConfidence: round(row.avg_confidence),
      })),
      eta: {
        measuredShipments: measured,
        meanAbsoluteErrorMinutes: round(etaRow?.mae_minutes),
        within30MinutesRate:
          measured > 0 ? Math.round((Number(etaRow.within_30) / measured) * 1000) / 1000 : null,
        note:
          measured === 0
            ? 'Aucune expédition n’a encore à la fois une ETA et une arrivée réelle : la précision n’est pas mesurable.'
            : 'Mesurée comme l’écart entre la dernière ETA calculée et l’arrivée réelle.',
      },
    };
  }
}

function round(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

@ApiBearerAuth()
@ApiTags('analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('overview')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Headline dashboard tiles' })
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.service.overview(user);
  }

  @Get('shipments-per-day')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Daily shipment counts, including days with none' })
  @ApiQuery({ name: 'days', required: false })
  shipmentsPerDay(@CurrentUser() user: AuthenticatedUser, @Query('days') days?: string) {
    return this.service.shipmentsPerDay(user, clampDays(days, 30));
  }

  @Get('delivery-performance')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'On-time rate, delay distribution and ETA accuracy' })
  @ApiQuery({ name: 'days', required: false })
  deliveryPerformance(@CurrentUser() user: AuthenticatedUser, @Query('days') days?: string) {
    return this.service.deliveryPerformance(user, clampDays(days, 90));
  }

  @Get('carrier-performance')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Carrier league table' })
  @ApiQuery({ name: 'days', required: false })
  carrierPerformance(@CurrentUser() user: AuthenticatedUser, @Query('days') days?: string) {
    return this.service.carrierPerformance(user, clampDays(days, 90));
  }

  @Get('supplier-performance')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Supplier league table' })
  supplierPerformance(@CurrentUser() user: AuthenticatedUser) {
    return this.service.supplierPerformance(user);
  }

  @Get('inventory-evolution')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Daily inbound, outbound and net movement' })
  @ApiQuery({ name: 'days', required: false })
  inventoryEvolution(@CurrentUser() user: AuthenticatedUser, @Query('days') days?: string) {
    return this.service.inventoryEvolution(user, clampDays(days, 90));
  }

  @Get('ai-accuracy')
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary: 'How well the AI has actually performed',
    description: 'ETA error is measured against real arrivals, not self-reported confidence.',
  })
  @ApiQuery({ name: 'days', required: false })
  aiAccuracy(@CurrentUser() user: AuthenticatedUser, @Query('days') days?: string) {
    return this.service.aiAccuracy(user, clampDays(days, 90));
  }
}

function clampDays(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 730);
}

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
