import { orderingPositions, siteKey, type DemandStats, type StockRow } from './ordering-position';

const row = (overrides: Partial<StockRow> & Pick<StockRow, 'warehouseId'>): StockRow => ({
  productId: 'p6',
  sku: 'SKU-006',
  warehouseName: overrides.warehouseId,
  availableStock: 0,
  reservedStock: 0,
  incomingStock: 0,
  unconfirmedOrderStock: 0,
  reorderPoint: 0,
  unitCost: 18,
  serviceLevel: 0.95,
  ...overrides,
});

const demand = (entries: Array<[string, DemandStats]>) => new Map(entries);

/** The demo: Accra short of water, Kumasi and Takoradi well stocked. */
const DEMO_ROWS: StockRow[] = [
  row({ warehouseId: 'acc', warehouseName: 'Accra Central DC', availableStock: 610, reservedStock: 10, reorderPoint: 1466 }),
  row({ warehouseId: 'kum', warehouseName: 'Kumasi Regional DC', availableStock: 3571, reservedStock: 70, reorderPoint: 869 }),
  row({ warehouseId: 'tak', warehouseName: 'Takoradi Port Store', availableStock: 1141, reservedStock: 16, reorderPoint: 247 }),
];
const NETWORK = demand([['p6', { mean: 480, std: 90 }]]);
const SITES = demand([
  [siteKey('p6', 'acc'), { mean: 320, std: 60 }],
  [siteKey('p6', 'kum'), { mean: 120, std: 30 }],
  [siteKey('p6', 'tak'), { mean: 40, std: 12 }],
]);

describe('orderingPositions', () => {
  it('judges a healthy product on the whole network, received where most of it sits', () => {
    const rows = DEMO_ROWS.map((r) => (r.warehouseId === 'acc' ? { ...r, availableStock: 4000 } : r));

    expect(orderingPositions(rows, NETWORK, SITES)).toEqual([
      {
        productId: 'p6',
        sku: 'SKU-006',
        currentStock: 4000 + 3571 + 1141,
        reservedStock: 10 + 70 + 16,
        incomingQuantity: 0,
        unitCost: 18,
        serviceLevel: 0.95,
        warehouseId: 'acc',
        demand: { mean: 480, std: 90 },
        site: null,
      },
    ]);
  });

  it('judges a product on the site that is below its reorder point, not on stock held elsewhere', () => {
    expect(orderingPositions(DEMO_ROWS, NETWORK, SITES)).toEqual([
      {
        productId: 'p6',
        sku: 'SKU-006',
        currentStock: 610,
        reservedStock: 10,
        incomingQuantity: 0,
        unitCost: 18,
        serviceLevel: 0.95,
        warehouseId: 'acc',
        demand: { mean: 320, std: 60 },
        site: { name: 'Accra Central DC', stockElsewhere: 3571 + 1141 },
      },
    ]);
  });

  it('stops singling a site out once an order on its way covers the gap', () => {
    const rows = DEMO_ROWS.map((r) => (r.warehouseId === 'acc' ? { ...r, incomingStock: 2500 } : r));

    const [position] = orderingPositions(rows, NETWORK, SITES);

    expect(position.site).toBeNull();
    expect(position.incomingQuantity).toBe(2500);
    expect(position.currentStock).toBe(610 + 3571 + 1141);
  });

  it('counts an order still awaiting confirmation, so accepted advice is not given twice', () => {
    // The draft raised by accepting the advice: not yet incoming stock in the ledger.
    const rows = DEMO_ROWS.map((r) => (r.warehouseId === 'acc' ? { ...r, unconfirmedOrderStock: 2963 } : r));

    const [position] = orderingPositions(rows, NETWORK, SITES);

    expect(position.site).toBeNull();
    expect(position.incomingQuantity).toBe(2963);
  });

  it('keeps the network view for a short site that has never shipped anything', () => {
    const sites = demand([[siteKey('p6', 'kum'), { mean: 120, std: 30 }]]);

    expect(orderingPositions(DEMO_ROWS, NETWORK, sites)[0].site).toBeNull();
  });

  it('picks the site that runs out first when several are short', () => {
    const rows = [
      row({ warehouseId: 'acc', warehouseName: 'Accra Central DC', availableStock: 900, reorderPoint: 1466 }),
      row({ warehouseId: 'tak', warehouseName: 'Takoradi Port Store', availableStock: 60, reorderPoint: 247 }),
    ];

    const [position] = orderingPositions(rows, NETWORK, SITES);

    // Accra: 900 / 320 = 2.8 days. Takoradi: 60 / 40 = 1.5 days.
    expect(position.warehouseId).toBe('tak');
    expect(position.site).toEqual({ name: 'Takoradi Port Store', stockElsewhere: 900 });
  });

  it('never calls a site short when no reorder point is set', () => {
    const rows = [row({ warehouseId: 'acc', availableStock: 5, reorderPoint: 0 })];

    expect(orderingPositions(rows, NETWORK, SITES)[0].site).toBeNull();
  });

  it('returns one position per product, with no demand when the ledger has none', () => {
    const rows = [
      ...DEMO_ROWS,
      row({ productId: 'p8', sku: 'SKU-008', warehouseId: 'acc', availableStock: 9000, reorderPoint: 400 }),
    ];

    const positions = orderingPositions(rows, NETWORK, SITES);

    expect(positions.map((p) => p.sku)).toEqual(['SKU-006', 'SKU-008']);
    expect(positions[1].demand).toEqual({ mean: 0, std: 0 });
  });
});
