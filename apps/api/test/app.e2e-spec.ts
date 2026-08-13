/**
 * End-to-end tests against a running stack.
 *
 * These boot the real Nest application against the real database rather than mocking Prisma,
 * because the properties worth testing here — tenant isolation, the RBAC matrix, the purchase-order
 * state machine, concurrent stock decrements — are properties of the *system*, and every one of
 * them would pass trivially against a mock.
 *
 *   docker compose up -d postgres redis
 *   npm run db:migrate:deploy --workspace @scip/api
 *   npm run db:seed --workspace @scip/api
 *   npm run test:e2e --workspace @scip/api
 *
 * The suite creates its own tenant with a unique slug and tears it down afterwards, so it can run
 * against a database that already holds the demo company without disturbing it.
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

const STRONG_PASSWORD = 'E2e-Passphrase!2026';
const stamp = Date.now();

interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; role: string; companyId: string };
}

describe('SCIP API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  let owner: Session;
  let companyId: string;
  const created: { companies: string[] } = { companies: [] };

  const auth = (session: Session) => ({ Authorization: `Bearer ${session.accessToken}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    // Mirror main.ts, or the tests would exercise a differently-configured app than production.
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    http = request(app.getHttpServer());

    const response = await http
      .post('/api/v1/auth/register')
      .send({
        email: `e2e-owner-${stamp}@example.test`,
        password: STRONG_PASSWORD,
        firstName: 'Eve',
        lastName: 'Owner',
        companyName: `E2E Tenant ${stamp}`,
        companyCountry: 'GH',
      })
      .expect(201);

    owner = response.body;
    companyId = owner.user.companyId;
    created.companies.push(companyId);
  });

  afterAll(async () => {
    for (const id of created.companies) {
      await prisma.shipmentItem.deleteMany({ where: { shipment: { companyId: id } } });
      await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { companyId: id } } });
      await prisma.stockMovement.deleteMany({ where: { companyId: id } });
      await prisma.shipment.deleteMany({ where: { companyId: id } });
      await prisma.purchaseOrder.deleteMany({ where: { companyId: id } });
      await prisma.company.delete({ where: { id } }).catch(() => undefined);
    }
    await app.close();
  });

  /* ====================================================================== auth */

  describe('authentication', () => {
    it('registers a company with its first administrator', () => {
      expect(owner.accessToken).toBeTruthy();
      expect(owner.user.role).toBe('COMPANY_ADMIN');
      expect(owner.user.companyId).toBeTruthy();
    });

    it('refuses a weak password', () =>
      http
        .post('/api/v1/auth/register')
        .send({
          email: `weak-${stamp}@example.test`,
          password: 'short',
          firstName: 'A',
          lastName: 'B',
          companyName: 'Weak',
          companyCountry: 'GH',
        })
        .expect(400));

    it('refuses a duplicate email', () =>
      http
        .post('/api/v1/auth/register')
        .send({
          email: owner.user.email,
          password: STRONG_PASSWORD,
          firstName: 'A',
          lastName: 'B',
          companyName: 'Duplicate',
          companyCountry: 'GH',
        })
        .expect(409));

    it('rejects a wrong password without revealing whether the account exists', async () => {
      const unknown = await http
        .post('/api/v1/auth/login')
        .send({ email: `nobody-${stamp}@example.test`, password: STRONG_PASSWORD })
        .expect(401);
      const wrong = await http
        .post('/api/v1/auth/login')
        .send({ email: owner.user.email, password: 'Wrong-Passphrase!2026' })
        .expect(401);

      expect(unknown.body.message).toBe(wrong.body.message);
    });

    it('rejects an unauthenticated request', () => http.get('/api/v1/shipments').expect(401));

    it('rejects a malformed token', () =>
      http.get('/api/v1/shipments').set({ Authorization: 'Bearer not-a-jwt' }).expect(401));

    it('rotates a refresh token and revokes the old one', async () => {
      const login = await http
        .post('/api/v1/auth/login')
        .send({ email: owner.user.email, password: STRONG_PASSWORD })
        .expect(200);

      const first = login.body.refreshToken;
      const rotated = await http.post('/api/v1/auth/refresh').send({ refreshToken: first }).expect(200);

      expect(rotated.body.refreshToken).not.toBe(first);

      // Replaying the rotated token is the reuse-detection path.
      await http.post('/api/v1/auth/refresh').send({ refreshToken: first }).expect(401);
      // …and it burns the family, so the token issued from it is dead too.
      await http
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: rotated.body.refreshToken })
        .expect(401);
    });

    it('strips undeclared fields instead of trusting them', () =>
      // `role` is not on RegisterDto: forbidNonWhitelisted must reject rather than escalate.
      http
        .post('/api/v1/auth/register')
        .send({
          email: `escalate-${stamp}@example.test`,
          password: STRONG_PASSWORD,
          firstName: 'A',
          lastName: 'B',
          companyName: 'Escalation',
          companyCountry: 'GH',
          role: 'SUPER_ADMIN',
        })
        .expect(400));
  });

  /* ================================================================== tenancy */

  describe('tenant isolation', () => {
    let otherOwner: Session;
    let ourWarehouseId: string;

    beforeAll(async () => {
      const response = await http
        .post('/api/v1/auth/register')
        .send({
          email: `e2e-other-${stamp}@example.test`,
          password: STRONG_PASSWORD,
          firstName: 'Otto',
          lastName: 'Other',
          companyName: `E2E Other ${stamp}`,
          companyCountry: 'GH',
        })
        .expect(201);

      otherOwner = response.body;
      created.companies.push(otherOwner.user.companyId);

      const warehouse = await http
        .post('/api/v1/warehouses')
        .set(auth(owner))
        .send({
          code: 'WH-E2E',
          name: 'E2E Depot',
          country: 'GH',
          latitude: 5.6037,
          longitude: -0.187,
        })
        .expect(201);

      ourWarehouseId = warehouse.body.id;
    });

    it('does not leak another tenant’s rows in a listing', async () => {
      const response = await http.get('/api/v1/warehouses').set(auth(otherOwner)).expect(200);
      expect(response.body.data).toHaveLength(0);
    });

    it('returns 404 — not 403 — for another tenant’s row', () =>
      // A 403 would confirm the id exists, which is itself a cross-tenant leak.
      http.get(`/api/v1/warehouses/${ourWarehouseId}`).set(auth(otherOwner)).expect(404));

    it('refuses to mutate another tenant’s row', () =>
      http
        .patch(`/api/v1/warehouses/${ourWarehouseId}`)
        .set(auth(otherOwner))
        .send({ name: 'Hijacked' })
        .expect(404));
  });

  /* ===================================================================== rbac */

  describe('role-based access control', () => {
    let viewer: Session;

    beforeAll(async () => {
      await http
        .post('/api/v1/auth/invite')
        .set(auth(owner))
        .send({
          email: `e2e-viewer-${stamp}@example.test`,
          firstName: 'Vera',
          lastName: 'Viewer',
          role: 'VIEWER',
        })
        .expect(201);

      // The invite mails a reset token, so the test sets a password the same way a user would.
      const user = await prisma.user.findUnique({
        where: { email: `e2e-viewer-${stamp}@example.test` },
      });
      const { PasswordService } = await import('../src/modules/auth/password.service');
      const passwords = app.get(PasswordService);
      await prisma.user.update({
        where: { id: user!.id },
        data: { passwordHash: await passwords.hash(STRONG_PASSWORD) },
      });

      const login = await http
        .post('/api/v1/auth/login')
        .send({ email: `e2e-viewer-${stamp}@example.test`, password: STRONG_PASSWORD })
        .expect(200);
      viewer = login.body;
    });

    it('lets a VIEWER read', () =>
      http.get('/api/v1/warehouses').set(auth(viewer)).expect(200));

    it('stops a VIEWER writing', () =>
      http
        .post('/api/v1/warehouses')
        .set(auth(viewer))
        .send({ code: 'NOPE', name: 'Nope', country: 'GH', latitude: 5, longitude: -0.1 })
        .expect(403));

    it('stops a VIEWER creating users', () =>
      http
        .post('/api/v1/auth/invite')
        .set(auth(viewer))
        .send({ email: `x-${stamp}@example.test`, firstName: 'X', lastName: 'Y', role: 'VIEWER' })
        .expect(403));

    it('names the missing permission rather than failing opaquely', async () => {
      const response = await http
        .post('/api/v1/warehouses')
        .set(auth(viewer))
        .send({ code: 'NOPE2', name: 'Nope', country: 'GH', latitude: 5, longitude: -0.1 })
        .expect(403);
      expect(response.body.message).toContain('warehouse:create');
    });
  });

  /* ============================================================== procurement */

  describe('purchase orders', () => {
    let supplierId: string;
    let productId: string;
    let warehouseId: string;
    let orderId: string;

    beforeAll(async () => {
      const warehouse = await http
        .post('/api/v1/warehouses')
        .set(auth(owner))
        .send({ code: 'WH-PO', name: 'PO Depot', country: 'GH', latitude: 5.6, longitude: -0.19 })
        .expect(201);
      warehouseId = warehouse.body.id;

      const supplier = await http
        .post('/api/v1/suppliers')
        .set(auth(owner))
        .send({ code: 'SUP-E2E', name: 'E2E Supplier', country: 'GH', quotedLeadTimeDays: 5 })
        .expect(201);
      supplierId = supplier.body.id;

      const product = await http
        .post('/api/v1/products')
        .set(auth(owner))
        .send({ sku: 'SKU-E2E', name: 'E2E Widget', unitCost: 10, unitPrice: 15 })
        .expect(201);
      productId = product.body.id;

      await http
        .post(`/api/v1/suppliers/${supplierId}/products`)
        .set(auth(owner))
        .send({
          productId,
          unitPrice: 10,
          minimumOrderQuantity: 100,
          capacityPerCycle: 10000,
          leadTimeDays: 5,
        })
        .expect(201);
    });

    it('prices lines from the supplier price list when no price is given', async () => {
      const response = await http
        .post('/api/v1/purchase-orders')
        .set(auth(owner))
        .send({ supplierId, warehouseId, items: [{ productId, quantity: 500 }] })
        .expect(201);

      orderId = response.body.id;
      expect(Number(response.body.items[0].unitPrice)).toBe(10);
      expect(Number(response.body.subtotal)).toBe(5000);
      expect(response.body.orderNumber).toMatch(/^PO-\d{4}-\d{4}$/);
    });

    it('rejects a quantity below the supplier minimum order quantity', () =>
      http
        .post('/api/v1/purchase-orders')
        .set(auth(owner))
        .send({ supplierId, warehouseId, items: [{ productId, quantity: 10 }] })
        .expect(400));

    it('rejects an unpriceable product rather than defaulting to zero', async () => {
      const orphan = await http
        .post('/api/v1/products')
        .set(auth(owner))
        .send({ sku: 'SKU-NOPRICE', name: 'Unpriced', unitCost: 5, unitPrice: 8 })
        .expect(201);

      const response = await http
        .post('/api/v1/purchase-orders')
        .set(auth(owner))
        .send({ supplierId, warehouseId, items: [{ productId: orphan.body.id, quantity: 100 }] })
        .expect(400);

      expect(response.body.message).toContain('No price');
    });

    it('enforces the state machine', async () => {
      // DRAFT cannot jump straight to SHIPPED.
      await http
        .post(`/api/v1/purchase-orders/${orderId}/transition`)
        .set(auth(owner))
        .send({ status: 'SHIPPED' })
        .expect(400);

      for (const status of ['PENDING', 'CONFIRMED']) {
        await http
          .post(`/api/v1/purchase-orders/${orderId}/transition`)
          .set(auth(owner))
          .send({ status })
          .expect(201);
      }
    });

    it('counts a confirmed order as incoming stock', async () => {
      const row = await prisma.inventory.findUnique({
        where: { productId_warehouseId: { productId, warehouseId } },
      });
      expect(Number(row?.incomingStock ?? 0)).toBe(500);
    });

    it('requires a reason to cancel', () =>
      http
        .post(`/api/v1/purchase-orders/${orderId}/transition`)
        .set(auth(owner))
        .send({ status: 'CANCELLED' })
        .expect(400));

    it('receives partially, keeping the order open', async () => {
      const response = await http
        .post(`/api/v1/purchase-orders/${orderId}/receive`)
        .set(auth(owner))
        .send({ warehouseId, lines: [{ productId, receivedQuantity: 200 }] })
        .expect(201);

      expect(response.body.fullyReceived).toBe(false);
      expect(response.body.status).toBe('IN_TRANSIT');
      expect(response.body.outstanding[0].remaining).toBe(300);
    });

    it('routes rejected units to damaged stock, not sellable stock', async () => {
      await http
        .post(`/api/v1/purchase-orders/${orderId}/receive`)
        .set(auth(owner))
        .send({
          warehouseId,
          lines: [{ productId, receivedQuantity: 300, rejectedQuantity: 50 }],
        })
        .expect(201);

      const row = await prisma.inventory.findUnique({
        where: { productId_warehouseId: { productId, warehouseId } },
      });

      expect(Number(row!.availableStock)).toBe(450); // 200 + (300 − 50)
      expect(Number(row!.damagedStock)).toBe(50);
      expect(Number(row!.incomingStock)).toBe(0);
    });

    it('closes the order once every line is complete', async () => {
      const response = await http
        .get(`/api/v1/purchase-orders/${orderId}`)
        .set(auth(owner))
        .expect(200);
      expect(response.body.status).toBe('DELIVERED');
      expect(response.body.allowedTransitions).toEqual([]);
    });

    it('refuses to receive more than was ordered', () =>
      http
        .post(`/api/v1/purchase-orders/${orderId}/receive`)
        .set(auth(owner))
        .send({ warehouseId, lines: [{ productId, receivedQuantity: 1 }] })
        .expect(400));

    /* --------------------------------------------------------------- ledger */

    it('records every movement with the balance it produced', async () => {
      const response = await http
        .get(`/api/v1/inventory/movements?productId=${productId}&order=asc`)
        .set(auth(owner))
        .expect(200);

      const movements = response.body.data as Array<{ type: string; balanceAfter: string }>;
      expect(movements.length).toBeGreaterThanOrEqual(2);
      // The ledger must be replayable: the final balance is the current stock.
      expect(Number(movements[movements.length - 1].balanceAfter)).toBe(450);
    });

    it('refuses to take out more stock than exists', () =>
      http
        .post('/api/v1/inventory/movements')
        .set(auth(owner))
        .send({ productId, warehouseId, type: 'OUT', quantity: 10_000 })
        .expect(400));

    it('does not let concurrent decrements oversell', async () => {
      // Ten simultaneous requests for 100 units against 450 on hand: at most four can win.
      const attempts = Array.from({ length: 10 }, () =>
        http
          .post('/api/v1/inventory/movements')
          .set(auth(owner))
          .send({ productId, warehouseId, type: 'OUT', quantity: 100, reason: 'race' }),
      );

      const results = await Promise.all(attempts);
      const succeeded = results.filter((result) => result.status === 201).length;

      const row = await prisma.inventory.findUnique({
        where: { productId_warehouseId: { productId, warehouseId } },
      });

      expect(succeeded).toBeLessThanOrEqual(4);
      expect(Number(row!.availableStock)).toBe(450 - succeeded * 100);
      expect(Number(row!.availableStock)).toBeGreaterThanOrEqual(0);
    });

    it('treats an adjustment as the counted total, not a delta', async () => {
      await http
        .post('/api/v1/inventory/adjustments')
        .set(auth(owner))
        .send({ productId, warehouseId, countedQuantity: 123, reason: 'stock count' })
        .expect(201);

      const row = await prisma.inventory.findUnique({
        where: { productId_warehouseId: { productId, warehouseId } },
      });
      expect(Number(row!.availableStock)).toBe(123);
    });

    it('rejects a reorder point below the safety stock', () =>
      // Ordering only once the buffer is gone guarantees a stockout during the lead time.
      http
        .put('/api/v1/inventory/policy')
        .set(auth(owner))
        .send({ productId, warehouseId, safetyStock: 100, reorderPoint: 50 })
        .expect(400));
  });

  /* ================================================================ shipments */

  describe('shipments', () => {
    let shipmentId: string;
    let warehouseId: string;
    let productId: string;

    beforeAll(async () => {
      const warehouse = await prisma.warehouse.findFirst({ where: { companyId, code: 'WH-PO' } });
      warehouseId = warehouse!.id;
      const product = await prisma.product.findFirst({ where: { companyId, sku: 'SKU-E2E' } });
      productId = product!.id;
    });

    it('derives a promised arrival from the ETA engine when none is given', async () => {
      const response = await http
        .post('/api/v1/shipments')
        .set(auth(owner))
        .send({
          originWarehouseId: warehouseId,
          destinationName: 'Kumasi',
          destinationLatitude: 6.6885,
          destinationLongitude: -1.6244,
          plannedDepartureAt: new Date(Date.now() + 3_600_000).toISOString(),
          items: [{ productId, quantity: 10 }],
        })
        .expect(201);

      shipmentId = response.body.id;
      expect(response.body.trackingNumber).toMatch(/^SHP-\d{6}-[0-9A-F]{8}$/);
      expect(new Date(response.body.plannedArrivalAt).getTime()).toBeGreaterThan(
        new Date(response.body.plannedDepartureAt).getTime(),
      );
      expect(response.body.plannedDistanceKm).toBeGreaterThan(180);
    });

    it('enforces the shipment state machine', async () => {
      await http
        .post(`/api/v1/shipments/${shipmentId}/transition`)
        .set(auth(owner))
        .send({ status: 'DELIVERED' })
        .expect(400);

      await http
        .post(`/api/v1/shipments/${shipmentId}/transition`)
        .set(auth(owner))
        .send({ status: 'DEPARTED' })
        .expect(201);
    });

    it('rejects an implausible GPS fix and says why', async () => {
      const vehicle = await http
        .post('/api/v1/vehicles')
        .set(auth(owner))
        .send({ plateNumber: 'GT-E2E-01', type: 'TRUCK_MEDIUM', capacityUnits: 1000 })
        .expect(201);

      const response = await http
        .post('/api/v1/telemetry/gps')
        .set(auth(owner))
        .send({
          vehicleId: vehicle.body.id,
          fixes: [
            { latitude: 5.6037, longitude: -0.187, speedKmh: 60, recordedAt: new Date().toISOString() },
            {
              latitude: 6.6885,
              longitude: -1.6244,
              speedKmh: 60,
              // 250 km one minute later is not physically possible for road freight.
              recordedAt: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
        })
        .expect(201);

      expect(response.body.accepted).toBe(1);
      expect(response.body.rejected).toBe(1);
      expect(response.body.rejectedDetail[0].reason).toContain('not physically plausible');
    });

    it('exposes a tracking view with events and a downsampling stride', async () => {
      const response = await http
        .get(`/api/v1/shipments/${shipmentId}/tracking`)
        .set(auth(owner))
        .expect(200);

      expect(response.body.shipment.trackingNumber).toBeTruthy();
      expect(Array.isArray(response.body.events)).toBe(true);
      expect(response.body.positionsSampledEvery).toBeGreaterThanOrEqual(1);
    });
  });

  /* =================================================================== health */

  describe('health', () => {
    it('answers liveness without a token', () => http.get('/api/v1/health').expect(200));

    it('reports each dependency separately', async () => {
      const response = await http.get('/api/v1/health/ready').expect(200);
      expect(response.body.dependencies.database.status).toBe('up');
      expect(response.body.dependencies.postgis.status).toBe('up');
      // The AI service is intentionally not fatal: TRACK works without OPTIMIZE.
      expect(response.body.dependencies).toHaveProperty('aiService');
    });
  });
});
