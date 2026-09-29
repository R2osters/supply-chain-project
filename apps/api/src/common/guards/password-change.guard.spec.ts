import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllowPendingPasswordChange, Public, RequirePermissions } from '../decorators';
import { AllExceptionsFilter } from '../filters/all-exceptions.filter';
import { JwtStrategy } from '../../modules/auth/jwt.strategy';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PASSWORD_CHANGE_REQUIRED, PasswordChangeGuard } from './password-change.guard';
import { PermissionsGuard } from './permissions.guard';

const SECRET = 'test-access-secret-0123456789abcdef0123456789';

@Controller()
class ProbeController {
  @Get('shipments')
  @RequirePermissions('shipment:read')
  shipments() {
    return { ok: 'shipments' };
  }

  @Get('users')
  @RequirePermissions('user:create')
  users() {
    return { ok: 'users' };
  }

  @Get('auth/me')
  @AllowPendingPasswordChange()
  me() {
    return { ok: 'me' };
  }

  @Post('auth/change-password')
  @AllowPendingPasswordChange()
  change() {
    return { ok: 'changed' };
  }

  @Post('auth/refresh')
  @Public()
  refresh() {
    return { ok: 'refreshed' };
  }
}

/**
 * The guard in the same pipeline as the real app (JWT strategy, global guards in AppModule's
 * order, the global exception filter), so the test proves the ordering too: an anonymous
 * request is a 401 from authentication, never a 403 from this guard.
 */
describe('PasswordChangeGuard (HTTP pipeline)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const account = { mustChangePassword: true, role: 'COMPANY_ADMIN' };

  beforeAll(async () => {
    const prisma = {
      user: {
        findUnique: jest.fn(async () => ({
          id: 'u1',
          email: 'admin@acme.test',
          role: account.role,
          companyId: 'c1',
          isActive: true,
          linkedSupplierId: null,
          linkedCustomerId: null,
          lockedUntil: null,
          mustChangePassword: account.mustChangePassword,
        })),
      },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule.register({})],
      controllers: [ProbeController],
      providers: [
        JwtStrategy,
        Reflector,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => ({ accessSecret: SECRET }) } },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PasswordChangeGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  const token = () =>
    jwt.sign(
      { sub: 'u1', email: 'admin@acme.test', role: 'COMPANY_ADMIN', companyId: 'c1', supplierId: null, customerId: null, type: 'access' },
      { secret: SECRET, expiresIn: 60 },
    );

  it('refuses every other route with 403 password-change-required while the flag is set', async () => {
    account.mustChangePassword = true;
    const response = await request(app.getHttpServer()).get('/shipments').set('Authorization', `Bearer ${token()}`);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ statusCode: 403, code: PASSWORD_CHANGE_REQUIRED });
  });

  it('still serves the profile and the password change', async () => {
    account.mustChangePassword = true;
    const auth = { Authorization: `Bearer ${token()}` };
    await request(app.getHttpServer()).get('/auth/me').set(auth).expect(200, { ok: 'me' });
    await request(app.getHttpServer()).post('/auth/change-password').set(auth).expect(201);
  });

  it('leaves public routes alone', async () => {
    account.mustChangePassword = true;
    await request(app.getHttpServer()).post('/auth/refresh').expect(201, { ok: 'refreshed' });
  });

  it('runs after authentication: no token is a 401, not a 403', async () => {
    const response = await request(app.getHttpServer()).get('/shipments');
    expect(response.status).toBe(401);
    expect(response.body.code).toBeUndefined();
  });

  it('lets everything through once the password has been changed', async () => {
    account.mustChangePassword = false;
    await request(app.getHttpServer())
      .get('/shipments')
      .set('Authorization', `Bearer ${token()}`)
      .expect(200, { ok: 'shipments' });
  });

  it('comes before authorisation: a role without the permission still hears "change your password"', async () => {
    account.role = 'CUSTOMER';
    const auth = { Authorization: `Bearer ${token()}` };

    account.mustChangePassword = true;
    const pending = await request(app.getHttpServer()).get('/users').set(auth);
    expect(pending.status).toBe(403);
    expect(pending.body.code).toBe(PASSWORD_CHANGE_REQUIRED);

    // Once changed, the same request meets the ordinary permission refusal, without the code.
    account.mustChangePassword = false;
    const refused = await request(app.getHttpServer()).get('/users').set(auth);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBeUndefined();
    account.role = 'COMPANY_ADMIN';
  });
});

describe('PasswordChangeGuard (unit)', () => {
  const guard = new PasswordChangeGuard(new Reflector());
  const contextFor = (user: object | undefined, type = 'http') =>
    ({
      getType: () => type,
      getHandler: () => function handler() {},
      getClass: () => class Anonymous {},
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as never;

  it('ignores requests without a user (public routes) and non-HTTP contexts', () => {
    expect(guard.canActivate(contextFor(undefined))).toBe(true);
    expect(guard.canActivate(contextFor({ mustChangePassword: true }, 'ws'))).toBe(true);
  });

  it('passes an account without a temporary password', () => {
    expect(guard.canActivate(contextFor({ mustChangePassword: false }))).toBe(true);
    expect(guard.canActivate(contextFor({}))).toBe(true);
  });

  it('throws a 403 carrying the machine-readable code', () => {
    try {
      guard.canActivate(contextFor({ mustChangePassword: true }));
      throw new Error('expected a refusal');
    } catch (error) {
      const response = (error as { getStatus(): number; getResponse(): unknown });
      expect(response.getStatus()).toBe(403);
      expect(response.getResponse()).toMatchObject({ code: PASSWORD_CHANGE_REQUIRED });
    }
  });
});
