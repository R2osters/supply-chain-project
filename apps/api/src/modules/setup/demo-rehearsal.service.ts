import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type { Prisma, ShipmentStatus } from '@prisma/client';
import { polylineLengthMeters, type LatLng } from '@scip/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { TelemetrySimulatorService } from '../jobs/telemetry-simulator.service';
import { INCOMING_STOCK_STATUSES } from '../purchase-orders/purchase-order-status';
import { RECOMMENDATION_ORDER_NOTE } from '../recommendations/recommendations.service';
import { DEMO_ADMIN_EMAIL, SetupService } from './setup.service';

export interface RehearsalResult {
  /** Shipments sent back to their origin, leaving now. */
  shipments: number;
  /** Tracking numbers promised in five minutes: the ETA engine will find them late. */
  delayedSoon: string[];
  /** SKU-006 at the main warehouse is short again. */
  inventoryReset: boolean;
  /** Order numbers of recommendation orders cancelled so they no longer hide the shortage. */
  cancelledOrders: string[];
  clearedRecommendations: number;
}

/**
 * The seed's live shipments. 0041–0049 and 0054–0055 are on the road; 0050–0053 are PLANNED to
 * leave days from now and are filtered out by status, so a rehearsal never starts them early.
 */
export const STAGED_TRACKING_NUMBERS = Array.from(
  { length: 15 },
  (_, index) => `SHP-DEMO-${String(41 + index).padStart(4, '0')}`,
);
/** The two shipments whose promise cannot be kept: the demo's live delays. */
export const DELAYED_SOON = ['SHP-DEMO-0054', 'SHP-DEMO-0055'];
export const DELAYED_PROMISE_MS = 5 * 60_000;
/** The ETA engine's prior when a vehicle has no nominal speed. */
export const DEFAULT_SPEED_KMH = 60;

const STAGEABLE: ShipmentStatus[] = ['DEPARTED', 'IN_TRANSIT', 'DELAYED', 'ARRIVED'];
const IN_MOTION: ShipmentStatus[] = ['DEPARTED', 'IN_TRANSIT', 'DELAYED'];

/** The seed leaves this product short at the main warehouse so the advice has something to say. */
const SHORT_SKU = 'SKU-006';
const MAIN_WAREHOUSE = 'WH-ACC';
/** Two days of the seed's demand for SKU-006 (310 a day). */
const SHORT_SKU_STOCK = 620;

/** Why the ledger shows SKU-006 jumping back: read on the stock history, and by the e2e test. */
export const REHEARSAL_STOCK_REASON = 'Répétition de la démo : deux jours de demande en stock';
/** Why an order accepted in a previous rehearsal was cancelled. */
export const REHEARSAL_CANCELLATION_REASON = 'Répétition de la démo';

/** Length of the route the simulator and the ETA engine both follow, in km. */
export function stagedRouteKm(route: { polyline: unknown } | null, plannedDistanceKm: number): number {
  const polyline = route?.polyline;
  if (Array.isArray(polyline) && polyline.length >= 2) {
    return polylineLengthMeters(polyline as LatLng[]) / 1000;
  }
  return plannedDistanceKm;
}

/**
 * The promised arrival of a staged shipment. On-time trips are planned at the vehicle's nominal
 * speed, the very prior the ETA engine starts from: a flat 60 km/h would promise a 48 km/h truck
 * a quarter too early and the engine, right, would flag it late before it has moved.
 */
export function stagedArrival(
  now: Date,
  routeKm: number,
  nominalSpeedKmh: number | null | undefined,
  delayedSoon: boolean,
): Date {
  if (delayedSoon) return new Date(now.getTime() + DELAYED_PROMISE_MS);
  const speed = nominalSpeedKmh && nominalSpeedKmh > 0 ? nominalSpeedKmh : DEFAULT_SPEED_KMH;
  return new Date(now.getTime() + (routeKm / speed) * 3_600_000);
}

/**
 * One vehicle per staged shipment. The seed assigns vehicles round-robin, so 0054 and 0055 share
 * a truck with 0042 and 0043; the simulator would then move one marker along two routes and the
 * late truck the audience is told to watch would jump across the map. A shipment keeps its
 * vehicle unless an earlier one already took it; it then gets a spare, never one another staged
 * shipment still needs or one busy on another trip. With no spare left it keeps the shared one.
 */
export function assignVehicles(
  staged: ReadonlyArray<{ id: string; vehicleId: string | null }>,
  fleet: readonly string[],
  busy: ReadonlySet<string>,
): Map<string, string | null> {
  const plan = new Map<string, string | null>();
  const claimed = new Set<string>();
  const wanted = new Set(staged.map((shipment) => shipment.vehicleId).filter((id): id is string => !!id));
  const free = (id: string) => !busy.has(id) && !claimed.has(id);

  for (const shipment of staged) {
    const current = shipment.vehicleId;
    const chosen =
      current && free(current)
        ? current
        : (fleet.find((id) => free(id) && !wanted.has(id)) ?? fleet.find(free) ?? current);
    if (chosen) claimed.add(chosen);
    plan.set(shipment.id, chosen);
  }
  return plan;
}

/**
 * Stages the demo world again at this moment ("Préparer la démo").
 *
 * The seed's live shipments finish within the hour and ARRIVED is final, so a demo loaded in the
 * morning shows an empty map in the afternoon, and its two DELAYED shipments were born late with
 * no event behind them: no notification, no recommendation. A rehearsal sends every live demo
 * shipment back to its origin leaving now, promises two of them in five minutes so the ETA engine
 * detects the delays for real (event, notification, recommendations, all live), makes SKU-006
 * short again, and clears what a previous rehearsal left: open recommendations and the orders
 * accepted from them.
 *
 * Demo installs only, and only for the demo company's administrator: this rewrites data.
 */
@Injectable()
export class DemoRehearsalService {
  private readonly logger = new Logger(DemoRehearsalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly setup: SetupService,
    private readonly simulator: TelemetrySimulatorService,
    private readonly ledger: InventoryLedgerService,
  ) {}

  async rehearse(user: AuthenticatedUser, now = new Date()): Promise<RehearsalResult> {
    const companyId = await this.demoCompanyOf(user);

    // No tick may run between the rewrite and `forget`, or it would bring the old trip back.
    const result = await this.simulator.pauseWhile(async () => {
      const staged = await this.prisma.$transaction((tx) => this.stage(tx, user, companyId, now), {
        // Deleting a few days of simulated fixes can take longer than the 5 s default.
        timeout: 60_000,
      });
      this.simulator.forget(staged.shipmentIds);
      return staged.result;
    });

    this.logger.log(
      `Demo rehearsed: ${result.shipments} shipment(s) restarted, ${result.delayedSoon.length} due late, ` +
        `${result.cancelledOrders.length} order(s) cancelled, ${result.clearedRecommendations} recommendation(s) cleared`,
    );
    return result;
  }

  private async demoCompanyOf(user: AuthenticatedUser): Promise<string> {
    const { demoAccounts } = await this.setup.status();
    if (!demoAccounts) {
      throw new ConflictException('La démo ne peut être répétée que sur une installation de démonstration');
    }

    const admin = await this.prisma.user.findUnique({
      where: { email: DEMO_ADMIN_EMAIL },
      select: { companyId: true },
    });
    if (!admin?.companyId || user.role !== 'COMPANY_ADMIN' || user.companyId !== admin.companyId) {
      throw new ConflictException('Seul l’administrateur de l’entreprise de démonstration peut répéter la démo');
    }
    return admin.companyId;
  }

  private async stage(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    companyId: string,
    now: Date,
  ): Promise<{ result: RehearsalResult; shipmentIds: string[] }> {
    const shipments = await tx.shipment.findMany({
      where: {
        companyId,
        isDemoData: true,
        trackingNumber: { in: STAGED_TRACKING_NUMBERS },
        status: { in: STAGEABLE },
      },
      include: { route: { select: { polyline: true } } },
      orderBy: { trackingNumber: 'asc' },
    });
    const shipmentIds = shipments.map((shipment) => shipment.id);

    const fleet = await tx.vehicle.findMany({
      where: { companyId, status: { in: ['AVAILABLE', 'IN_TRANSIT'] } },
      select: { id: true, nominalSpeedKmh: true },
      orderBy: [{ createdAt: 'asc' }, { plateNumber: 'asc' }],
    });
    const busy = await tx.shipment.findMany({
      where: { companyId, status: { in: IN_MOTION }, vehicleId: { not: null }, id: { notIn: shipmentIds } },
      select: { vehicleId: true },
    });
    const vehicles = assignVehicles(
      shipments,
      fleet.map((vehicle) => vehicle.id),
      new Set(busy.map((shipment) => shipment.vehicleId as string)),
    );
    const speeds = new Map(fleet.map((vehicle) => [vehicle.id, vehicle.nominalSpeedKmh]));

    await tx.gpsPosition.deleteMany({ where: { shipmentId: { in: shipmentIds } } });

    const delayedSoon: string[] = [];
    for (const shipment of shipments) {
      const vehicleId = vehicles.get(shipment.id) ?? null;
      const late = DELAYED_SOON.includes(shipment.trackingNumber);
      if (late) delayedSoon.push(shipment.trackingNumber);
      const plannedArrivalAt = stagedArrival(
        now,
        stagedRouteKm(shipment.route, shipment.plannedDistanceKm),
        vehicleId ? speeds.get(vehicleId) : null,
        late,
      );

      await tx.shipment.update({
        where: { id: shipment.id },
        data: {
          status: 'IN_TRANSIT',
          vehicleId,
          plannedDepartureAt: now,
          actualDepartureAt: now,
          plannedArrivalAt,
          actualArrivalAt: null,
          estimatedArrivalAt: null,
          etaConfidence: null,
          lastEtaComputedAt: null,
          travelledDistanceKm: 0,
        },
      });
      await tx.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          type: 'STATUS_CHANGED',
          description: `Répétition de la démo : nouveau départ de ${shipment.originName}`,
          fromStatus: shipment.status,
          toStatus: 'IN_TRANSIT',
          metadata: { rehearsal: true, plannedArrival: plannedArrivalAt.toISOString() },
          occurredAt: now,
          isDemoData: true,
        },
      });
      if (vehicleId) {
        await tx.vehicle.update({
          where: { id: vehicleId },
          data: {
            status: 'IN_TRANSIT',
            lastLatitude: shipment.originLatitude,
            lastLongitude: shipment.originLongitude,
            lastSpeedKmh: 0,
            lastPositionAt: now,
          },
        });
      }
    }

    // Before the stock reset: releasing an order's incoming stock must not undo it.
    const cancelledOrders = await this.cancelRecommendationOrders(tx, companyId, now);
    const inventoryReset = await this.resetShortStock(tx, user, companyId);
    const { count: clearedRecommendations } = await tx.recommendation.deleteMany({
      where: { companyId, status: 'OPEN' },
    });

    return {
      result: { shipments: shipments.length, delayedSoon, inventoryReset, cancelledOrders, clearedRecommendations },
      shipmentIds,
    };
  }

  /** An order accepted in a previous rehearsal would otherwise mask the shortage it answered. */
  private async cancelRecommendationOrders(
    tx: Prisma.TransactionClient,
    companyId: string,
    now: Date,
  ): Promise<string[]> {
    const orders = await tx.purchaseOrder.findMany({
      where: { companyId, notes: RECOMMENDATION_ORDER_NOTE, status: { notIn: ['DELIVERED', 'CANCELLED'] } },
      include: { items: { select: { productId: true, quantity: true, receivedQuantity: true } } },
      orderBy: { orderNumber: 'asc' },
    });

    for (const order of orders) {
      await tx.purchaseOrder.update({
        where: { id: order.id },
        data: { status: 'CANCELLED', cancelledAt: now, cancellationReason: REHEARSAL_CANCELLATION_REASON },
      });
      // Same rule as a normal cancellation: a confirmed order stops counting as incoming stock.
      if (order.warehouseId && INCOMING_STOCK_STATUSES.includes(order.status)) {
        for (const item of order.items) {
          const outstanding = Number(item.quantity) - Number(item.receivedQuantity);
          if (outstanding > 0) {
            await this.ledger.adjustIncoming(tx, item.productId, order.warehouseId, -outstanding, companyId);
          }
        }
      }
    }
    return orders.map((order) => order.orderNumber);
  }

  /** SKU-006 at the main warehouse back to two days of demand, nothing on the way. */
  private async resetShortStock(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    companyId: string,
  ): Promise<boolean> {
    const [product, warehouse] = await Promise.all([
      tx.product.findFirst({ where: { companyId, sku: SHORT_SKU }, select: { id: true } }),
      tx.warehouse.findFirst({ where: { companyId, code: MAIN_WAREHOUSE }, select: { id: true } }),
    ]);
    if (!product || !warehouse) return false;

    // Through the ledger, so the stock history explains the jump instead of hiding it.
    await this.ledger.apply(tx, {
      companyId,
      productId: product.id,
      warehouseId: warehouse.id,
      type: 'ADJUSTMENT',
      quantity: SHORT_SKU_STOCK,
      reason: REHEARSAL_STOCK_REASON,
      performedById: user.id,
      isDemoData: true,
    });
    await tx.inventory.update({
      where: { productId_warehouseId: { productId: product.id, warehouseId: warehouse.id } },
      data: { incomingStock: 0 },
    });
    return true;
  }
}
