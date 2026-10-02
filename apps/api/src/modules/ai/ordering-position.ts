/**
 * Which stock position the ordering decision of a product is made on.
 *
 * `inventory` is keyed by (product, warehouse) and the engines key on the product, so each
 * product gets one position:
 *
 * - the **site** view when a warehouse is below its own reorder point: that warehouse's stock,
 *   against that warehouse's demand. Stock held 250 km away does not serve its customers
 *   without a transfer, and summing it hid the shortage the Stocks screen was already flagging;
 * - the **network** view otherwise: everything summed, received where most of it sits. Sending
 *   one row per warehouse instead made the engine emit near-identical advice for the same SKU.
 */

export interface StockRow {
  productId: string;
  sku: string;
  warehouseId: string;
  warehouseName: string;
  availableStock: number;
  reservedStock: number;
  incomingStock: number;
  /** Units on orders for this warehouse that nobody has confirmed yet (draft, pending). */
  unconfirmedOrderStock: number;
  reorderPoint: number;
  unitCost: number;
  serviceLevel: number;
}

/** Mean and standard deviation of daily outbound quantity, in units. */
export interface DemandStats {
  mean: number;
  std: number;
}

export interface OrderingPosition {
  productId: string;
  sku: string;
  currentStock: number;
  reservedStock: number;
  incomingQuantity: number;
  unitCost: number;
  serviceLevel: number;
  /** Where an order for this position is received. */
  warehouseId: string;
  demand: DemandStats;
  /** Set when the position is one warehouse rather than the network. */
  site: { name: string; stockElsewhere: number } | null;
}

const NO_DEMAND: DemandStats = { mean: 0, std: 0 };

export const siteKey = (productId: string, warehouseId: string): string => `${productId}:${warehouseId}`;

/**
 * What is on order for the warehouse: confirmed orders (the ledger's incoming stock) and those
 * still awaiting confirmation. The draft raised by accepting an advice counts at once, otherwise
 * the same advice comes back until somebody confirms it.
 */
function onOrder(row: StockRow): number {
  return row.incomingStock + row.unconfirmedOrderStock;
}

/**
 * Below its reorder point even counting what is on order: the Stocks screen's rule
 * (`availableStock < reorderPoint`), plus the orders placed for the site.
 */
function isShort(row: StockRow): boolean {
  return row.reorderPoint > 0 && row.availableStock + onOrder(row) < row.reorderPoint;
}

export function orderingPositions(
  rows: readonly StockRow[],
  networkDemand: ReadonlyMap<string, DemandStats>,
  siteDemand: ReadonlyMap<string, DemandStats>,
): OrderingPosition[] {
  const byProduct = new Map<string, StockRow[]>();
  for (const row of rows) {
    const list = byProduct.get(row.productId);
    if (list) list.push(row);
    else byProduct.set(row.productId, [row]);
  }

  return [...byProduct.values()].map((productRows) => {
    const daysOfCover = (row: StockRow): number =>
      (row.availableStock + onOrder(row)) / (siteDemand.get(siteKey(row.productId, row.warehouseId))?.mean ?? 0);

    // A site with no outbound history has no demand to size an order against.
    const tightest = productRows
      .filter((row) => isShort(row) && (siteDemand.get(siteKey(row.productId, row.warehouseId))?.mean ?? 0) > 0)
      .sort((a, b) => daysOfCover(a) - daysOfCover(b))[0];

    const { productId, sku, unitCost, serviceLevel } = productRows[0];
    const total = (pick: (row: StockRow) => number): number => productRows.reduce((sum, row) => sum + pick(row), 0);

    if (tightest) {
      return {
        productId,
        sku,
        currentStock: tightest.availableStock,
        reservedStock: tightest.reservedStock,
        incomingQuantity: onOrder(tightest),
        unitCost,
        serviceLevel,
        warehouseId: tightest.warehouseId,
        demand: siteDemand.get(siteKey(productId, tightest.warehouseId)) ?? NO_DEMAND,
        site: {
          name: tightest.warehouseName,
          stockElsewhere: total((row) => row.availableStock) - tightest.availableStock,
        },
      };
    }

    const largest = productRows.reduce((best, row) => (row.availableStock > best.availableStock ? row : best));
    return {
      productId,
      sku,
      currentStock: total((row) => row.availableStock),
      reservedStock: total((row) => row.reservedStock),
      incomingQuantity: total(onOrder),
      unitCost,
      serviceLevel,
      warehouseId: largest.warehouseId,
      demand: networkDemand.get(productId) ?? NO_DEMAND,
      site: null,
    };
  });
}
