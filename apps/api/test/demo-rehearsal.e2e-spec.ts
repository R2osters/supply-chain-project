/**
 * Demo rehearsal against the real database holding the demo data set.
 *
 *   npm run db:migrate:deploy --workspace @scip/api
 *   npm run db:seed --workspace @scip/api
 *   npm run test:e2e --workspace @scip/api -- demo-rehearsal
 *
 * Unlike app.e2e-spec.ts this suite changes the demo company: rehearsing is exactly that. It
 * leaves the demo staged as a rehearsal would, so run it on a demo database only.
 *
 * The part worth a real database is the chain the demo relies on: the rehearsal writes an
 * impossible promise, and the unmodified ETA engine must then find those two shipments late, and
 * only those two.
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { AuditInterceptor } from '../src/common/interceptors/audit.interceptor';
import { PrismaService } from '../src/prisma/prisma.service';
import { DOMAIN_EVENTS } from '../src/modules/events/domain-events.service';
import { ShipmentsService } from '../src/modules/shipments/shipments.service';
import { RECOMMENDATION_ORDER_NOTE } from '../src/modules/recommendations/recommendations.service';
import { DELAYED_PROMISE_MS, stagedArrival, stagedRouteKm } from '../src/modules/setup/demo-rehearsal.service';

// The seed's demo accounts (prisma/seed.ts).
const DEMO_PASSWORD = 'DemoPassw0rd!2026';
const LATE = ['SHP-DEMO-0054', 'SHP-DEMO-0055'];

describe('POST /setup/demo/rehearse (e2e, demo database)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;
  let adminToken: string;
  let companyId: string;

  const login = async (email: string) =>
    (await http.post('/api/v1/auth/login').send({ email, password: DEMO_PASSWORD }).expect(200)).body
      .accessToken as string;

  beforeAll(async () => {
    // The simulator would move the trucks while the assertions read them.
    process.env.SIMULATOR_ENABLED = 'false';
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    // As main.ts does: the route's audit trail is part of what is tested.
    app.useGlobalInterceptors(new AuditInterceptor(app.get(Reflector), app.get(PrismaService)));
    await app.init();

    prisma = app.get(PrismaService);
    http = request(app.getHttpServer());
    adminToken = await login('admin@demo-scip.com');
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo-scip.com' } });
    companyId = admin.companyId as string;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('refuses a user without the company:update permission', async () => {
    const viewer = await login('viewer@demo-scip.com');
    await http.post('/api/v1/setup/demo/rehearse').set({ Authorization: `Bearer ${viewer}` }).expect(403);
  });

  it('stages the demo again, starting now', async () => {
    // What an earlier demo leaves behind: a finished trip with its track, an order accepted from
    // a recommendation and still open, and advice nobody acted on.
    const arrived = await prisma.shipment.findFirstOrThrow({ where: { companyId, trackingNumber: 'SHP-DEMO-0041' } });
    await prisma.shipment.update({
      where: { id: arrived.id },
      data: { status: 'ARRIVED', actualArrivalAt: new Date() },
    });
    await prisma.gpsPosition.create({
      data: {
        vehicleId: arrived.vehicleId as string,
        shipmentId: arrived.id,
        latitude: arrived.destinationLatitude,
        longitude: arrived.destinationLongitude,
        speedKmh: 0,
        isSimulated: true,
        recordedAt: new Date(),
      },
    });
    const sku = await prisma.product.findFirstOrThrow({ where: { companyId, sku: 'SKU-006' } });
    const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { companyId, code: 'WH-ACC' } });
    const supplier = await prisma.supplier.findFirstOrThrow({ where: { companyId } });
    const order = await prisma.purchaseOrder.create({
      data: {
        companyId,
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        orderNumber: `PO-REHEARSAL-${Date.now()}`,
        status: 'CONFIRMED',
        notes: RECOMMENDATION_ORDER_NOTE,
        subtotal: 0,
        totalAmount: 0,
        isDemoData: true,
        items: { create: [{ productId: sku.id, quantity: 900, unitPrice: 18, lineTotal: 16_200, isDemoData: true }] },
      },
    });
    await prisma.inventory.update({
      where: { productId_warehouseId: { productId: sku.id, warehouseId: warehouse.id } },
      data: { availableStock: 5000, incomingStock: 900 },
    });
    await prisma.recommendation.create({
      data: {
        companyId,
        type: 'ORDER_NOW',
        title: 'Left over from a previous demo',
        subjectType: 'PRODUCT',
        subjectId: sku.id,
        explanation: { summary: 'test', reasons: ['test'], assumptions: [] },
        isDemoData: true,
      },
    });

    const before = Date.now();
    const response = await http
      .post('/api/v1/setup/demo/rehearse')
      .set({ Authorization: `Bearer ${adminToken}` })
      .expect(200);

    expect(response.body).toMatchObject({ shipments: 11, delayedSoon: LATE, inventoryReset: true });
    expect(response.body.cancelledOrders).toContain(order.orderNumber);
    expect(response.body.clearedRecommendations).toBeGreaterThanOrEqual(1);

    const staged = await prisma.shipment.findMany({
      where: { companyId, trackingNumber: { gte: 'SHP-DEMO-0041', lte: 'SHP-DEMO-0055' } },
      include: { route: true, vehicle: true },
      orderBy: { trackingNumber: 'asc' },
    });
    const live = staged.filter((shipment) => shipment.status !== 'PLANNED');
    expect(live).toHaveLength(11);
    expect(staged.filter((shipment) => shipment.status === 'PLANNED')).toHaveLength(4);

    for (const shipment of live) {
      expect(shipment.status).toBe('IN_TRANSIT');
      expect(shipment.actualArrivalAt).toBeNull();
      expect(shipment.plannedDepartureAt.getTime()).toBeGreaterThanOrEqual(before);
      const promise = LATE.includes(shipment.trackingNumber)
        ? shipment.plannedDepartureAt.getTime() + DELAYED_PROMISE_MS
        : stagedArrival(
            shipment.plannedDepartureAt,
            stagedRouteKm(shipment.route, shipment.plannedDistanceKm),
            shipment.vehicle?.nominalSpeedKmh,
            false,
          ).getTime();
      expect(shipment.plannedArrivalAt.getTime()).toBe(promise);
      expect(shipment.vehicle?.lastLatitude).toBe(shipment.originLatitude);
      expect(shipment.vehicle?.lastLongitude).toBe(shipment.originLongitude);
    }
    // One truck per live shipment, so no marker jumps between two routes.
    expect(new Set(live.map((shipment) => shipment.vehicleId)).size).toBe(11);
    expect(await prisma.gpsPosition.count({ where: { shipmentId: { in: live.map((s) => s.id) } } })).toBe(0);

    const stock = await prisma.inventory.findUniqueOrThrow({
      where: { productId_warehouseId: { productId: sku.id, warehouseId: warehouse.id } },
    });
    expect(Number(stock.availableStock)).toBe(620);
    expect(Number(stock.incomingStock)).toBe(0);
    expect(
      await prisma.stockMovement.count({
        where: { productId: sku.id, warehouseId: warehouse.id, reason: 'Demo rehearsal: two days of demand on hand' },
      }),
    ).toBeGreaterThanOrEqual(1);

    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
    expect(await prisma.recommendation.count({ where: { companyId, status: 'OPEN' } })).toBe(0);
    // The audit row is written after the response, without holding it up.
    const audited = () =>
      prisma.auditLog.count({ where: { action: 'setup.demo.rehearse', companyId, createdAt: { gte: new Date(before) } } });
    for (let attempt = 0; attempt < 20 && (await audited()) === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await audited()).toBe(1);
  });

  it('lets the ETA engine find 0054 and 0055 late, and only them', async () => {
    const shipments = app.get(ShipmentsService);
    const live = await prisma.shipment.findMany({
      where: { companyId, trackingNumber: { gte: 'SHP-DEMO-0041', lte: 'SHP-DEMO-0055' }, status: 'IN_TRANSIT' },
    });
    const since = new Date();
    for (const shipment of live) await shipments.computeCurrentEta(shipment.id);

    const after = await prisma.shipment.findMany({
      where: { id: { in: live.map((shipment) => shipment.id) } },
      include: { events: { where: { type: 'DELAY_DETECTED', occurredAt: { gte: since } } } },
    });
    const late = after.filter((shipment) => shipment.status === 'DELAYED').map((s) => s.trackingNumber).sort();
    expect(late).toEqual(LATE);
    for (const shipment of after) {
      expect(shipment.events).toHaveLength(LATE.includes(shipment.trackingNumber) ? 1 : 0);
    }
    const published = await prisma.domainEvent.findMany({
      where: { companyId, type: DOMAIN_EVENTS.SHIPMENT_DELAYED, createdAt: { gte: since } },
    });
    expect(published.map((event) => event.subjectId).sort()).toEqual(
      after.filter((shipment) => LATE.includes(shipment.trackingNumber)).map((s) => s.id).sort(),
    );
  });

  it('can be run again: the demo is staged afresh each time', async () => {
    const response = await http
      .post('/api/v1/setup/demo/rehearse')
      .set({ Authorization: `Bearer ${adminToken}` })
      .expect(200);
    expect(response.body).toMatchObject({ shipments: 11, delayedSoon: LATE, inventoryReset: true });
    expect(
      await prisma.shipment.count({
        where: { companyId, trackingNumber: { in: LATE }, status: 'IN_TRANSIT' },
      }),
    ).toBe(2);
  });
});
