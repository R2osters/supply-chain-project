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
  // A second tenant, registered once and shared. Registration is rate-limited to 10 per minute,
  // so every block that needs an outsider registering its own would trip the throttle and fail
  // a test for a reason that has nothing to do with what it is testing.
  let otherOwner: Session;
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

  /* ================================================== documented query filters */

  /**
   * A regression guard for a whole bug class, not a single endpoint.
   *
   * The global ValidationPipe runs with `forbidNonWhitelisted`, which also applies to query
   * strings. A controller that binds `@Query() query: PaginationQueryDto` and separately reads
   * `@Query('status')` looks correct, passes review, and returns 400 for the very parameter its
   * Swagger annotation advertises. Four endpoints shipped with exactly that shape.
   *
   * Every filter this API documents is exercised here, so adding a fifth without declaring it on
   * a DTO fails the suite rather than the user.
   */
  describe('documented query filters are accepted', () => {
    const cases: Array<[string, string]> = [
      ['recommendations', '?status=OPEN&limit=5'],
      ['recommendations', '?priority=HIGH'],
      ['recommendations', '?type=ORDER_NOW'],
      ['incidents', '?status=OPEN'],
      ['incidents', '?severity=HIGH'],
      ['incidents', '?type=DELAY'],
      ['notifications', '?unreadOnly=true'],
      ['notifications', '?unreadOnly=false'],
      ['deliveries', '?status=DELIVERED'],
      ['inventory', '?belowReorderPoint=true'],
      ['inventory', '?outOfStock=true'],
      ['inventory/movements', '?order=asc'],
      ['inventory/alerts', '?includeResolved=true'],
      ['shipments', '?status=DELAYED'],
      ['shipments', '?activeOnly=true'],
      ['shipments', '?minDelayProbability=0.5'],
      ['purchase-orders', '?status=DRAFT'],
      ['suppliers', '?search=e2e&sortBy=name&order=asc'],
    ];

    it.each(cases)('GET /%s%s', async (path, query) => {
      await http.get(`/api/v1/${path}${query}`).set(auth(owner)).expect(200);
    });

    it('still rejects a genuinely unknown parameter', () =>
      http.get('/api/v1/shipments?definitelyNotAFilter=1').set(auth(owner)).expect(400));

    it('rejects an invalid value for a known filter', () =>
      http.get('/api/v1/recommendations?status=NOT_A_STATUS').set(auth(owner)).expect(400));

    it('does not let sortBy reach ORDER BY unchecked', async () => {
      // Not on the allow-list, so it must fall back to the default column rather than error
      // or interpolate.
      await http
        .get('/api/v1/suppliers?sortBy=(SELECT%201)&order=asc')
        .set(auth(owner))
        .expect(200);
    });
  });

  /* ================================================================== devices */

  /**
   * The phone intake path.
   *
   * This endpoint is the one place in the API authenticated by something other than a user
   * session — a device identifier and a pairing secret — because a phone in a coverage gap cannot
   * refresh an expired access token, which is exactly where tracking matters most. That makes it
   * worth pinning down: it is public, it accepts bulk writes, and getting its authentication
   * wrong would let anyone write positions for anyone's truck.
   */
  describe('tracking devices', () => {
    const identifier = `e2e-phone-${stamp}`;
    let pairingSecret: string;
    let vehicleId: string;

    const fix = (minutesAgo: number, latitude: number, longitude: number) => ({
      latitude,
      longitude,
      speedKmh: 54,
      headingDegrees: 218,
      accuracyM: 9,
      batteryPercent: 77,
      recordedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    });

    beforeAll(async () => {
      const vehicle = await prisma.vehicle.create({
        data: {
          companyId,
          plateNumber: `E2E-${stamp}`,
          type: 'TRUCK_MEDIUM',
          status: 'AVAILABLE',
          capacityKg: 12000,
          capacityUnits: 480,
        },
        select: { id: true },
      });
      vehicleId = vehicle.id;

      const response = await http
        .post('/api/v1/devices')
        .set(auth(owner))
        .send({ kind: 'PHONE', identifier, vehicleId, label: 'E2E phone' })
        .expect(201);

      expect(response.body.pairingSecret).toEqual(expect.any(String));
      expect(response.body.setupInstructions.length).toBeGreaterThan(0);
      pairingSecret = response.body.pairingSecret;
    });

    afterAll(async () => {
      await prisma.gpsPosition.deleteMany({ where: { vehicleId } });
      await prisma.trackingDevice.deleteMany({ where: { identifier } });
      await prisma.vehicle.delete({ where: { id: vehicleId } }).catch(() => undefined);
    });

    it('refuses a hardware tracker whose identifier is not an IMEI', () =>
      http
        .post('/api/v1/devices')
        .set(auth(owner))
        .send({ kind: 'GT06', identifier: 'not-an-imei' })
        .expect(400));

    it('refuses to enrol the same identifier twice', () =>
      http
        .post('/api/v1/devices')
        .set(auth(owner))
        .send({ kind: 'PHONE', identifier })
        .expect(400));

    it('accepts a batch of fixes from the paired phone', async () => {
      const response = await http
        .post('/api/v1/devices/phone/positions')
        .send({
          identifier,
          secret: pairingSecret,
          // Ordered oldest first and far enough apart in time that the leg is drivable, which is
          // what a real flush after a coverage gap looks like.
          fixes: [fix(40, 5.6667, -0.0167), fix(25, 5.6402, -0.0812), fix(10, 5.6037, -0.187)],
        })
        .expect(201);

      expect(response.body.accepted).toBe(3);
      expect(response.body.rejected).toBe(0);
    });

    it('stores those positions against the vehicle, not as simulated data', async () => {
      const stored = await prisma.gpsPosition.findMany({
        where: { vehicleId },
        orderBy: { recordedAt: 'asc' },
      });
      expect(stored).toHaveLength(3);
      expect(stored.every((position) => position.isSimulated === false)).toBe(true);
      expect(stored[0].latitude).toBeCloseTo(5.6667, 4);
    });

    it('refuses a batch signed with the wrong secret', async () => {
      const response = await http
        .post('/api/v1/devices/phone/positions')
        .send({ identifier, secret: 'wrong', fixes: [fix(5, 5.6, -0.18)] })
        .expect(201);

      // Deliberately a 201 with a vague body rather than a 401: a precise failure tells someone
      // probing which half of the credential to keep guessing at.
      expect(response.body.accepted).toBe(0);
      expect(response.body.error).toBeDefined();
    });

    it('rejects a physically impossible jump', async () => {
      const response = await http
        .post('/api/v1/devices/phone/positions')
        .send({
          identifier,
          secret: pairingSecret,
          // Ghana to Kenya, a minute after the last stored fix.
          fixes: [fix(9, -1.2921, 36.8219)],
        })
        .expect(201);

      expect(response.body.accepted).toBe(0);
      expect(response.body.rejected).toBe(1);
    });

    it('rejects null island, which a tracker reports when it has no fix', async () => {
      const response = await http
        .post('/api/v1/devices/phone/positions')
        .send({ identifier, secret: pairingSecret, fixes: [fix(8, 0, 0)] })
        .expect(201);

      expect(response.body.accepted).toBe(0);
      expect(response.body.rejected).toBe(1);
    });

    it('counts accepted and rejected fixes on the device', async () => {
      const response = await http.get('/api/v1/devices').set(auth(owner)).expect(200);
      const device = response.body.find(
        (row: { identifier: string }) => row.identifier === identifier,
      );
      expect(device.positionsAccepted).toBe(3);
      expect(device.positionsRejected).toBe(2);
      expect(device.vehicle.id).toBe(vehicleId);
    });

    it('reports whether the hardware gateway is listening', async () => {
      const response = await http
        .get('/api/v1/devices/gateway/status')
        .set(auth(owner))
        .expect(200);
      expect(response.body).toHaveProperty('listening');
      expect(response.body.protocol).toContain('GT06');
    });

    it('does not expose another company’s devices', async () => {
      const response = await http.get('/api/v1/devices').set(auth(otherOwner)).expect(200);
      expect(response.body).toHaveLength(0);
    });

    it('refuses to bind a device to another company’s vehicle', () =>
      http
        .post('/api/v1/devices')
        .set(auth(otherOwner))
        .send({ kind: 'PHONE', identifier: `e2e-cross-${stamp}`, vehicleId })
        .expect(400));
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
