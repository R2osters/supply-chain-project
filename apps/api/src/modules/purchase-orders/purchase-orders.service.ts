import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PurchaseOrderStatus } from '@scip/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { paginated, safeOrderBy, type PaginatedResult } from '../../common/dto/pagination.dto';
import {
  companyFilter,
  purchaseOrderPartyFilter,
  requireCompanyId,
} from '../../common/tenancy/tenant-scope';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { DOMAIN_EVENTS, DomainEventsService } from '../events/domain-events.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import type {
  CreatePurchaseOrderDto,
  PurchaseOrderQueryDto,
  ReceivePurchaseOrderDto,
  UpdatePurchaseOrderDto,
} from './purchase-orders.dto';
import {
  EDITABLE_STATUSES,
  INCOMING_STOCK_STATUSES,
  PURCHASE_ORDER_TRANSITIONS,
  assertTransition,
} from './purchase-order-status';

const DAY_MS = 86_400_000;
const SORTABLE = ['orderNumber', 'status', 'totalAmount', 'expectedDeliveryDate', 'createdAt'] as const;

@Injectable()
export class PurchaseOrdersService {
  private readonly logger = new Logger(PurchaseOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: InventoryLedgerService,
    private readonly events: DomainEventsService,
  ) {}

  /* ----------------------------------------------------------------- reads */

  async list(
    user: AuthenticatedUser,
    query: PurchaseOrderQueryDto,
  ): Promise<PaginatedResult<unknown>> {
    const where: Prisma.PurchaseOrderWhereInput = {
      ...companyFilter(user),
      ...purchaseOrderPartyFilter(user),
      ...(query.status ? { status: query.status } : {}),
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.search
        ? {
            OR: [
              { orderNumber: { contains: query.search, mode: 'insensitive' } },
              { supplier: { name: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
      ...(query.expectedFrom || query.expectedTo
        ? {
            expectedDeliveryDate: {
              ...(query.expectedFrom ? { gte: new Date(query.expectedFrom) } : {}),
              ...(query.expectedTo ? { lte: new Date(query.expectedTo) } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where,
        include: {
          supplier: { select: { id: true, code: true, name: true, reliabilityScore: true } },
          warehouse: { select: { id: true, code: true, name: true } },
          _count: { select: { items: true, shipments: true } },
        },
        orderBy: safeOrderBy(query, SORTABLE, 'createdAt'),
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);

    return paginated(data, total, query);
  }

  async findOne(user: AuthenticatedUser, id: string) {
    const order = await this.prisma.purchaseOrder.findFirst({
      where: { id, ...companyFilter(user), ...purchaseOrderPartyFilter(user) },
      include: {
        supplier: true,
        warehouse: { select: { id: true, code: true, name: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        approvedBy: { select: { id: true, firstName: true, lastName: true } },
        items: { include: { product: { select: { id: true, sku: true, name: true, unitOfMeasure: true } } } },
        shipments: {
          select: {
            id: true,
            trackingNumber: true,
            status: true,
            estimatedArrivalAt: true,
            delayProbability: true,
          },
        },
      },
    });

    if (!order) throw new NotFoundException(`No purchase order found with id ${id}`);

    return {
      ...order,
      allowedTransitions: PURCHASE_ORDER_TRANSITIONS[order.status as PurchaseOrderStatus],
      isEditable: EDITABLE_STATUSES.includes(order.status as PurchaseOrderStatus),
    };
  }

  /* ---------------------------------------------------------------- create */

  async create(user: AuthenticatedUser, dto: CreatePurchaseOrderDto) {
    const companyId = requireCompanyId(user);

    const supplier = await this.prisma.supplier.findFirst({
      where: { id: dto.supplierId, companyId },
    });
    if (!supplier) throw new BadRequestException('Supplier not found in your company');

    if (dto.warehouseId) {
      const warehouse = await this.prisma.warehouse.findFirst({
        where: { id: dto.warehouseId, companyId },
      });
      if (!warehouse) throw new BadRequestException('Warehouse not found in your company');
    }

    const lines = await this.priceLines(companyId, dto.supplierId, dto.items);

    const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
    const shippingCost = dto.shippingCost ?? 0;
    const taxAmount = dto.taxAmount ?? 0;

    const expectedDeliveryDate = dto.expectedDeliveryDate
      ? new Date(dto.expectedDeliveryDate)
      : new Date(Date.now() + supplier.quotedLeadTimeDays * DAY_MS);

    return this.withOrderNumber(companyId, async (orderNumber) =>
      this.prisma.purchaseOrder.create({
        data: {
          companyId,
          supplierId: dto.supplierId,
          warehouseId: dto.warehouseId ?? null,
          orderNumber,
          status: 'DRAFT',
          currency: supplier.currency,
          subtotal,
          taxAmount,
          shippingCost,
          totalAmount: subtotal + taxAmount + shippingCost,
          expectedShippingDate: dto.expectedShippingDate ? new Date(dto.expectedShippingDate) : null,
          expectedDeliveryDate,
          notes: dto.notes ?? null,
          createdById: user.id,
          sourceRecommendationId: dto.sourceRecommendationId ?? null,
          items: {
            create: lines.map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              lineTotal: line.lineTotal,
            })),
          },
        },
        include: { items: { include: { product: { select: { sku: true, name: true } } } }, supplier: true },
      }),
    );
  }

  /**
   * Resolves a unit price for every line: the caller's explicit price if given, otherwise the
   * supplier's price list in force today. An unpriced product is rejected rather than silently
   * defaulted to zero — a PO with a 0.00 line is worse than an error message.
   */
  private async priceLines(
    companyId: string,
    supplierId: string,
    items: Array<{ productId: string; quantity: number; unitPrice?: number }>,
  ) {
    const productIds = items.map((i) => i.productId);
    if (new Set(productIds).size !== productIds.length) {
      throw new BadRequestException('The same product appears more than once; merge the lines');
    }

    const [products, priceRows] = await Promise.all([
      this.prisma.product.findMany({ where: { id: { in: productIds }, companyId } }),
      this.prisma.supplierProduct.findMany({
        where: { supplierId, productId: { in: productIds }, validUntil: null },
      }),
    ]);

    const productById = new Map(products.map((p) => [p.id, p]));
    const priceByProduct = new Map(priceRows.map((r) => [r.productId, r]));

    return items.map((item) => {
      const product = productById.get(item.productId);
      if (!product) {
        throw new BadRequestException(`Product ${item.productId} not found in your company`);
      }

      const priceRow = priceByProduct.get(item.productId);
      const unitPrice = item.unitPrice ?? (priceRow ? Number(priceRow.unitPrice) : undefined);
      if (unitPrice === undefined) {
        throw new BadRequestException(
          `No price for ${product.sku} from this supplier. Add it to the supplier price list or pass unitPrice explicitly.`,
        );
      }

      if (priceRow && item.quantity < Number(priceRow.minimumOrderQuantity)) {
        throw new BadRequestException(
          `${product.sku}: quantity ${item.quantity} is below the supplier minimum order quantity of ${Number(priceRow.minimumOrderQuantity)}`,
        );
      }

      return {
        productId: item.productId,
        quantity: item.quantity,
        unitPrice,
        lineTotal: round(item.quantity * unitPrice, 4),
      };
    });
  }

  /**
   * `PO-<year>-<sequence>` scoped to the company. The sequence is derived from the current
   * maximum, so two concurrent creates can collide on the unique index; that collision is caught
   * and retried rather than pre-empted with a lock, because contention here is rare and a lock
   * would serialise every PO creation in the tenant.
   */
  private async withOrderNumber<T>(companyId: string, create: (orderNumber: string) => Promise<T>) {
    const year = new Date().getFullYear();
    const prefix = `PO-${year}-`;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const last = await this.prisma.purchaseOrder.findFirst({
        where: { companyId, orderNumber: { startsWith: prefix } },
        orderBy: { orderNumber: 'desc' },
        select: { orderNumber: true },
      });

      const lastSequence = last ? Number.parseInt(last.orderNumber.slice(prefix.length), 10) : 0;
      const next = (Number.isFinite(lastSequence) ? lastSequence : 0) + 1 + attempt;
      const orderNumber = `${prefix}${String(next).padStart(4, '0')}`;

      try {
        return await create(orderNumber);
      } catch (error) {
        const isDuplicate =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!isDuplicate || attempt === 4) throw error;
        this.logger.warn(`Order number ${orderNumber} was taken; retrying`);
      }
    }
    throw new BadRequestException('Could not allocate a purchase order number; please retry');
  }

  /* ---------------------------------------------------------------- update */

  async update(user: AuthenticatedUser, id: string, dto: UpdatePurchaseOrderDto) {
    const order = await this.findOne(user, id);

    if (!EDITABLE_STATUSES.includes(order.status as PurchaseOrderStatus)) {
      throw new BadRequestException(
        `A ${order.status} purchase order cannot be edited. Cancel it and raise a new one.`,
      );
    }

    const data: Prisma.PurchaseOrderUpdateInput = {
      ...(dto.expectedDeliveryDate ? { expectedDeliveryDate: new Date(dto.expectedDeliveryDate) } : {}),
      ...(dto.expectedShippingDate ? { expectedShippingDate: new Date(dto.expectedShippingDate) } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      ...(dto.warehouseId ? { warehouse: { connect: { id: dto.warehouseId } } } : {}),
    };

    if (!dto.items) {
      const shippingCost = dto.shippingCost ?? Number(order.shippingCost);
      const taxAmount = dto.taxAmount ?? Number(order.taxAmount);
      return this.prisma.purchaseOrder.update({
        where: { id },
        data: {
          ...data,
          shippingCost,
          taxAmount,
          totalAmount: Number(order.subtotal) + shippingCost + taxAmount,
        },
        include: { items: true },
      });
    }

    const lines = await this.priceLines(order.companyId, order.supplierId, dto.items);
    const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
    const shippingCost = dto.shippingCost ?? Number(order.shippingCost);
    const taxAmount = dto.taxAmount ?? Number(order.taxAmount);

    return this.prisma.$transaction(async (tx) => {
      await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
      return tx.purchaseOrder.update({
        where: { id },
        data: {
          ...data,
          subtotal,
          shippingCost,
          taxAmount,
          totalAmount: subtotal + shippingCost + taxAmount,
          items: {
            create: lines.map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              lineTotal: line.lineTotal,
            })),
          },
        },
        include: { items: true },
      });
    });
  }

  /* ------------------------------------------------------------ transition */

  async transition(
    user: AuthenticatedUser,
    id: string,
    to: PurchaseOrderStatus,
    reason?: string,
  ) {
    const order = await this.findOne(user, id);
    const from = order.status as PurchaseOrderStatus;
    assertTransition(from, to);

    if (to === 'CANCELLED' && !reason) {
      throw new BadRequestException('A cancellation reason is required');
    }
    if (to === 'DELIVERED') {
      throw new BadRequestException(
        'Mark a purchase order delivered by receiving it: POST /purchase-orders/:id/receive',
      );
    }

    const enteringIncoming =
      !INCOMING_STOCK_STATUSES.includes(from) && INCOMING_STOCK_STATUSES.includes(to);
    const leavingIncoming =
      INCOMING_STOCK_STATUSES.includes(from) && !INCOMING_STOCK_STATUSES.includes(to);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.purchaseOrder.update({
        where: { id },
        data: {
          status: to,
          ...(to === 'CONFIRMED' ? { confirmedAt: new Date(), approvedById: user.id } : {}),
          ...(to === 'PENDING' ? { orderedAt: new Date() } : {}),
          ...(to === 'CANCELLED'
            ? { cancelledAt: new Date(), cancellationReason: reason ?? null }
            : {}),
        },
        include: { items: true },
      });

      // Incoming stock must mirror the order's commitment state, or the reorder engine will
      // either double-order (incoming forgotten) or starve (incoming never released).
      if (order.warehouseId && (enteringIncoming || leavingIncoming)) {
        const sign = enteringIncoming ? 1 : -1;
        for (const item of updated.items) {
          await this.ledger.adjustIncoming(
            tx,
            item.productId,
            order.warehouseId,
            sign * Number(item.quantity),
            order.companyId,
          );
        }
      }

      if (to === 'CONFIRMED') {
        await this.events.publish(tx, {
          companyId: order.companyId,
          type: DOMAIN_EVENTS.PO_CONFIRMED,
          subjectType: 'PURCHASE_ORDER',
          subjectId: id,
          payload: { orderNumber: order.orderNumber, supplierId: order.supplierId },
        });
      }
      if (to === 'CANCELLED') {
        await this.events.publish(tx, {
          companyId: order.companyId,
          type: DOMAIN_EVENTS.PO_CANCELLED,
          subjectType: 'PURCHASE_ORDER',
          subjectId: id,
          payload: { orderNumber: order.orderNumber, supplierId: order.supplierId, reason },
        });
      }

      return updated;
    });
  }

  /* --------------------------------------------------------------- receive */

  /**
   * Goods receipt. Handles partial deliveries: the order only becomes DELIVERED once every line
   * is fully received, otherwise it stays in transit and can be received again.
   *
   * Rejected units are received into `damagedStock`, not into sellable stock — counting a failed
   * QC batch as available is how phantom inventory starts.
   */
  async receive(user: AuthenticatedUser, id: string, dto: ReceivePurchaseOrderDto) {
    const order = await this.findOne(user, id);
    const status = order.status as PurchaseOrderStatus;

    if (['DRAFT', 'PENDING', 'CANCELLED', 'DELIVERED'].includes(status)) {
      throw new BadRequestException(`A ${status} purchase order cannot be received`);
    }

    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id: dto.warehouseId, companyId: order.companyId },
    });
    if (!warehouse) throw new BadRequestException('Warehouse not found in your company');

    const itemByProduct = new Map(order.items.map((item) => [item.productId, item]));

    for (const line of dto.lines) {
      const item = itemByProduct.get(line.productId);
      if (!item) {
        throw new BadRequestException(`Product ${line.productId} is not on this purchase order`);
      }
      const rejected = line.rejectedQuantity ?? 0;
      if (rejected > line.receivedQuantity) {
        throw new BadRequestException(
          `Rejected quantity (${rejected}) cannot exceed received quantity (${line.receivedQuantity})`,
        );
      }
      const outstanding = Number(item.quantity) - Number(item.receivedQuantity);
      if (line.receivedQuantity > outstanding) {
        throw new BadRequestException(
          `${item.product.sku}: receiving ${line.receivedQuantity} exceeds the ${outstanding} still outstanding`,
        );
      }
      if (line.expiryDate && Number.isNaN(new Date(line.expiryDate).getTime())) {
        throw new BadRequestException('expiryDate is not a valid date');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      for (const line of dto.lines) {
        const item = itemByProduct.get(line.productId)!;
        const rejected = line.rejectedQuantity ?? 0;
        const accepted = line.receivedQuantity - rejected;

        if (accepted > 0) {
          await this.ledger.apply(tx, {
            companyId: order.companyId,
            productId: line.productId,
            warehouseId: dto.warehouseId,
            type: 'IN',
            quantity: accepted,
            reference: order.orderNumber,
            reason: dto.note ?? `Goods receipt for ${order.orderNumber}`,
            batchNumber: line.batchNumber ?? null,
            performedById: user.id,
            purchaseOrderId: id,
            isDemoData: order.isDemoData,
          });
        }

        if (rejected > 0) {
          await tx.inventory.update({
            where: {
              productId_warehouseId: { productId: line.productId, warehouseId: dto.warehouseId },
            },
            data: { damagedStock: { increment: rejected } },
          });
        }

        if (line.batchNumber) {
          await tx.inventoryBatch.upsert({
            where: {
              productId_batchNumber: { productId: line.productId, batchNumber: line.batchNumber },
            },
            create: {
              productId: line.productId,
              warehouseId: dto.warehouseId,
              batchNumber: line.batchNumber,
              quantity: accepted,
              expiryDate: line.expiryDate ? new Date(line.expiryDate) : null,
              isDemoData: order.isDemoData,
            },
            update: { quantity: { increment: accepted } },
          });
        }

        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data: {
            receivedQuantity: { increment: line.receivedQuantity },
            rejectedQuantity: { increment: rejected },
          },
        });

        if (order.warehouseId) {
          await this.ledger.adjustIncoming(
            tx,
            line.productId,
            order.warehouseId,
            -line.receivedQuantity,
          );
        }
      }

      const items = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: id } });
      const fullyReceived = items.every(
        (item) => Number(item.receivedQuantity) >= Number(item.quantity),
      );

      const updated = await tx.purchaseOrder.update({
        where: { id },
        data: fullyReceived
          ? { status: 'DELIVERED', actualDeliveryDate: new Date() }
          : { status: 'IN_TRANSIT' },
        include: { items: { include: { product: { select: { sku: true, name: true } } } } },
      });

      await this.events.publish(tx, {
        companyId: order.companyId,
        type: DOMAIN_EVENTS.PO_RECEIVED,
        subjectType: 'PURCHASE_ORDER',
        subjectId: id,
        payload: {
          orderNumber: order.orderNumber,
          supplierId: order.supplierId,
          warehouseId: dto.warehouseId,
          fullyReceived,
          lines: dto.lines.map((l) => ({
            productId: l.productId,
            received: l.receivedQuantity,
            rejected: l.rejectedQuantity ?? 0,
          })),
        },
      });

      return {
        ...updated,
        fullyReceived,
        outstanding: items
          .filter((item) => Number(item.receivedQuantity) < Number(item.quantity))
          .map((item) => ({
            productId: item.productId,
            ordered: Number(item.quantity),
            received: Number(item.receivedQuantity),
            remaining: Number(item.quantity) - Number(item.receivedQuantity),
          })),
      };
    });
  }
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
