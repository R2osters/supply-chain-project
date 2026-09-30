import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma, type StockMovementType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Every change to stock goes through here.
 *
 * Two rules the rest of the codebase relies on:
 *
 *  1. **No blind writes.** Callers never `update` an inventory row directly. They post a movement,
 *     and this service applies it and records the ledger line with the resulting balance. That is
 *     what makes `inventory_movements` a true audit trail: replaying it reproduces the balance.
 *
 *  2. **Concurrency-safe.** Stock is decremented with a conditional UPDATE that checks the
 *     available quantity in the same statement (`WHERE availableStock >= qty`). Two pickers
 *     racing for the last pallet cannot both succeed, and no row-level lock has to be held across
 *     the surrounding transaction. A read-then-write in application code would lose that race.
 */
export interface MovementInput {
  companyId: string;
  productId: string;
  warehouseId: string;
  type: StockMovementType;
  /** Always positive. `type` decides the direction. */
  quantity: number;
  reference?: string | null;
  reason?: string | null;
  batchNumber?: string | null;
  performedById?: string | null;
  purchaseOrderId?: string | null;
  shipmentId?: string | null;
  /** For TRANSFER: the warehouse receiving the goods. */
  toWarehouseId?: string | null;
  occurredAt?: Date;
  isDemoData?: boolean;
}

type TxClient = Prisma.TransactionClient;

@Injectable()
export class InventoryLedgerService {
  private readonly logger = new Logger(InventoryLedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Applies a movement inside the caller's transaction. */
  async apply(tx: TxClient, input: MovementInput) {
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('La quantité du mouvement doit être un nombre positif');
    }

    switch (input.type) {
      case 'IN':
        return this.applyIn(tx, input);
      case 'OUT':
        return this.applyOut(tx, input);
      case 'ADJUSTMENT':
        return this.applyAdjustment(tx, input);
      case 'TRANSFER':
        return this.applyTransfer(tx, input);
      default:
        throw new BadRequestException(`Type de mouvement non pris en charge : ${input.type as string}`);
    }
  }

  /** Convenience wrapper for callers that have no transaction of their own. */
  async applyStandalone(input: MovementInput) {
    return this.prisma.$transaction((tx) => this.apply(tx, input));
  }

  private async ensureRow(tx: TxClient, input: MovementInput, warehouseId: string) {
    return tx.inventory.upsert({
      where: { productId_warehouseId: { productId: input.productId, warehouseId } },
      create: {
        companyId: input.companyId,
        productId: input.productId,
        warehouseId,
        availableStock: 0,
        isDemoData: input.isDemoData ?? false,
      },
      update: {},
    });
  }

  private async applyIn(tx: TxClient, input: MovementInput) {
    await this.ensureRow(tx, input, input.warehouseId);

    const updated = await tx.inventory.update({
      where: { productId_warehouseId: { productId: input.productId, warehouseId: input.warehouseId } },
      data: { availableStock: { increment: input.quantity } },
    });

    return this.writeLedger(tx, input, Number(updated.availableStock), input.warehouseId);
  }

  /**
   * Conditional decrement. `updateMany` with the quantity in the WHERE clause makes the check and
   * the write a single atomic statement; a count of 0 means another transaction got there first.
   */
  private async applyOut(tx: TxClient, input: MovementInput) {
    const result = await tx.inventory.updateMany({
      where: {
        productId: input.productId,
        warehouseId: input.warehouseId,
        availableStock: { gte: input.quantity },
      },
      data: { availableStock: { decrement: input.quantity } },
    });

    if (result.count === 0) {
      const current = await tx.inventory.findUnique({
        where: {
          productId_warehouseId: { productId: input.productId, warehouseId: input.warehouseId },
        },
        select: { availableStock: true },
      });
      throw new BadRequestException(
        `Stock insuffisant : quantité demandée ${input.quantity}, disponible ${Number(current?.availableStock ?? 0)}`,
      );
    }

    const updated = await tx.inventory.findUniqueOrThrow({
      where: { productId_warehouseId: { productId: input.productId, warehouseId: input.warehouseId } },
      select: { availableStock: true },
    });

    return this.writeLedger(tx, input, Number(updated.availableStock), input.warehouseId);
  }

  /**
   * A stock count correction. `quantity` is the *target* on-hand figure, not a delta — that is
   * what a physical count produces, and computing the delta here keeps the caller honest.
   */
  private async applyAdjustment(tx: TxClient, input: MovementInput) {
    const row = await this.ensureRow(tx, input, input.warehouseId);
    const before = Number(row.availableStock);
    const delta = input.quantity - before;

    const updated = await tx.inventory.update({
      where: { productId_warehouseId: { productId: input.productId, warehouseId: input.warehouseId } },
      data: { availableStock: input.quantity, lastCountedAt: new Date() },
    });

    return this.writeLedger(
      tx,
      {
        ...input,
        reason: input.reason ?? `Correction après inventaire (${delta >= 0 ? '+' : ''}${delta})`,
      },
      Number(updated.availableStock),
      input.warehouseId,
    );
  }

  /** Moves stock between two warehouses as one OUT + one IN, both recorded. */
  private async applyTransfer(tx: TxClient, input: MovementInput) {
    if (!input.toWarehouseId) {
      throw new BadRequestException('toWarehouseId est obligatoire pour un transfert (TRANSFER)');
    }
    if (input.toWarehouseId === input.warehouseId) {
      throw new BadRequestException('Impossible de transférer un produit vers l’entrepôt où il se trouve déjà');
    }

    const out = await this.applyOut(tx, {
      ...input,
      type: 'OUT',
      reason: input.reason ?? `Transfert sortant vers ${input.toWarehouseId}`,
    });
    const incoming = await this.applyIn(tx, {
      ...input,
      type: 'IN',
      warehouseId: input.toWarehouseId,
      reason: input.reason ?? `Transfert entrant depuis ${input.warehouseId}`,
    });

    return { out, in: incoming };
  }

  private async writeLedger(
    tx: TxClient,
    input: MovementInput,
    balanceAfter: number,
    warehouseId: string,
  ) {
    return tx.stockMovement.create({
      data: {
        companyId: input.companyId,
        productId: input.productId,
        warehouseId,
        toWarehouseId: input.toWarehouseId ?? null,
        type: input.type,
        quantity: input.quantity,
        balanceAfter,
        reference: input.reference ?? null,
        reason: input.reason ?? null,
        batchNumber: input.batchNumber ?? null,
        performedById: input.performedById ?? null,
        purchaseOrderId: input.purchaseOrderId ?? null,
        shipmentId: input.shipmentId ?? null,
        occurredAt: input.occurredAt ?? new Date(),
        isDemoData: input.isDemoData ?? false,
      },
    });
  }

  /**
   * Reserves stock for an order without moving it. Same conditional-update trick, but the
   * constraint that matters is `reservedStock <= availableStock`, which the database also
   * enforces as a CHECK — belt and braces, because double-promising stock is the single most
   * expensive bug in an inventory system.
   */
  async reserve(tx: TxClient, productId: string, warehouseId: string, quantity: number) {
    const result = await tx.$executeRaw`
      UPDATE "inventory"
         SET "reservedStock" = "reservedStock" + ${quantity}
       WHERE "productId" = ${productId}
         AND "warehouseId" = ${warehouseId}
         AND "availableStock" - "reservedStock" >= ${quantity}
    `;

    if (result === 0) {
      throw new BadRequestException(
        'Réservation impossible : stock non réservé insuffisant dans cet entrepôt',
      );
    }
  }

  async release(tx: TxClient, productId: string, warehouseId: string, quantity: number) {
    await tx.$executeRaw`
      UPDATE "inventory"
         SET "reservedStock" = GREATEST("reservedStock" - ${quantity}, 0)
       WHERE "productId" = ${productId}
         AND "warehouseId" = ${warehouseId}
    `;
  }

  /**
   * Tracks goods that are ordered but not yet received, so the reorder engine does not
   * double-order.
   *
   * The row is created if it does not exist. Confirming a purchase order for a product that has
   * never been stocked in that warehouse is completely ordinary — it is how a new SKU arrives —
   * and an UPDATE alone would silently affect zero rows, losing the inbound quantity and letting
   * the reorder engine recommend the same order again.
   */
  async adjustIncoming(
    tx: TxClient,
    productId: string,
    warehouseId: string,
    delta: number,
    companyId?: string,
  ) {
    const existing = await tx.inventory.findUnique({
      where: { productId_warehouseId: { productId, warehouseId } },
      select: { id: true },
    });

    if (!existing) {
      if (delta <= 0) return; // nothing to decrement; do not create an empty row for a no-op
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { companyId: true, isDemoData: true },
      });
      if (!product) return;

      await tx.inventory.create({
        data: {
          companyId: companyId ?? product.companyId,
          productId,
          warehouseId,
          availableStock: 0,
          incomingStock: delta,
          isDemoData: product.isDemoData,
        },
      });
      return;
    }

    await tx.$executeRaw`
      UPDATE "inventory"
         SET "incomingStock" = GREATEST("incomingStock" + ${delta}, 0)
       WHERE "productId" = ${productId}
         AND "warehouseId" = ${warehouseId}
    `;
  }
}
