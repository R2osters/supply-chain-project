/**
 * DEMO DATA generator.
 *
 * Everything this script writes is tagged `isDemoData: true`, badged in the UI and excludable
 * from analytics. It is synthetic and it is never presented as real.
 *
 * It is also *statistically coherent*, which matters more than it sounds. A seed of random
 * numbers produces a system that looks populated and behaves like nonsense: forecasting picks a
 * naive model because there is no signal, safety stock explodes because variance is meaningless,
 * and supplier scores are noise. So the generator builds:
 *
 *   * demand with a real trend, a weekly rhythm, an annual season and occasional promotions —
 *     so the model comparison has something to distinguish;
 *   * suppliers whose *behaviour* matches their profile — the cheap one really is late more
 *     often, so the reliability score computed from their order history agrees with the story;
 *   * purchase orders across two years with delivery dates drawn from each supplier's own lead
 *     time distribution, so supplier performance is measured, not asserted;
 *   * shipments in flight along real Ghanaian corridors, so the live map and the ETA engine have
 *     something true to work with.
 *
 * Geography is West Africa (Accra, Kumasi, Takoradi, Tamale, Tema) because the brief's own
 * example uses Accra→Kumasi.
 *
 * Run: `npm run db:seed --workspace @scip/api`
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { hash, Algorithm } from '@node-rs/argon2';

const prisma = new PrismaClient();

const DAY_MS = 86_400_000;
const DEMO_PASSWORD = 'DemoPassw0rd!2026';

/* ------------------------------------------------------------------ utilities */

/**
 * Seeded PRNG (mulberry32). The seed must be deterministic: a demo whose numbers change on every
 * run makes it impossible to tell a code regression from a dice roll.
 */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = makeRandom(20260813);

const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
const between = (min: number, max: number): number => min + random() * (max - min);
const intBetween = (min: number, max: number): number => Math.floor(between(min, max + 1));

/** Box–Muller: a normal draw from two uniforms. */
function normal(mean: number, stdDev: number): number {
  const u1 = Math.max(random(), 1e-9);
  const u2 = random();
  return mean + stdDev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.15e-9).
 *
 * Needed to derive the lead time a supplier *quotes* from the on-time rate they actually hit.
 * A supplier whose true lead time is N(5, 1) days does not promise 5 days — they would then be
 * late half the time by construction. A supplier that hits 92 % promises the 92nd percentile of
 * their own distribution: 5 + z(0.92)·1 ≈ 6.4 days. Getting this wrong was the original bug in
 * this generator: every archetype measured ~50 % on time regardless of its profile, because the
 * promise was set at the mean.
 */
function inverseNormalCdf(p: number): number {
  if (p <= 0 || p >= 1) throw new Error(`inverseNormalCdf: p must be in (0,1), got ${p}`);

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * The lead time a supplier commits to on paper.
 * Set at the percentile of their own lead-time distribution that matches their on-time rate, so
 * "92 % on time" is a property the generated purchase orders actually exhibit.
 */
function quotedLeadTime(trueLeadTime: number, leadTimeStd: number, onTimeRate: number): number {
  return trueLeadTime + inverseNormalCdf(onTimeRate) * leadTimeStd;
}

const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS);
const daysAhead = (days: number): Date => new Date(Date.now() + days * DAY_MS);

/* ------------------------------------------------------------------ geography */

const CITIES = {
  accra: { name: 'Accra', latitude: 5.6037, longitude: -0.187 },
  tema: { name: 'Tema', latitude: 5.6698, longitude: -0.0166 },
  kumasi: { name: 'Kumasi', latitude: 6.6885, longitude: -1.6244 },
  takoradi: { name: 'Takoradi', latitude: 4.8845, longitude: -1.7554 },
  tamale: { name: 'Tamale', latitude: 9.4008, longitude: -0.8393 },
  capeCoast: { name: 'Cape Coast', latitude: 5.1053, longitude: -1.2466 },
  ho: { name: 'Ho', latitude: 6.6009, longitude: 0.4713 },
  sunyani: { name: 'Sunyani', latitude: 7.3349, longitude: -2.3123 },
} as const;

/** Waypoints follow the actual trunk roads, so the corridor is not a straight line on the map. */
const CORRIDORS = [
  {
    name: 'Accra → Kumasi (N6)',
    from: CITIES.accra,
    to: CITIES.kumasi,
    waypoints: [
      { latitude: 5.7, longitude: -0.35 },
      { latitude: 5.95, longitude: -0.72 },
      { latitude: 6.2, longitude: -1.05 },
      { latitude: 6.45, longitude: -1.35 },
    ],
    distanceKm: 250,
    durationMinutes: 300,
  },
  {
    name: 'Tema → Takoradi (N1)',
    from: CITIES.tema,
    to: CITIES.takoradi,
    waypoints: [
      { latitude: 5.55, longitude: -0.35 },
      { latitude: 5.35, longitude: -0.75 },
      { latitude: 5.15, longitude: -1.15 },
      { latitude: 5.0, longitude: -1.5 },
    ],
    distanceKm: 245,
    durationMinutes: 285,
  },
  {
    name: 'Kumasi → Tamale (N10)',
    from: CITIES.kumasi,
    to: CITIES.tamale,
    waypoints: [
      { latitude: 7.05, longitude: -1.6 },
      { latitude: 7.6, longitude: -1.45 },
      { latitude: 8.2, longitude: -1.2 },
      { latitude: 8.85, longitude: -0.98 },
    ],
    distanceKm: 380,
    durationMinutes: 450,
  },
  {
    name: 'Accra → Ho (N2)',
    from: CITIES.accra,
    to: CITIES.ho,
    waypoints: [
      { latitude: 5.8, longitude: 0.0 },
      { latitude: 6.1, longitude: 0.2 },
      { latitude: 6.4, longitude: 0.36 },
    ],
    distanceKm: 165,
    durationMinutes: 210,
  },
  {
    name: 'Accra → Cape Coast (N1)',
    from: CITIES.accra,
    to: CITIES.capeCoast,
    waypoints: [
      { latitude: 5.5, longitude: -0.45 },
      { latitude: 5.35, longitude: -0.75 },
      { latitude: 5.2, longitude: -1.0 },
    ],
    distanceKm: 145,
    durationMinutes: 180,
  },
] as const;

/* ------------------------------------------------------------- master catalogue */

const PRODUCTS = [
  { sku: 'SKU-001', name: 'Sorghum flour 25 kg', category: 'Dry goods', unitCost: 42, unitPrice: 58, weightKg: 25, baseDemand: 120, seasonality: 0.25, shelfLifeDays: 240 },
  { sku: 'SKU-002', name: 'Palm oil 20 L', category: 'Edible oils', unitCost: 88, unitPrice: 119, weightKg: 18.5, baseDemand: 65, seasonality: 0.15, shelfLifeDays: 365 },
  { sku: 'SKU-003', name: 'Rice, long grain 50 kg', category: 'Dry goods', unitCost: 210, unitPrice: 268, weightKg: 50, baseDemand: 95, seasonality: 0.35, shelfLifeDays: 540 },
  { sku: 'SKU-004', name: 'Evaporated milk, case of 48', category: 'Dairy', unitCost: 156, unitPrice: 205, weightKg: 22, baseDemand: 48, seasonality: 0.1, shelfLifeDays: 300 },
  { sku: 'SKU-005', name: 'Cocoa powder 10 kg', category: 'Dry goods', unitCost: 340, unitPrice: 430, weightKg: 10, baseDemand: 22, seasonality: 0.45, shelfLifeDays: 400 },
  { sku: 'SKU-006', name: 'Bottled water 12×1.5 L', category: 'Beverages', unitCost: 18, unitPrice: 26, weightKg: 18, baseDemand: 310, seasonality: 0.55, shelfLifeDays: 365 },
  { sku: 'SKU-007', name: 'Tomato paste, case of 24', category: 'Preserves', unitCost: 62, unitPrice: 84, weightKg: 14, baseDemand: 74, seasonality: 0.2, shelfLifeDays: 720 },
  { sku: 'SKU-008', name: 'Laundry soap, case of 36', category: 'Household', unitCost: 96, unitPrice: 132, weightKg: 16, baseDemand: 58, seasonality: 0.08, shelfLifeDays: null },
  { sku: 'SKU-009', name: 'Maize meal 25 kg', category: 'Dry goods', unitCost: 38, unitPrice: 52, weightKg: 25, baseDemand: 145, seasonality: 0.3, shelfLifeDays: 210 },
  { sku: 'SKU-010', name: 'Sugar 50 kg', category: 'Dry goods', unitCost: 175, unitPrice: 228, weightKg: 50, baseDemand: 68, seasonality: 0.22, shelfLifeDays: 730 },
] as const;

/**
 * Supplier archetypes.
 *
 * `trueOnTime`, `trueLeadTime` and `leadTimeStd` are the *generative* parameters: the purchase
 * orders below are drawn from them. The reliability the platform later computes is derived from
 * that order history, so the score is measured rather than copied from here. That is the point —
 * it makes the scoring engine testable against a known ground truth.
 */
const SUPPLIERS = [
  { code: 'SUP-A', name: 'Volta Grain Cooperative', country: 'GH', city: 'Ho', location: CITIES.ho, priceIndex: 1.0, trueLeadTime: 5, leadTimeStd: 1.0, trueOnTime: 0.92, trueQuality: 0.97, cancelRate: 0.02 },
  { code: 'SUP-B', name: 'Sahel Commodities Ltd', country: 'BF', city: 'Bolgatanga', location: { name: 'Bolgatanga', latitude: 10.7856, longitude: -0.8514 }, priceIndex: 0.8, trueLeadTime: 12, leadTimeStd: 4.5, trueOnTime: 0.75, trueQuality: 0.9, cancelRate: 0.08 },
  { code: 'SUP-C', name: 'Tema Port Distributors', country: 'GH', city: 'Tema', location: CITIES.tema, priceIndex: 1.1, trueLeadTime: 3, leadTimeStd: 0.6, trueOnTime: 0.97, trueQuality: 0.99, cancelRate: 0.01 },
  { code: 'SUP-D', name: 'Ashanti Wholesale Group', country: 'GH', city: 'Kumasi', location: CITIES.kumasi, priceIndex: 0.95, trueLeadTime: 7, leadTimeStd: 2.2, trueOnTime: 0.86, trueQuality: 0.95, cancelRate: 0.04 },
  { code: 'SUP-E', name: 'Abidjan Import Partners', country: 'CI', city: 'Abidjan', location: { name: 'Abidjan', latitude: 5.3599, longitude: -4.0083 }, priceIndex: 0.88, trueLeadTime: 14, leadTimeStd: 5.5, trueOnTime: 0.7, trueQuality: 0.88, cancelRate: 0.11 },
] as const;

const CUSTOMERS = [
  { code: 'CUS-001', name: 'Kumasi Retail Group', location: CITIES.kumasi, windowStart: 480, windowEnd: 1020 },
  { code: 'CUS-002', name: 'Takoradi Market Stores', location: CITIES.takoradi, windowStart: 420, windowEnd: 960 },
  { code: 'CUS-003', name: 'Tamale Provisions', location: CITIES.tamale, windowStart: 480, windowEnd: 1080 },
  { code: 'CUS-004', name: 'Cape Coast Grocers', location: CITIES.capeCoast, windowStart: 540, windowEnd: 1020 },
  { code: 'CUS-005', name: 'Ho Central Supermarket', location: CITIES.ho, windowStart: 480, windowEnd: 960 },
  { code: 'CUS-006', name: 'Sunyani Trading Co', location: CITIES.sunyani, windowStart: 420, windowEnd: 900 },
  { code: 'CUS-007', name: 'Tema Harbour Foods', location: CITIES.tema, windowStart: 360, windowEnd: 1200 },
  { code: 'CUS-008', name: 'Accra Central Depot', location: CITIES.accra, windowStart: 420, windowEnd: 1140 },
] as const;

const USERS = [
  { email: 'admin@demo-scip.com', firstName: 'Ama', lastName: 'Mensah', role: 'COMPANY_ADMIN' },
  { email: 'supplychain@demo-scip.com', firstName: 'Kofi', lastName: 'Asante', role: 'SUPPLY_CHAIN_MANAGER' },
  { email: 'logistics@demo-scip.com', firstName: 'Akua', lastName: 'Darko', role: 'LOGISTICS_MANAGER' },
  { email: 'procurement@demo-scip.com', firstName: 'Yaw', lastName: 'Oppong', role: 'PROCUREMENT_MANAGER' },
  { email: 'warehouse@demo-scip.com', firstName: 'Abena', lastName: 'Owusu', role: 'WAREHOUSE_MANAGER' },
  { email: 'driver@demo-scip.com', firstName: 'Kwame', lastName: 'Boateng', role: 'DRIVER' },
  { email: 'viewer@demo-scip.com', firstName: 'Efua', lastName: 'Sarpong', role: 'VIEWER' },
] as const;

/* ----------------------------------------------------------------- demand model */

/**
 * Daily demand for a product on a date.
 *
 * Deliberately layered so the forecasting comparison is a fair fight:
 *   trend      slow growth, which naive and moving-average models cannot follow;
 *   weekly     a working-week rhythm, which seasonal-naive captures and SES does not;
 *   annual     a seasonal wave, which Holt-Winters captures over a long enough history;
 *   promotion  occasional spikes, which nothing predicts — they are the irreducible error.
 */
function demandFor(
  product: (typeof PRODUCTS)[number],
  date: Date,
  dayIndex: number,
  totalDays: number,
): { quantity: number; promotion: boolean; holiday: boolean } {
  const trend = 1 + 0.25 * (dayIndex / totalDays);

  const weekday = date.getDay();
  // Sunday is quiet, Friday and Saturday are busy — an ordinary retail week.
  const weeklyFactor = [0.55, 0.95, 1.0, 1.0, 1.05, 1.25, 1.15][weekday];

  const dayOfYear = Math.floor(
    (date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / DAY_MS,
  );
  const annual = 1 + product.seasonality * Math.sin((2 * Math.PI * (dayOfYear - 60)) / 365);

  const promotion = random() < 0.03;
  const promotionFactor = promotion ? between(1.6, 2.4) : 1;

  const month = date.getMonth();
  const dayOfMonth = date.getDate();
  const holiday =
    (month === 11 && dayOfMonth >= 18) || (month === 0 && dayOfMonth <= 3) ||
    (month === 2 && dayOfMonth === 6); // Ghana Independence Day
  const holidayFactor = holiday ? between(1.3, 1.8) : 1;

  const base = product.baseDemand * trend * weeklyFactor * annual * promotionFactor * holidayFactor;
  // Multiplicative noise: bigger days are noisier in absolute terms, which is how demand behaves.
  const quantity = Math.max(0, Math.round(normal(base, base * 0.14)));

  return { quantity, promotion, holiday };
}

/* ------------------------------------------------------------------------ seed */

/**
 * Removes a demo company completely.
 *
 * A plain `company.delete()` is not enough. Three relations are deliberately `onDelete: Restrict`
 * — a purchase-order line and a shipment line both pin the product they reference, and a purchase
 * order pins its supplier — precisely so that nobody can delete a product that historical
 * documents depend on. That protection is correct in production and inconvenient exactly once,
 * here, so the restricted children are removed explicitly first and the company cascade handles
 * the rest.
 */
async function teardown(companyId: string): Promise<void> {
  // Voyages pin their ports with onDelete: Restrict, so they go before the company cascade.
  await prisma.vesselPosition.deleteMany({ where: { vessel: { companyId } } });
  await prisma.shipment.updateMany({ where: { companyId }, data: { voyageId: null } });
  await prisma.voyage.deleteMany({ where: { companyId } });
  await prisma.vessel.deleteMany({ where: { companyId } });
  await prisma.shipmentItem.deleteMany({ where: { shipment: { companyId } } });
  await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { companyId } } });
  await prisma.stockMovement.deleteMany({ where: { companyId } });
  await prisma.shipment.deleteMany({ where: { companyId } });
  await prisma.purchaseOrder.deleteMany({ where: { companyId } });
  await prisma.company.delete({ where: { id: companyId } });
}

async function main(): Promise<void> {
  console.log('SCIP seed — generating DEMO DATA\n');

  const existing = await prisma.company.findUnique({ where: { slug: 'demo-scip' } });
  if (existing) {
    console.log('Removing the previous demo company…');
    await teardown(existing.id);
  }

  const passwordHash = await hash(DEMO_PASSWORD, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  /* --------------------------------------------------------------- company */

  const company = await prisma.company.create({
    data: {
      name: 'Demo Distribution Ghana',
      slug: 'demo-scip',
      country: 'GH',
      city: 'Accra',
      addressLine: 'Ring Road Industrial Area, Accra',
      timezone: 'Africa/Accra',
      currency: 'GHS',
      contactEmail: 'admin@demo-scip.com',
      isDemoData: true,
    },
  });
  console.log(`Company: ${company.name}`);

  /* ----------------------------------------------------------------- users */

  const users = await Promise.all(
    USERS.map((user) =>
      prisma.user.create({
        data: {
          companyId: company.id,
          email: user.email,
          passwordHash,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role as Prisma.UserCreateInput['role'],
          emailVerifiedAt: new Date(),
          isDemoData: true,
        },
      }),
    ),
  );
  const adminUser = users[0];
  const driverUser = users.find((u) => u.role === 'DRIVER')!;
  console.log(`Users: ${users.length}`);

  /* ------------------------------------------------------------ categories */

  const categoryNames = [...new Set(PRODUCTS.map((p) => p.category))];
  const categories = await Promise.all(
    categoryNames.map((name) =>
      prisma.productCategory.create({ data: { companyId: company.id, name, isDemoData: true } }),
    ),
  );
  const categoryByName = new Map(categories.map((c) => [c.name, c]));

  /* -------------------------------------------------------------- products */

  const products = await Promise.all(
    PRODUCTS.map((product) =>
      prisma.product.create({
        data: {
          companyId: company.id,
          categoryId: categoryByName.get(product.category)?.id ?? null,
          sku: product.sku,
          name: product.name,
          unitOfMeasure: 'EA',
          unitCost: product.unitCost,
          unitPrice: product.unitPrice,
          currency: 'GHS',
          weightKg: product.weightKg,
          shelfLifeDays: product.shelfLifeDays,
          isPerishable: product.shelfLifeDays !== null && product.shelfLifeDays < 365,
          serviceLevel: 0.95,
          isDemoData: true,
        },
      }),
    ),
  );
  const productBySku = new Map(products.map((p) => [p.sku, p]));
  console.log(`Products: ${products.length}`);

  /* ------------------------------------------------------------ warehouses */

  const warehouses = await Promise.all(
    [
      { code: 'WH-ACC', name: 'Accra Central DC', city: CITIES.accra, capacity: 250_000 },
      { code: 'WH-KUM', name: 'Kumasi Regional DC', city: CITIES.kumasi, capacity: 120_000 },
      { code: 'WH-TAK', name: 'Takoradi Port Store', city: CITIES.takoradi, capacity: 80_000 },
    ].map((warehouse) =>
      prisma.warehouse.create({
        data: {
          companyId: company.id,
          code: warehouse.code,
          name: warehouse.name,
          country: 'GH',
          city: warehouse.city.name,
          latitude: warehouse.city.latitude,
          longitude: warehouse.city.longitude,
          capacityUnits: warehouse.capacity,
          geofenceRadiusM: 400,
          isDemoData: true,
        },
      }),
    ),
  );
  const mainWarehouse = warehouses[0];
  console.log(`Warehouses: ${warehouses.length}`);

  /* ------------------------------------------------------------- suppliers */

  const suppliers = await Promise.all(
    SUPPLIERS.map((supplier) =>
      prisma.supplier.create({
        data: {
          companyId: company.id,
          code: supplier.code,
          name: supplier.name,
          country: supplier.country,
          city: supplier.city,
          latitude: supplier.location.latitude,
          longitude: supplier.location.longitude,
          contactEmail: `orders@${supplier.code.toLowerCase()}.example`,
          quotedLeadTimeDays: Math.ceil(
            quotedLeadTime(supplier.trueLeadTime, supplier.leadTimeStd, supplier.trueOnTime),
          ),
          paymentTerms: 'NET_30',
          currency: 'GHS',
          isDemoData: true,
        },
      }),
    ),
  );
  const supplierByCode = new Map(suppliers.map((s) => [s.code, s]));
  console.log(`Suppliers: ${suppliers.length}`);

  // Price lists: each supplier carries a subset, priced from its own index. Supplier C (the
  // reliable one) is deliberately the dearest, so the allocator faces a real trade-off.
  const supplierProducts: Array<{ supplierCode: string; product: (typeof PRODUCTS)[number] }> = [];
  for (const product of PRODUCTS) {
    const carriers = SUPPLIERS.filter(() => random() < 0.65);
    const chosen = carriers.length >= 2 ? carriers : SUPPLIERS.slice(0, 3);

    for (const supplier of chosen) {
      await prisma.supplierProduct.create({
        data: {
          supplierId: supplierByCode.get(supplier.code)!.id,
          productId: productBySku.get(product.sku)!.id,
          unitPrice: Math.round(product.unitCost * supplier.priceIndex * 100) / 100,
          currency: 'GHS',
          minimumOrderQuantity: pick([0, 0, 100, 250, 500]),
          capacityPerCycle: Math.round(product.baseDemand * between(20, 60)),
          leadTimeDays: supplier.trueLeadTime,
          isPreferred: supplier.code === 'SUP-A',
          validFrom: daysAgo(760),
          isDemoData: true,
        },
      });
      supplierProducts.push({ supplierCode: supplier.code, product });
    }
  }
  console.log(`Supplier price rows: ${supplierProducts.length}`);

  /* -------------------------------------------------------------- partners */

  const customers = await Promise.all(
    CUSTOMERS.map((customer) =>
      prisma.customer.create({
        data: {
          companyId: company.id,
          code: customer.code,
          name: customer.name,
          country: 'GH',
          city: customer.location.name,
          latitude: customer.location.latitude,
          longitude: customer.location.longitude,
          windowStartMinutes: customer.windowStart,
          windowEndMinutes: customer.windowEnd,
          isDemoData: true,
        },
      }),
    ),
  );

  const carriers = await Promise.all(
    [
      { code: 'CAR-01', name: 'West Africa Freight', costPerKm: 3.1 },
      { code: 'CAR-02', name: 'Gold Coast Haulage', costPerKm: 2.85 },
      { code: 'CAR-03', name: 'Volta Transport Services', costPerKm: 3.4 },
    ].map((carrier) =>
      prisma.carrier.create({
        data: {
          companyId: company.id,
          code: carrier.code,
          name: carrier.name,
          country: 'GH',
          costPerKm: carrier.costPerKm,
          isDemoData: true,
        },
      }),
    ),
  );
  console.log(`Customers: ${customers.length}, carriers: ${carriers.length}`);

  /* ----------------------------------------------------------------- fleet */

  const vehicleTypes = ['TRUCK_LARGE', 'TRUCK_MEDIUM', 'TRUCK_SMALL', 'VAN', 'REFRIGERATED'] as const;
  const vehicles = await Promise.all(
    Array.from({ length: 12 }, (_, index) => {
      const type = vehicleTypes[index % vehicleTypes.length];
      const capacity = { TRUCK_LARGE: 2400, TRUCK_MEDIUM: 1400, TRUCK_SMALL: 700, VAN: 320, REFRIGERATED: 900 }[type];
      return prisma.vehicle.create({
        data: {
          companyId: company.id,
          carrierId: carriers[index % carriers.length].id,
          plateNumber: `GT-${1000 + index * 137}-2${4 + (index % 3)}`,
          label: `Truck ${index + 1}`,
          type,
          status: 'AVAILABLE',
          capacityUnits: capacity,
          capacityKg: capacity * 22,
          fuelConsumptionLPer100Km: between(22, 38),
          costPerKm: between(2.4, 3.8),
          nominalSpeedKmh: between(48, 68),
          isDemoData: true,
        },
      });
    }),
  );

  const drivers = await Promise.all(
    [
      { firstName: 'Kwame', lastName: 'Boateng', userId: driverUser.id },
      { firstName: 'Kojo', lastName: 'Antwi', userId: null },
      { firstName: 'Adjoa', lastName: 'Nkrumah', userId: null },
      { firstName: 'Kwabena', lastName: 'Osei', userId: null },
      { firstName: 'Esi', lastName: 'Amoah', userId: null },
      { firstName: 'Fiifi', lastName: 'Quaye', userId: null },
    ].map((driver, index) =>
      prisma.driver.create({
        data: {
          companyId: company.id,
          userId: driver.userId,
          carrierId: carriers[index % carriers.length].id,
          defaultVehicleId: vehicles[index].id,
          firstName: driver.firstName,
          lastName: driver.lastName,
          phone: `+2332${intBetween(10000000, 99999999)}`,
          licenseNumber: `GH-DL-${intBetween(100000, 999999)}`,
          isDemoData: true,
        },
      }),
    ),
  );
  console.log(`Vehicles: ${vehicles.length}, drivers: ${drivers.length}`);

  /* ---------------------------------------------------------------- routes */

  const routes = await Promise.all(
    CORRIDORS.map((corridor) => {
      const polyline = [
        { latitude: corridor.from.latitude, longitude: corridor.from.longitude },
        ...corridor.waypoints,
        { latitude: corridor.to.latitude, longitude: corridor.to.longitude },
      ];
      return prisma.route.create({
        data: {
          companyId: company.id,
          name: corridor.name,
          originLatitude: corridor.from.latitude,
          originLongitude: corridor.from.longitude,
          destinationLatitude: corridor.to.latitude,
          destinationLongitude: corridor.to.longitude,
          polyline: polyline as unknown as Prisma.InputJsonValue,
          distanceKm: corridor.distanceKm,
          durationMinutes: corridor.durationMinutes,
          corridorToleranceM: 3000,
          incidentRate: between(0.5, 4.5),
          tripsCompleted: intBetween(40, 400),
          isDemoData: true,
        },
      });
    }),
  );
  console.log(`Routes: ${routes.length}`);

  /* -------------------------------------------------- demand history (2 y) */

  const historyDays = 730;
  console.log(`Generating ${historyDays} days of demand history…`);

  const demandRows: Prisma.DemandHistoryCreateManyInput[] = [];
  const consumptionByProduct = new Map<string, number[]>();

  for (const productSpec of PRODUCTS) {
    const product = productBySku.get(productSpec.sku)!;
    const series: number[] = [];

    for (let dayIndex = 0; dayIndex < historyDays; dayIndex += 1) {
      const date = daysAgo(historyDays - dayIndex);
      date.setHours(0, 0, 0, 0);
      const { quantity, promotion, holiday } = demandFor(productSpec, date, dayIndex, historyDays);
      series.push(quantity);

      demandRows.push({
        companyId: company.id,
        productId: product.id,
        warehouseId: mainWarehouse.id,
        date,
        quantity,
        revenue: Math.round(quantity * productSpec.unitPrice * 100) / 100,
        unitPrice: productSpec.unitPrice,
        promotion,
        holiday,
        isDemoData: true,
      });
    }
    consumptionByProduct.set(product.id, series);
  }

  // createMany in chunks: a single 7 300-row insert works but a chunked one keeps the
  // statement size sane and gives progress that is visible if it ever slows down.
  for (let offset = 0; offset < demandRows.length; offset += 2000) {
    await prisma.demandHistory.createMany({
      data: demandRows.slice(offset, offset + 2000),
      skipDuplicates: true,
    });
  }
  console.log(`Demand history rows: ${demandRows.length}`);

  /* ------------------------------------------------------------- inventory */

  for (const productSpec of PRODUCTS) {
    const product = productBySku.get(productSpec.sku)!;

    for (const [index, warehouse] of warehouses.entries()) {
      // The main DC holds most of the stock; regional stores hold less.
      const share = index === 0 ? 0.6 : index === 1 ? 0.28 : 0.12;
      const daysOfCover = between(8, 45);
      const available = Math.round(productSpec.baseDemand * daysOfCover * share);

      // One product is deliberately left critically short so the recommendation engine has a
      // genuine ORDER_NOW to produce on a fresh install, and one is overstocked for the
      // REDUCE_INVENTORY path. Without them the demo shows an empty advice list.
      const critical = productSpec.sku === 'SKU-006' && index === 0;
      const overstocked = productSpec.sku === 'SKU-008' && index === 0;

      const stock = critical
        ? Math.round(productSpec.baseDemand * 2)
        : overstocked
          ? Math.round(productSpec.baseDemand * 200)
          : available;

      await prisma.inventory.create({
        data: {
          companyId: company.id,
          productId: product.id,
          warehouseId: warehouse.id,
          availableStock: stock,
          reservedStock: Math.round(stock * between(0, 0.08)),
          damagedStock: Math.round(stock * between(0, 0.01)),
          incomingStock: 0,
          safetyStock: Math.round(productSpec.baseDemand * share * between(2, 5)),
          reorderPoint: Math.round(productSpec.baseDemand * share * between(6, 12)),
          maxStock: Math.round(productSpec.baseDemand * share * 90),
          lastCountedAt: daysAgo(intBetween(1, 40)),
          isDemoData: true,
        },
      });
    }
  }
  console.log('Inventory positions created');

  /* ------------------------------------------- purchase orders + movements */

  console.log('Generating two years of purchase orders…');

  let orderSequence = 0;
  const movementRows: Prisma.StockMovementCreateManyInput[] = [];

  for (let weeksAgo = 104; weeksAgo >= 1; weeksAgo -= 1) {
    // Two to four orders a week, spread across suppliers.
    for (let n = 0; n < intBetween(2, 4); n += 1) {
      const supplierSpec = pick(SUPPLIERS);
      const supplier = supplierByCode.get(supplierSpec.code)!;

      const eligible = supplierProducts.filter((sp) => sp.supplierCode === supplierSpec.code);
      if (eligible.length === 0) continue;

      const lineCount = intBetween(1, 3);
      const chosen = [...new Set(Array.from({ length: lineCount }, () => pick(eligible).product))];

      const orderedAt = daysAgo(weeksAgo * 7 + intBetween(0, 6));

      // The promise is the supplier's own on-time percentile, not their mean — see
      // `quotedLeadTime`. Promising the mean would make every supplier late half the time.
      const promisedLeadTime = quotedLeadTime(
        supplierSpec.trueLeadTime,
        supplierSpec.leadTimeStd,
        supplierSpec.trueOnTime,
      );
      const expectedDelivery = new Date(orderedAt.getTime() + promisedLeadTime * DAY_MS);

      // Actual lead time is drawn from the supplier's own distribution — this is what makes the
      // computed reliability score agree with the archetype it came from.
      const actualLeadTime = Math.max(
        1,
        normal(supplierSpec.trueLeadTime, supplierSpec.leadTimeStd),
      );
      const actualDelivery = new Date(orderedAt.getTime() + actualLeadTime * DAY_MS);

      const cancelled = random() < supplierSpec.cancelRate;
      const delivered = !cancelled && actualDelivery.getTime() < Date.now();

      orderSequence += 1;
      const year = orderedAt.getFullYear();

      const items = chosen.map((productSpec) => {
        const product = productBySku.get(productSpec.sku)!;
        const quantity = Math.round(productSpec.baseDemand * between(10, 30));
        const unitPrice = Math.round(productSpec.unitCost * supplierSpec.priceIndex * 100) / 100;

        // Quality: a share of what arrives fails QC, drawn from the supplier's true rate.
        const received = delivered ? quantity : 0;
        const rejected = delivered ? Math.round(received * (1 - supplierSpec.trueQuality) * random() * 2) : 0;

        return {
          productId: product.id,
          quantity,
          receivedQuantity: received,
          rejectedQuantity: Math.min(rejected, received),
          unitPrice,
          lineTotal: Math.round(quantity * unitPrice * 100) / 100,
          isDemoData: true,
        };
      });

      const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);

      const order = await prisma.purchaseOrder.create({
        data: {
          companyId: company.id,
          supplierId: supplier.id,
          warehouseId: mainWarehouse.id,
          orderNumber: `PO-${year}-${String(orderSequence).padStart(4, '0')}`,
          status: cancelled ? 'CANCELLED' : delivered ? 'DELIVERED' : 'CONFIRMED',
          currency: 'GHS',
          subtotal,
          taxAmount: Math.round(subtotal * 0.125 * 100) / 100,
          shippingCost: Math.round(between(200, 1400) * 100) / 100,
          totalAmount: Math.round(subtotal * 1.125 * 100) / 100,
          orderedAt,
          expectedShippingDate: orderedAt,
          expectedDeliveryDate: expectedDelivery,
          actualDeliveryDate: delivered ? actualDelivery : null,
          confirmedAt: cancelled ? null : orderedAt,
          cancelledAt: cancelled ? new Date(orderedAt.getTime() + DAY_MS) : null,
          cancellationReason: cancelled ? 'Supplier could not fulfil within the agreed window' : null,
          createdById: adminUser.id,
          approvedById: cancelled ? null : adminUser.id,
          isDemoData: true,
          items: { create: items },
        },
      });

      if (delivered) {
        for (const item of items) {
          const accepted = item.receivedQuantity - item.rejectedQuantity;
          if (accepted <= 0) continue;
          movementRows.push({
            companyId: company.id,
            productId: item.productId,
            warehouseId: mainWarehouse.id,
            type: 'IN',
            quantity: accepted,
            balanceAfter: accepted, // historical reconstruction; live balances come from the ledger
            reference: order.orderNumber,
            reason: `Goods receipt for ${order.orderNumber}`,
            purchaseOrderId: order.id,
            occurredAt: actualDelivery,
            isDemoData: true,
          });
        }
      }
    }
  }
  console.log(`Purchase orders: ${orderSequence}`);

  /* --------------------------------------------- outbound movement history */

  // Outbound movements mirror the demand history for the last 180 days. This is what the risk
  // and recommendation engines read to derive mean and standard deviation of daily demand, so
  // it has to agree with `demand_history` rather than being independently random.
  for (const productSpec of PRODUCTS) {
    const product = productBySku.get(productSpec.sku)!;
    const series = consumptionByProduct.get(product.id)!;

    for (let dayIndex = historyDays - 180; dayIndex < historyDays; dayIndex += 1) {
      const quantity = series[dayIndex];
      if (quantity <= 0) continue;
      const occurredAt = daysAgo(historyDays - dayIndex);

      movementRows.push({
        companyId: company.id,
        productId: product.id,
        warehouseId: mainWarehouse.id,
        type: 'OUT',
        quantity,
        balanceAfter: 0,
        reason: 'Customer despatch',
        occurredAt,
        isDemoData: true,
      });
    }
  }

  for (let offset = 0; offset < movementRows.length; offset += 2000) {
    await prisma.stockMovement.createMany({
      data: movementRows.slice(offset, offset + 2000),
      skipDuplicates: true,
    });
  }
  console.log(`Stock movements: ${movementRows.length}`);

  /* ------------------------------------------------------------- shipments */

  console.log('Creating shipments…');

  const shipmentStatuses = [
    { status: 'DELIVERED', count: 40 },
    { status: 'IN_TRANSIT', count: 6 },
    { status: 'DEPARTED', count: 3 },
    { status: 'PLANNED', count: 4 },
    { status: 'DELAYED', count: 2 },
  ] as const;

  let shipmentIndex = 0;

  for (const bucket of shipmentStatuses) {
    for (let n = 0; n < bucket.count; n += 1) {
      shipmentIndex += 1;
      const route = pick(routes);
      const corridor = CORRIDORS.find((c) => c.name === route.name)!;
      const carrier = pick(carriers);
      const vehicle = vehicles[shipmentIndex % vehicles.length];
      const driver = drivers[shipmentIndex % drivers.length];
      const customer = pick(customers);

      const isHistorical = bucket.status === 'DELIVERED';

      // In-flight shipments depart a few minutes ago, not hours. The simulator places their
      // vehicle at the origin with zero progress, so backdating the departure by half a day
      // would put the promised arrival in the past before the truck has moved a metre — and the
      // ETA engine, working correctly, would immediately flag almost every one as DELAYED. The
      // demo should start coherent and go wrong for real reasons, not by construction.
      const plannedDeparture = isHistorical
        ? daysAgo(intBetween(2, 120))
        : bucket.status === 'PLANNED'
          ? daysAhead(intBetween(1, 5))
          : new Date(Date.now() - intBetween(2, 20) * 60_000);

      const plannedArrival = new Date(
        plannedDeparture.getTime() + corridor.durationMinutes * 60_000,
      );

      // Arrival is drawn relative to the promise, centred ~2 h early with a 2 h spread. That
      // puts about 84 % of deliveries on time, which is where competent road freight actually
      // sits. Centring on the promise itself — the obvious-looking choice — would make half of
      // every carrier's deliveries late by construction and produce a demo whose on-time rate
      // reads 41 %, which no operator would believe.
      const deliveredAt = isHistorical
        ? new Date(plannedArrival.getTime() + normal(-2.0, 2.0) * 3_600_000)
        : null;

      const items = Array.from({ length: intBetween(1, 4) }, () => pick(PRODUCTS))
        .filter((value, index, array) => array.indexOf(value) === index)
        .map((productSpec) => {
          const product = productBySku.get(productSpec.sku)!;
          const quantity = Math.round(productSpec.baseDemand * between(2, 8));
          return {
            productId: product.id,
            quantity,
            unitValue: productSpec.unitCost,
            isDemoData: true,
          };
        });

      const totalUnits = items.reduce((sum, item) => sum + item.quantity, 0);
      const cargoValue = items.reduce(
        (sum, item) => sum + item.quantity * Number(item.unitValue),
        0,
      );

      const shipment = await prisma.shipment.create({
        data: {
          companyId: company.id,
          carrierId: carrier.id,
          vehicleId: vehicle.id,
          driverId: driver.id,
          routeId: route.id,
          customerId: customer.id,
          originWarehouseId: mainWarehouse.id,
          trackingNumber: `SHP-DEMO-${String(shipmentIndex).padStart(4, '0')}`,
          status: bucket.status as Prisma.ShipmentCreateInput['status'],
          originName: corridor.from.name,
          originLatitude: corridor.from.latitude,
          originLongitude: corridor.from.longitude,
          destinationName: corridor.to.name,
          destinationLatitude: corridor.to.latitude,
          destinationLongitude: corridor.to.longitude,
          plannedDepartureAt: plannedDeparture,
          actualDepartureAt: bucket.status === 'PLANNED' ? null : plannedDeparture,
          plannedArrivalAt: plannedArrival,
          actualArrivalAt: deliveredAt,
          deliveredAt,
          plannedDistanceKm: corridor.distanceKm,
          travelledDistanceKm: isHistorical ? corridor.distanceKm * between(1.0, 1.08) : 0,
          totalUnits,
          cargoValue,
          currency: 'GHS',
          isDemoData: true,
          items: { create: items },
        },
      });

      await prisma.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          type: 'CREATED',
          description: `Shipment planned from ${corridor.from.name} to ${corridor.to.name}`,
          toStatus: bucket.status,
          occurredAt: plannedDeparture,
          isDemoData: true,
        },
      });

      if (isHistorical) {
        const delivery = await prisma.delivery.create({
          data: {
            companyId: company.id,
            shipmentId: shipment.id,
            customerId: customer.id,
            status: 'DELIVERED',
            assignedAt: plannedDeparture,
            pickedUpAt: plannedDeparture,
            arrivedAt: deliveredAt,
            deliveredAt,
            isDemoData: true,
          },
        });

        await prisma.proofOfDelivery.create({
          data: {
            deliveryId: delivery.id,
            receiverName: pick(['Kwesi Appiah', 'Adjoa Mensah', 'Yaw Owusu', 'Akosua Frimpong']),
            latitude: corridor.to.latitude + between(-0.002, 0.002),
            longitude: corridor.to.longitude + between(-0.002, 0.002),
            distanceToDestinationM: between(20, 320),
            capturedAt: deliveredAt!,
            isDemoData: true,
          },
        });
      } else if (bucket.status !== 'PLANNED') {
        // Vehicles on live shipments start at the origin; the simulator moves them from there.
        await prisma.vehicle.update({
          where: { id: vehicle.id },
          data: {
            status: 'IN_TRANSIT',
            lastLatitude: corridor.from.latitude,
            lastLongitude: corridor.from.longitude,
            lastSpeedKmh: 0,
            lastPositionAt: new Date(),
          },
        });
      }
    }
  }
  console.log(`Shipments: ${shipmentIndex}`);

  /* ------------------------------------------------------------- incidents */

  const incidentTypes = ['DELAY', 'VEHICLE_BREAKDOWN', 'DAMAGED_CARGO', 'CUSTOMS_DELAY', 'WEATHER'] as const;
  const deliveredShipments = await prisma.shipment.findMany({
    where: { companyId: company.id, status: 'DELIVERED' },
    take: 12,
  });

  for (const shipment of deliveredShipments.slice(0, 8)) {
    const type = pick(incidentTypes);
    const resolved = random() < 0.7;
    await prisma.incident.create({
      data: {
        companyId: company.id,
        shipmentId: shipment.id,
        type,
        severity: pick(['LOW', 'MEDIUM', 'MEDIUM', 'HIGH'] as const),
        status: resolved ? 'RESOLVED' : 'OPEN',
        title: {
          DELAY: 'Held at a checkpoint',
          VEHICLE_BREAKDOWN: 'Tyre blowout on the trunk road',
          DAMAGED_CARGO: 'Pallets shifted in transit',
          CUSTOMS_DELAY: 'Documentation query at the border',
          WEATHER: 'Heavy rain closed a section of the road',
        }[type],
        description: 'Recorded automatically as part of the demo dataset.',
        latitude: shipment.originLatitude + between(-0.4, 0.4),
        longitude: shipment.originLongitude + between(-0.4, 0.4),
        reportedById: users[2].id,
        resolution: resolved ? 'Cleared; the shipment continued to its destination.' : null,
        resolvedAt: resolved ? shipment.deliveredAt : null,
        estimatedCost: between(200, 4500),
        occurredAt: shipment.plannedDepartureAt,
        isDemoData: true,
      },
    });
  }
  console.log('Incidents created');

  /* -------------------------------------------------------------- maritime */

  const { seedMaritime } = await import('./seed-maritime');
  const maritime = await seedMaritime(prisma, company.id, true);
  console.log(
    `Maritime: ${maritime.ports} ports, ${maritime.vessels} vessels, ` +
      `${maritime.voyages} voyages, ${maritime.positions} position reports`,
  );

  /* ------------------------------------------------ supplier performance --- */

  // Recomputed here rather than hard-coded, so the score a user sees is genuinely derived from
  // the order history above — the same code path the API uses.
  const { computeSupplierReliability } = await import('../src/modules/suppliers/supplier-scoring');
  const { summariseOrders } = await import('../src/modules/suppliers/suppliers.service');

  for (const supplier of suppliers) {
    const orders = await prisma.purchaseOrder.findMany({
      where: { supplierId: supplier.id },
      include: { items: true },
    });
    const result = computeSupplierReliability(summariseOrders(orders));

    await prisma.supplier.update({
      where: { id: supplier.id },
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
  }

  const scored = await prisma.supplier.findMany({
    where: { companyId: company.id },
    select: { code: true, name: true, reliabilityScore: true, onTimeDeliveryRate: true },
    orderBy: { reliabilityScore: 'desc' },
  });

  console.log('\nSupplier reliability, computed from the generated order history:');
  for (const supplier of scored) {
    const truth = SUPPLIERS.find((s) => s.code === supplier.code);
    console.log(
      `  ${supplier.code} ${supplier.name.padEnd(28)} score ${supplier.reliabilityScore.toFixed(1).padStart(5)}  ` +
        `measured on-time ${(supplier.onTimeDeliveryRate * 100).toFixed(1)}%  ` +
        `(generated from ${((truth?.trueOnTime ?? 0) * 100).toFixed(0)}%)`,
    );
  }

  console.log(`
Seed complete — every row above is tagged DEMO DATA.

  Sign in at http://localhost:3000
    admin@demo-scip.com        COMPANY_ADMIN
    supplychain@demo-scip.com  SUPPLY_CHAIN_MANAGER
    logistics@demo-scip.com    LOGISTICS_MANAGER
    procurement@demo-scip.com  PROCUREMENT_MANAGER
    warehouse@demo-scip.com    WAREHOUSE_MANAGER
    driver@demo-scip.com       DRIVER
    viewer@demo-scip.com       VIEWER

  Password for all of them: ${DEMO_PASSWORD}

  SKU-006 is deliberately short and SKU-008 deliberately overstocked, so the
  recommendation engine has something real to say on a fresh install.
`);
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
