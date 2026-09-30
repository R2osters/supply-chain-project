import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginated, type PaginatedResult, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { companyFilter, requireCompanyId } from '../../common/tenancy/tenant-scope';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { DOMAIN_EVENTS, DomainEventsService } from '../events/domain-events.service';
import { InventoryLedgerService } from './inventory-ledger.service';
import type {
  AlertQueryDto,
  InventoryQueryDto,
  ManualMovementDto,
  SetStockPolicyDto,
  StockAdjustmentDto,
  StockTransferDto,
} from './inventory.dto';

const DAY_MS = 86_400_000;

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: InventoryLedgerService,
    private readonly events: DomainEventsService,
  ) {}

  /* ----------------------------------------------------------------- reads */

  async list(user: AuthenticatedUser, query: InventoryQueryDto): Promise<PaginatedResult<unknown>> {
    const where: Prisma.InventoryWhereInput = {
      ...companyFilter(user),
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.search
        ? {
            product: {
              OR: [
                { sku: { contains: query.search, mode: 'insensitive' } },
                { name: { contains: query.search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
      ...(query.outOfStock ? { availableStock: { lte: 0 } } : {}),
    };

    // `availableStock < reorderPoint` compares two columns, which Prisma's filter language cannot
    // express; the id set is resolved with one raw query and fed back in.
    if (query.belowReorderPoint) {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "inventory"
         WHERE "companyId" = ${requireCompanyId(user)}
           AND "availableStock" < "reorderPoint"
      `;
      where.id = { in: rows.map((r) => r.id) };
    }

    const [data, total] = await Promise.all([
      this.prisma.inventory.findMany({
        where,
        include: {
          product: { select: { id: true, sku: true, name: true, unitCost: true, unitOfMeasure: true } },
          warehouse: { select: { id: true, code: true, name: true } },
        },
        orderBy: [{ warehouse: { code: 'asc' } }, { product: { sku: 'asc' } }],
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.inventory.count({ where }),
    ]);

    const enriched = data.map((row) => ({
      ...row,
      availableStock: Number(row.availableStock),
      reservedStock: Number(row.reservedStock),
      damagedStock: Number(row.damagedStock),
      incomingStock: Number(row.incomingStock),
      freeStock: Number(row.availableStock) - Number(row.reservedStock),
      value: round(Number(row.availableStock) * Number(row.product.unitCost), 2),
      belowReorderPoint: Number(row.availableStock) < Number(row.reorderPoint),
    }));

    return paginated(enriched, total, query);
  }

  /** Company-wide totals for the dashboard. Aggregated in SQL. */
  async valuation(user: AuthenticatedUser) {
    const companyId = requireCompanyId(user);
    const rows = await this.prisma.$queryRaw<
      Array<{
        total_value: number | null;
        total_units: number | null;
        distinct_skus: bigint;
        out_of_stock: bigint;
        below_reorder: bigint;
        overstock: bigint;
      }>
    >`
      SELECT COALESCE(SUM(i."availableStock" * p."unitCost"), 0)::double precision AS total_value,
             COALESCE(SUM(i."availableStock"), 0)::double precision                AS total_units,
             COUNT(DISTINCT i."productId")::bigint                                 AS distinct_skus,
             COUNT(*) FILTER (WHERE i."availableStock" <= 0)::bigint               AS out_of_stock,
             COUNT(*) FILTER (WHERE i."availableStock" < i."reorderPoint")::bigint AS below_reorder,
             COUNT(*) FILTER (WHERE i."maxStock" IS NOT NULL
                                AND i."availableStock" > i."maxStock")::bigint     AS overstock
        FROM "inventory" i
        JOIN "products" p ON p.id = i."productId"
       WHERE i."companyId" = ${companyId}
    `;

    const row = rows[0];
    return {
      inventoryValue: round(Number(row?.total_value ?? 0), 2),
      totalUnits: Number(row?.total_units ?? 0),
      distinctSkus: Number(row?.distinct_skus ?? 0),
      outOfStockRows: Number(row?.out_of_stock ?? 0),
      belowReorderPointRows: Number(row?.below_reorder ?? 0),
      overstockRows: Number(row?.overstock ?? 0),
    };
  }

  async movements(user: AuthenticatedUser, query: PaginationQueryDto, filters: {
    productId?: string;
    warehouseId?: string;
  }) {
    const where: Prisma.StockMovementWhereInput = {
      ...companyFilter(user),
      ...(filters.productId ? { productId: filters.productId } : {}),
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        include: {
          product: { select: { id: true, sku: true, name: true } },
          warehouse: { select: { id: true, code: true, name: true } },
          performedBy: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { occurredAt: query.order },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.stockMovement.count({ where }),
    ]);

    return paginated(data, total, query);
  }

  /* ---------------------------------------------------------------- writes */

  async adjust(user: AuthenticatedUser, dto: StockAdjustmentDto) {
    const companyId = requireCompanyId(user);
    await this.assertProductAndWarehouse(companyId, dto.productId, dto.warehouseId);

    const movement = await this.prisma.$transaction((tx) =>
      this.ledger.apply(tx, {
        companyId,
        productId: dto.productId,
        warehouseId: dto.warehouseId,
        type: 'ADJUSTMENT',
        quantity: dto.countedQuantity,
        reason: dto.reason,
        performedById: user.id,
      }),
    );

    await this.evaluateAlerts(companyId, dto.productId, dto.warehouseId);
    return movement;
  }

  async transfer(user: AuthenticatedUser, dto: StockTransferDto) {
    const companyId = requireCompanyId(user);
    await this.assertProductAndWarehouse(companyId, dto.productId, dto.fromWarehouseId);
    await this.assertProductAndWarehouse(companyId, dto.productId, dto.toWarehouseId, false);

    const result = await this.prisma.$transaction((tx) =>
      this.ledger.apply(tx, {
        companyId,
        productId: dto.productId,
        warehouseId: dto.fromWarehouseId,
        toWarehouseId: dto.toWarehouseId,
        type: 'TRANSFER',
        quantity: dto.quantity,
        reason: dto.reason ?? null,
        performedById: user.id,
      }),
    );

    await this.evaluateAlerts(companyId, dto.productId, dto.fromWarehouseId);
    await this.evaluateAlerts(companyId, dto.productId, dto.toWarehouseId);
    return result;
  }

  async manualMovement(user: AuthenticatedUser, dto: ManualMovementDto) {
    const companyId = requireCompanyId(user);
    await this.assertProductAndWarehouse(companyId, dto.productId, dto.warehouseId);

    const movement = await this.prisma.$transaction((tx) =>
      this.ledger.apply(tx, {
        companyId,
        productId: dto.productId,
        warehouseId: dto.warehouseId,
        type: dto.type,
        quantity: dto.quantity,
        reason: dto.reason ?? 'Mouvement manuel',
        batchNumber: dto.batchNumber ?? null,
        performedById: user.id,
      }),
    );

    await this.evaluateAlerts(companyId, dto.productId, dto.warehouseId);
    return movement;
  }

  async setPolicy(user: AuthenticatedUser, dto: SetStockPolicyDto) {
    const companyId = requireCompanyId(user);
    await this.assertProductAndWarehouse(companyId, dto.productId, dto.warehouseId, false);

    if (dto.maxStock !== undefined && dto.maxStock < dto.reorderPoint) {
      throw new BadRequestException('Le stock maximum (maxStock) ne peut pas être inférieur au point de commande');
    }
    if (dto.reorderPoint < dto.safetyStock) {
      throw new BadRequestException(
        'Le point de commande doit être au moins égal au stock de sécurité — ne commander qu’une fois la réserve épuisée garantit une rupture pendant le délai d’approvisionnement',
      );
    }

    const row = await this.prisma.inventory.upsert({
      where: { productId_warehouseId: { productId: dto.productId, warehouseId: dto.warehouseId } },
      create: {
        companyId,
        productId: dto.productId,
        warehouseId: dto.warehouseId,
        safetyStock: dto.safetyStock,
        reorderPoint: dto.reorderPoint,
        maxStock: dto.maxStock ?? null,
      },
      update: {
        safetyStock: dto.safetyStock,
        reorderPoint: dto.reorderPoint,
        maxStock: dto.maxStock ?? null,
      },
    });

    await this.evaluateAlerts(companyId, dto.productId, dto.warehouseId);
    return row;
  }

  private async assertProductAndWarehouse(
    companyId: string,
    productId: string,
    warehouseId: string,
    requireExistingRow = true,
  ) {
    const [product, warehouse] = await Promise.all([
      this.prisma.product.findFirst({ where: { id: productId, companyId } }),
      this.prisma.warehouse.findFirst({ where: { id: warehouseId, companyId } }),
    ]);
    if (!product) throw new NotFoundException('Produit introuvable dans votre entreprise');
    if (!warehouse) throw new NotFoundException('Entrepôt introuvable dans votre entreprise');

    if (requireExistingRow) {
      const row = await this.prisma.inventory.findUnique({
        where: { productId_warehouseId: { productId, warehouseId } },
      });
      if (!row) {
        throw new NotFoundException(
          `${product.sku} n’a pas de fiche de stock dans ${warehouse.code}. Réceptionnez du stock ou définissez d’abord une politique de stock.`,
        );
      }
    }
  }

  /* ---------------------------------------------------------------- alerts */

  /**
   * Re-evaluates the alert state of one product/warehouse pair.
   *
   * Alerts are *stateful*, not fire-and-forget: an existing open alert of the same type is left
   * alone rather than duplicated, and it is auto-resolved when the condition clears. Without
   * that, a product hovering at its reorder point would generate an alert on every movement and
   * the alert list would become unreadable — which is how alerting systems get ignored.
   */
  async evaluateAlerts(companyId: string, productId: string, warehouseId: string): Promise<void> {
    const row = await this.prisma.inventory.findUnique({
      where: { productId_warehouseId: { productId, warehouseId } },
      include: { product: { select: { sku: true, name: true, shelfLifeDays: true, isPerishable: true } } },
    });
    if (!row) return;

    const available = Number(row.availableStock);
    const reorderPoint = Number(row.reorderPoint);
    const maxStock = row.maxStock === null ? null : Number(row.maxStock);

    const conditions: Array<{
      type: 'OUT_OF_STOCK' | 'LOW_STOCK' | 'OVERSTOCK';
      active: boolean;
      severity: string;
      message: string;
      threshold: number;
    }> = [
      {
        type: 'OUT_OF_STOCK',
        active: available <= 0,
        severity: 'CRITICAL',
        message: `${row.product.sku} est en rupture de stock`,
        threshold: 0,
      },
      {
        // Suppressed while OUT_OF_STOCK is active — two alerts for one problem is noise.
        type: 'LOW_STOCK',
        active: available > 0 && reorderPoint > 0 && available < reorderPoint,
        severity: 'HIGH',
        message: `${row.product.sku} est sous son point de commande (${available} < ${reorderPoint})`,
        threshold: reorderPoint,
      },
      {
        type: 'OVERSTOCK',
        active: maxStock !== null && available > maxStock,
        severity: 'LOW',
        message: `${row.product.sku} dépasse son stock maximum (${available} > ${maxStock})`,
        threshold: maxStock ?? 0,
      },
    ];

    for (const condition of conditions) {
      const open = await this.prisma.inventoryAlert.findFirst({
        where: { companyId, productId, warehouseId, type: condition.type, resolvedAt: null },
      });

      if (condition.active && !open) {
        await this.prisma.inventoryAlert.create({
          data: {
            companyId,
            productId,
            warehouseId,
            type: condition.type,
            severity: condition.severity,
            message: condition.message,
            currentValue: available,
            threshold: condition.threshold,
            isDemoData: row.isDemoData,
          },
        });

        if (condition.type === 'OUT_OF_STOCK' || condition.type === 'LOW_STOCK') {
          await this.events.publishStandalone({
            companyId,
            type:
              condition.type === 'OUT_OF_STOCK'
                ? DOMAIN_EVENTS.STOCK_OUT
                : DOMAIN_EVENTS.STOCK_BELOW_REORDER,
            subjectType: 'PRODUCT',
            subjectId: productId,
            payload: { warehouseId, available, reorderPoint, sku: row.product.sku },
          });
        }
      } else if (!condition.active && open) {
        await this.prisma.inventoryAlert.update({
          where: { id: open.id },
          data: { resolvedAt: new Date() },
        });
      }
    }
  }

  /** Expiry sweep — separate from the level checks because it is batch-driven, not row-driven. */
  async evaluateExpiryAlerts(companyId: string, horizonDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() + horizonDays * DAY_MS);

    const batches = await this.prisma.inventoryBatch.findMany({
      where: {
        quantity: { gt: 0 },
        expiryDate: { not: null, lte: cutoff },
        product: { companyId },
      },
      include: { product: { select: { id: true, sku: true } } },
    });

    let created = 0;
    for (const batch of batches) {
      const open = await this.prisma.inventoryAlert.findFirst({
        where: {
          companyId,
          productId: batch.productId,
          type: 'EXPIRING_SOON',
          resolvedAt: null,
          message: { contains: batch.batchNumber },
        },
      });
      if (open) continue;

      const daysLeft = Math.ceil((batch.expiryDate!.getTime() - Date.now()) / DAY_MS);
      await this.prisma.inventoryAlert.create({
        data: {
          companyId,
          productId: batch.productId,
          warehouseId: batch.warehouseId,
          type: 'EXPIRING_SOON',
          severity: daysLeft <= 7 ? 'HIGH' : 'MEDIUM',
          // The batch number must stay in this text: the lookup above dedupes on it.
          message:
            `${batch.product.sku} : le lot ${batch.batchNumber} expire dans ${daysLeft} ` +
            `${Math.abs(daysLeft) > 1 ? 'jours' : 'jour'}`,
          currentValue: Number(batch.quantity),
          threshold: horizonDays,
          isDemoData: batch.isDemoData,
        },
      });
      created += 1;
    }
    return created;
  }

  async listAlerts(user: AuthenticatedUser, query: AlertQueryDto) {
    const where: Prisma.InventoryAlertWhereInput = {
      ...companyFilter(user),
      ...(query.type ? { type: query.type } : {}),
      ...(query.includeResolved ? {} : { resolvedAt: null }),
    };

    const [data, total] = await Promise.all([
      this.prisma.inventoryAlert.findMany({
        where,
        include: { product: { select: { id: true, sku: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.inventoryAlert.count({ where }),
    ]);

    return paginated(data, total, query);
  }

  /** Full company sweep, used by the nightly job and after a bulk import. */
  async sweepAlerts(user: AuthenticatedUser) {
    const companyId = requireCompanyId(user);
    const rows = await this.prisma.inventory.findMany({
      where: { companyId },
      select: { productId: true, warehouseId: true },
    });

    for (const row of rows) {
      await this.evaluateAlerts(companyId, row.productId, row.warehouseId);
    }
    const expiring = await this.evaluateExpiryAlerts(companyId);

    const open = await this.prisma.inventoryAlert.count({ where: { companyId, resolvedAt: null } });
    return { rowsEvaluated: rows.length, expiringAlertsCreated: expiring, openAlerts: open };
  }
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
