import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginated, type PaginationQueryDto } from '../../common/dto/pagination.dto';
import { companyFilter, requireCompanyId } from '../../common/tenancy/tenant-scope';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PurchaseOrdersService } from '../purchase-orders/purchase-orders.service';

/**
 * Recommendations, and the machinery that makes them executable.
 *
 * The whole point of the platform is here: `accept()` does not mark a row and stop. It reads the
 * recommendation's payload and performs the real action — raises an actual purchase order,
 * writes an actual inventory policy — then links the created entity back to the recommendation.
 * A recommendation the user has to retype into another screen is a report, not a recommendation.
 *
 * That link is also what makes the system measurable: because every executed recommendation
 * points at what it created, the question "did acting on the advice help?" has an answer.
 */
@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly purchaseOrders: PurchaseOrdersService,
  ) {}

  async list(
    user: AuthenticatedUser,
    query: PaginationQueryDto,
    filters: { status?: string; priority?: string; type?: string },
  ) {
    const where: Prisma.RecommendationWhereInput = {
      ...companyFilter(user),
      ...(filters.status ? { status: filters.status as never } : { status: 'OPEN' }),
      ...(filters.priority ? { priority: filters.priority } : {}),
      ...(filters.type ? { type: filters.type as never } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.recommendation.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: query.skip,
        take: query.limit,
        include: { decidedBy: { select: { id: true, firstName: true, lastName: true } } },
      }),
      this.prisma.recommendation.count({ where }),
    ]);

    // Priority is a string in the database, so ordering is done here where the intended
    // sequence is explicit rather than alphabetical (CRITICAL < HIGH < LOW is wrong).
    const rank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    data.sort(
      (a, b) =>
        (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9) ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    );

    return paginated(data, total, query);
  }

  async findOne(user: AuthenticatedUser, id: string) {
    const recommendation = await this.prisma.recommendation.findFirst({
      where: { id, ...companyFilter(user) },
      include: { decidedBy: { select: { id: true, firstName: true, lastName: true } } },
    });
    if (!recommendation) throw new NotFoundException('Recommendation not found');

    // The event trail that led here — this is what "explainable" means in practice: not just
    // the model's reasons, but the facts that triggered the analysis in the first place.
    const events = await this.prisma.domainEvent.findMany({
      where: {
        companyId: recommendation.companyId,
        subjectType: recommendation.subjectType,
        subjectId: recommendation.subjectId,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return { ...recommendation, triggeringEvents: events };
  }

  /**
   * Executes a recommendation.
   *
   * Which action is taken depends on the type; anything without an executor is accepted and
   * recorded but performs nothing, and says so, rather than pretending to have acted.
   */
  async accept(user: AuthenticatedUser, id: string, note?: string) {
    const recommendation = await this.findOne(user, id);

    if (recommendation.status !== 'OPEN') {
      throw new BadRequestException(
        `This recommendation is already ${recommendation.status}; it cannot be accepted again.`,
      );
    }
    if (recommendation.expiresAt && recommendation.expiresAt.getTime() < Date.now()) {
      await this.prisma.recommendation.update({
        where: { id },
        data: { status: 'EXPIRED' },
      });
      throw new BadRequestException(
        'This recommendation has expired. Regenerate recommendations to get a current one.',
      );
    }

    const payload = recommendation.payload as Record<string, unknown>;
    let executed: { type: string; id: string; description: string } | null = null;

    switch (recommendation.type) {
      case 'ORDER_NOW':
      case 'SPLIT_ORDER':
        executed = await this.executeOrder(user, payload);
        break;

      case 'INCREASE_SAFETY_STOCK':
        executed = await this.executePolicy(user, payload);
        break;

      case 'REDUCE_INVENTORY':
        executed = await this.executeMaxStock(user, payload);
        break;

      default:
        // CHANGE_SUPPLIER, ADD_SUPPLIER, EXPEDITE_SHIPMENT and CHANGE_ROUTE are commercial or
        // operational decisions with no single automatable action. Accepting them records the
        // decision; the work happens outside the system.
        break;
    }

    const updated = await this.prisma.recommendation.update({
      where: { id },
      data: {
        status: executed ? 'EXECUTED' : 'ACCEPTED',
        decidedById: user.id,
        decidedAt: new Date(),
        decisionNote: note ?? null,
        executedEntityType: executed?.type ?? null,
        executedEntityId: executed?.id ?? null,
      },
    });

    return {
      recommendation: updated,
      executed,
      message: executed
        ? executed.description
        : 'Recorded as accepted. This recommendation type has no automatic action — it is a ' +
          'commercial or operational decision to carry out directly.',
    };
  }

  /** Raises a real purchase order (or one per supplier, for a split) from the payload. */
  private async executeOrder(user: AuthenticatedUser, payload: Record<string, unknown>) {
    const productId = payload.productId as string;
    const warehouseId = (payload.warehouseId as string | undefined) ?? undefined;
    const lines = payload.lines as
      | Array<{ supplierId: string; supplierName?: string; quantity: number; unitPrice?: number }>
      | undefined;

    if (!productId) {
      throw new BadRequestException('This recommendation has no productId to order against');
    }

    if (lines?.length) {
      const created: string[] = [];
      for (const line of lines) {
        if (line.quantity <= 0) continue;
        const order = await this.purchaseOrders.create(user, {
          supplierId: line.supplierId,
          warehouseId,
          items: [
            {
              productId,
              quantity: line.quantity,
              ...(line.unitPrice !== undefined ? { unitPrice: line.unitPrice } : {}),
            },
          ],
          ...(payload.requiredByDate
            ? { expectedDeliveryDate: String(payload.requiredByDate) }
            : {}),
          notes: 'Raised from an accepted SCIP recommendation',
        });
        created.push(order.orderNumber);
      }

      if (created.length === 0) {
        throw new BadRequestException('The recommendation contained no orderable quantity');
      }

      return {
        type: 'PURCHASE_ORDER',
        id: created.join(','),
        description: `Created ${created.length} draft purchase order(s): ${created.join(', ')}. Review and confirm them.`,
      };
    }

    // No supplier split was computed — fall back to the preferred supplier for the product.
    const quantity = Number(payload.quantity ?? 0);
    if (quantity <= 0) throw new BadRequestException('The recommendation has no quantity to order');

    const offer = await this.prisma.supplierProduct.findFirst({
      where: { productId, validUntil: null, supplier: { isActive: true } },
      orderBy: [{ isPreferred: 'desc' }, { unitPrice: 'asc' }],
      include: { supplier: true },
    });
    if (!offer) {
      throw new BadRequestException(
        'No active supplier carries this product, so no purchase order could be raised. ' +
          'Add a supplier price list first.',
      );
    }

    const order = await this.purchaseOrders.create(user, {
      supplierId: offer.supplierId,
      warehouseId,
      items: [{ productId, quantity }],
      notes: 'Raised from an accepted SCIP recommendation',
    });

    return {
      type: 'PURCHASE_ORDER',
      id: order.id,
      description: `Created draft purchase order ${order.orderNumber} with ${offer.supplier.name}. Review and confirm it.`,
    };
  }

  /** Writes the recommended safety stock and reorder point onto the inventory row. */
  private async executePolicy(user: AuthenticatedUser, payload: Record<string, unknown>) {
    const productId = payload.productId as string;
    const warehouseId = payload.warehouseId as string | undefined;
    const safetyStock = Number(payload.safetyStock ?? 0);
    const reorderPoint = Number(payload.reorderPoint ?? 0);

    if (!productId || !warehouseId) {
      throw new BadRequestException(
        'This recommendation is missing the product or warehouse to apply the policy to',
      );
    }

    const row = await this.prisma.inventory.update({
      where: { productId_warehouseId: { productId, warehouseId } },
      data: { safetyStock, reorderPoint },
    });

    return {
      type: 'INVENTORY_POLICY',
      id: row.id,
      description: `Safety stock set to ${safetyStock.toFixed(0)} and reorder point to ${reorderPoint.toFixed(0)}.`,
    };
  }

  /** Caps the maximum stock level so the overstock alert fires if it creeps back up. */
  private async executeMaxStock(user: AuthenticatedUser, payload: Record<string, unknown>) {
    const productId = payload.productId as string;
    const suggestedMax = Number(payload.suggestedMaxStock ?? 0);

    if (!productId || suggestedMax <= 0) {
      throw new BadRequestException('This recommendation has no usable maximum stock level');
    }

    const companyId = requireCompanyId(user);
    const result = await this.prisma.inventory.updateMany({
      where: { productId, companyId },
      data: { maxStock: suggestedMax },
    });

    return {
      type: 'INVENTORY_POLICY',
      id: productId,
      description: `Maximum stock capped at ${suggestedMax.toFixed(0)} across ${result.count} warehouse(s); overstock will now raise an alert.`,
    };
  }

  async reject(user: AuthenticatedUser, id: string, note?: string) {
    const recommendation = await this.findOne(user, id);
    if (recommendation.status !== 'OPEN') {
      throw new BadRequestException(`This recommendation is already ${recommendation.status}`);
    }

    return this.prisma.recommendation.update({
      where: { id },
      data: {
        status: 'REJECTED',
        decidedById: user.id,
        decidedAt: new Date(),
        decisionNote: note ?? null,
      },
    });
  }

  /** Expires recommendations past their date. Driven by the scheduler. */
  async expireStale(): Promise<number> {
    const result = await this.prisma.recommendation.updateMany({
      where: { status: 'OPEN', expiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED' },
    });
    return result.count;
  }

  /** Acceptance statistics — the measure of whether the advice is any good. */
  async stats(user: AuthenticatedUser) {
    const companyId = requireCompanyId(user);
    const rows = await this.prisma.recommendation.groupBy({
      by: ['status', 'type'],
      where: { companyId },
      _count: { _all: true },
    });

    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + row._count._all;
      byType[row.type] = (byType[row.type] ?? 0) + row._count._all;
    }

    const decided =
      (byStatus.ACCEPTED ?? 0) + (byStatus.EXECUTED ?? 0) + (byStatus.REJECTED ?? 0);
    const acted = (byStatus.ACCEPTED ?? 0) + (byStatus.EXECUTED ?? 0);

    return {
      byStatus,
      byType,
      open: byStatus.OPEN ?? 0,
      /** Of the recommendations a human has judged, the share they acted on. */
      acceptanceRate: decided > 0 ? Math.round((acted / decided) * 1000) / 1000 : null,
      decided,
    };
  }
}
