import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Supplier } from '@prisma/client';
import { MasterDataService, type PrismaDelegateLike } from '../../common/crud/master-data.service';
import { PrismaService } from '../../prisma/prisma.service';
import { companyFilter } from '../../common/tenancy/tenant-scope';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { computeSupplierReliability, type SupplierObservations } from './supplier-scoring';
import type { UpsertSupplierProductDto } from './suppliers.dto';

const DAY_MS = 86_400_000;

@Injectable()
export class SuppliersService extends MasterDataService<Supplier> {
  private readonly logger = new Logger(SuppliersService.name);

  constructor(private readonly prisma: PrismaService) {
    super(prisma.supplier as unknown as PrismaDelegateLike<Supplier>, {
      entity: 'Fournisseur',
      sortable: ['name', 'code', 'country', 'reliabilityScore', 'observedLeadTimeDays', 'createdAt'],
      defaultSort: 'name',
      searchable: ['name', 'code', 'country', 'city', 'contactName', 'contactEmail'],
      listInclude: { _count: { select: { purchaseOrders: true, products: true } } },
      detailInclude: {
        products: { include: { product: { select: { id: true, sku: true, name: true } } } },
        performance: { orderBy: { periodStart: 'desc' }, take: 12 },
      },
    });
  }

  /* ------------------------------------------------------------ catalogue */

  async upsertProduct(user: AuthenticatedUser, supplierId: string, dto: UpsertSupplierProductDto) {
    const supplier = await this.findOne(user, supplierId);
    const product = await this.prisma.product.findUnique({ where: { id: dto.productId } });
    if (!product || product.companyId !== supplier.companyId) {
      throw new BadRequestException('Produit introuvable dans votre entreprise');
    }

    // Price lists are versioned by validFrom. Rather than mutating history, an update closes the
    // current row and opens a new one, so a purchase order raised last month can still be
    // reconciled against the price that applied then.
    const current = await this.prisma.supplierProduct.findFirst({
      where: { supplierId, productId: dto.productId, validUntil: null },
      orderBy: { validFrom: 'desc' },
    });

    const now = new Date();
    if (current) {
      const unchanged =
        Number(current.unitPrice) === dto.unitPrice &&
        current.leadTimeDays === dto.leadTimeDays &&
        Number(current.capacityPerCycle) === dto.capacityPerCycle &&
        Number(current.minimumOrderQuantity) === (dto.minimumOrderQuantity ?? 1);
      if (unchanged) return current;

      await this.prisma.supplierProduct.update({
        where: { id: current.id },
        data: { validUntil: now },
      });
    }

    return this.prisma.supplierProduct.create({
      data: {
        supplierId,
        productId: dto.productId,
        unitPrice: dto.unitPrice,
        currency: dto.currency ?? supplier.currency,
        minimumOrderQuantity: dto.minimumOrderQuantity ?? 1,
        capacityPerCycle: dto.capacityPerCycle,
        leadTimeDays: dto.leadTimeDays,
        validFrom: now,
      },
    });
  }

  async listProducts(user: AuthenticatedUser, supplierId: string) {
    await this.findOne(user, supplierId);
    return this.prisma.supplierProduct.findMany({
      where: { supplierId, validUntil: null },
      include: { product: { select: { id: true, sku: true, name: true, unitCost: true } } },
      orderBy: { unitPrice: 'asc' },
    });
  }

  /* ------------------------------------------------------ performance ---- */

  /**
   * Recomputes reliability from the supplier's own purchase-order history.
   *
   * "On time" is measured against `expectedDeliveryDate`, and a PO with no expected date is
   * excluded rather than counted as on time — scoring a supplier well because nobody set a
   * deadline would make the metric meaningless.
   */
  async recomputePerformance(user: AuthenticatedUser, supplierId: string, windowDays = 365) {
    const supplier = await this.findOne(user, supplierId);
    const since = new Date(Date.now() - windowDays * DAY_MS);

    const orders = await this.prisma.purchaseOrder.findMany({
      where: { supplierId, createdAt: { gte: since } },
      include: { items: true },
    });

    const observations = summariseOrders(orders);
    const result = computeSupplierReliability(observations);

    const updated = await this.prisma.supplier.update({
      where: { id: supplierId },
      data: {
        onTimeDeliveryRate: result.onTimeDeliveryRate,
        qualityAcceptanceRate: result.qualityAcceptanceRate,
        fillRate: result.fillRate,
        cancellationRate: result.cancellationRate,
        observedLeadTimeDays: result.observedLeadTimeDays || supplier.quotedLeadTimeDays,
        observedLeadTimeStdDays: result.observedLeadTimeStdDays,
        reliabilityScore: result.reliabilityScore,
        performanceUpdatedAt: new Date(),
      },
    });

    const periodStart = since;
    const periodEnd = new Date();
    await this.prisma.supplierPerformance.upsert({
      where: {
        supplierId_periodStart_periodEnd: { supplierId, periodStart, periodEnd },
      },
      create: {
        supplierId,
        periodStart,
        periodEnd,
        ordersTotal: observations.ordersTotal,
        ordersOnTime: observations.ordersOnTime,
        ordersLate: Math.max(
          observations.ordersTotal - observations.ordersCancelled - observations.ordersOnTime,
          0,
        ),
        ordersCancelled: observations.ordersCancelled,
        quantityOrdered: observations.quantityOrdered,
        quantityReceived: observations.quantityReceived,
        quantityRejected: observations.quantityRejected,
        averageDelayDays: averageDelayDays(orders),
        onTimeDeliveryRate: result.onTimeDeliveryRate,
        qualityAcceptanceRate: result.qualityAcceptanceRate,
        fillRate: result.fillRate,
        reliabilityScore: result.reliabilityScore,
        isDemoData: supplier.isDemoData,
      },
      update: {},
    });

    return { supplier: updated, scoring: result, ordersConsidered: orders.length, windowDays };
  }

  /** Recomputes every supplier in the company. Used by the nightly job and after a bulk import. */
  async recomputeAll(user: AuthenticatedUser, windowDays = 365) {
    const suppliers = await this.prisma.supplier.findMany({
      where: { ...companyFilter(user), isActive: true },
      select: { id: true },
    });

    let updated = 0;
    for (const { id } of suppliers) {
      try {
        await this.recomputePerformance(user, id, windowDays);
        updated += 1;
      } catch (error) {
        this.logger.error(
          `Supplier ${id} performance recompute failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    return { suppliersProcessed: suppliers.length, updated };
  }

  /** Ranking view for the procurement dashboard. */
  async leaderboard(user: AuthenticatedUser, limit = 20) {
    const suppliers = await this.prisma.supplier.findMany({
      where: { ...companyFilter(user), isActive: true },
      orderBy: { reliabilityScore: 'desc' },
      take: limit,
      select: {
        id: true,
        code: true,
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
    });

    return suppliers.map((s, index) => ({
      rank: index + 1,
      ...s,
      ordersPlaced: s._count.purchaseOrders,
      /** Null when performance has never been computed — not the same as "perfect". */
      scoreIsMeasured: s.performanceUpdatedAt !== null,
    }));
  }

  async performanceHistory(user: AuthenticatedUser, supplierId: string) {
    await this.findOne(user, supplierId);
    const rows = await this.prisma.supplierPerformance.findMany({
      where: { supplierId },
      orderBy: { periodStart: 'asc' },
    });
    if (rows.length === 0) {
      throw new NotFoundException(
        'Aucun historique de performance pour l’instant : lancez d’abord le recalcul (POST /suppliers/:id/recompute-performance)',
      );
    }
    return rows;
  }
}

type OrderWithItems = {
  status: string;
  expectedDeliveryDate: Date | null;
  actualDeliveryDate: Date | null;
  orderedAt: Date | null;
  createdAt: Date;
  items: Array<{ quantity: unknown; receivedQuantity: unknown; rejectedQuantity: unknown }>;
};

/** Folds raw purchase orders into the counters the scoring function expects. */
export function summariseOrders(orders: OrderWithItems[]): SupplierObservations {
  const observations: SupplierObservations = {
    ordersTotal: orders.length,
    ordersOnTime: 0,
    ordersCancelled: 0,
    quantityOrdered: 0,
    quantityReceived: 0,
    quantityRejected: 0,
    leadTimeSamplesDays: [],
  };

  for (const order of orders) {
    if (order.status === 'CANCELLED') {
      observations.ordersCancelled += 1;
      continue;
    }

    for (const item of order.items) {
      observations.quantityOrdered += Number(item.quantity);
      observations.quantityReceived += Number(item.receivedQuantity);
      observations.quantityRejected += Number(item.rejectedQuantity);
    }

    if (order.status !== 'DELIVERED' || !order.actualDeliveryDate) continue;

    // Only orders with a promised date can be judged on-time.
    if (order.expectedDeliveryDate) {
      const late = order.actualDeliveryDate.getTime() > order.expectedDeliveryDate.getTime();
      if (!late) observations.ordersOnTime += 1;
    }

    const start = order.orderedAt ?? order.createdAt;
    const leadDays = (order.actualDeliveryDate.getTime() - start.getTime()) / DAY_MS;
    if (leadDays >= 0 && leadDays < 400) observations.leadTimeSamplesDays.push(leadDays);
  }

  return observations;
}

function averageDelayDays(orders: OrderWithItems[]): number {
  const delays = orders
    .filter((o) => o.status === 'DELIVERED' && o.actualDeliveryDate && o.expectedDeliveryDate)
    .map(
      (o) =>
        (o.actualDeliveryDate!.getTime() - o.expectedDeliveryDate!.getTime()) / DAY_MS,
    )
    .map((d) => Math.max(d, 0));

  if (delays.length === 0) return 0;
  return Math.round((delays.reduce((s, d) => s + d, 0) / delays.length) * 100) / 100;
}
