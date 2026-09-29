import { ForbiddenException, INestApplication, Logger, NotFoundException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PasswordChangeGuard } from '../../common/guards/password-change.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { redact } from '../../common/interceptors/audit.interceptor';
import type { PrismaService } from '../../prisma/prisma.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import {
  LOCAL_RECOVERY_HEADER,
  LocalRecoveryGuard,
  isLoopbackAddress,
  isLoopbackRequest,
} from './local-recovery.guard';
import { LOCAL_RECOVERY_AUDIT_ACTION, LocalRecoveryService } from './local-recovery.service';
import type { PasswordService } from './password.service';
import { STRONG_PASSWORD } from './password-policy';
import { TemporaryPasswordService } from './temporary-password.service';

const TOKEN = 'k'.repeat(64);

function configWith(token: string | null): never {
  return { get: () => ({ localRecoveryToken: token }) } as never;
}

/* ============================================================== HTTP pipeline */

/**
 * AuthController behind AppModule's global guards, in the same order. The throttler is only
 * switched on for the test about it: the route allows 5 calls a minute, fewer than a describe
 * block makes.
 */
async function boot(token: string | null, recover = jest.fn(), { throttle = false } = {}) {
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }] })],
    controllers: [AuthController],
    providers: [
      Reflector,
      { provide: AuthService, useValue: {} },
      { provide: LocalRecoveryService, useValue: { recover } },
      { provide: ConfigService, useValue: configWith(token) },
      LocalRecoveryGuard,
      ...(throttle ? [{ provide: APP_GUARD, useClass: ThrottlerGuard }] : []),
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      { provide: APP_GUARD, useClass: PasswordChangeGuard },
      { provide: APP_GUARD, useClass: PermissionsGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return app;
}

describe('POST /auth/local-recovery (HTTP pipeline)', () => {
  let app: INestApplication;
  const recover = jest.fn(async (email?: string) => ({
    email: email ?? 'first-admin@acme.test',
    temporaryPassword: 'Tmp2PassWord7xyz',
  }));

  beforeAll(async () => {
    app = await boot(TOKEN, recover);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => recover.mockClear());

  it('gives the first administrator a temporary password when no e-mail is sent', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/local-recovery')
      .set(LOCAL_RECOVERY_HEADER, TOKEN)
      .send({})
      .expect(200);
    expect(response.body).toEqual({ email: 'first-admin@acme.test', temporaryPassword: 'Tmp2PassWord7xyz' });
    expect(recover).toHaveBeenCalledWith(undefined, expect.objectContaining({ ipAddress: expect.any(String) }));
  });

  it('normalises the e-mail the shell sends', async () => {
    await request(app.getHttpServer())
      .post('/auth/local-recovery')
      .set(LOCAL_RECOVERY_HEADER, TOKEN)
      .send({ email: ' Admin@Acme.TEST ' })
      .expect(200);
    expect(recover).toHaveBeenCalledWith('admin@acme.test', expect.anything());
  });

  it('answers 403 without the header or with a wrong token, and never reaches the service', async () => {
    await request(app.getHttpServer()).post('/auth/local-recovery').send({}).expect(403);
    await request(app.getHttpServer())
      .post('/auth/local-recovery')
      .set(LOCAL_RECOVERY_HEADER, `${TOKEN}x`)
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post('/auth/local-recovery')
      .set(LOCAL_RECOVERY_HEADER, 'short')
      .send({})
      .expect(403);
    expect(recover).not.toHaveBeenCalled();
  });

  it('checks the token before looking at the body', async () => {
    // A wrong token with a malformed body is a 403, not a 400 that would describe the DTO.
    await request(app.getHttpServer())
      .post('/auth/local-recovery')
      .send({ email: 'not-an-email', extra: true })
      .expect(403);
    await request(app.getHttpServer())
      .post('/auth/local-recovery')
      .set(LOCAL_RECOVERY_HEADER, TOKEN)
      .send({ email: 'not-an-email' })
      .expect(400);
  });
});

describe('POST /auth/local-recovery when no token is configured', () => {
  it('answers 404 exactly like a route that does not exist', async () => {
    const recover = jest.fn();
    const app = await boot(null, recover);
    const response = await request(app.getHttpServer())
      .post('/auth/local-recovery')
      .set(LOCAL_RECOVERY_HEADER, TOKEN)
      .send({})
      .expect(404);
    expect(response.body).toMatchObject({ statusCode: 404, error: 'Not Found', message: 'Cannot POST /auth/local-recovery' });

    const unknown = await request(app.getHttpServer()).post('/auth/no-such-route').send({}).expect(404);
    expect(unknown.body.message).toBe('Cannot POST /auth/no-such-route');
    expect(recover).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /auth/local-recovery throttling', () => {
  it('allows 5 attempts a minute', async () => {
    const app = await boot(TOKEN, jest.fn(async () => ({ email: 'a@b.c', temporaryPassword: 'x' })), { throttle: true });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const response = await request(app.getHttpServer())
        .post('/auth/local-recovery')
        .set(LOCAL_RECOVERY_HEADER, TOKEN)
        .send({});
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    await app.close();
  });
});

/* ===================================================================== guard */

describe('LocalRecoveryGuard', () => {
  const contextFor = (req: Record<string, unknown>) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ method: 'POST', originalUrl: '/api/v1/auth/local-recovery', ...req }) }) }) as never;
  const local = { socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1' };

  it('accepts the right token from this computer', () => {
    const guard = new LocalRecoveryGuard(configWith(TOKEN));
    expect(guard.canActivate(contextFor({ ...local, headers: { [LOCAL_RECOVERY_HEADER]: TOKEN } }))).toBe(true);
    expect(
      guard.canActivate(
        contextFor({ socket: { remoteAddress: '::ffff:127.0.0.1' }, ip: '::ffff:127.0.0.1', headers: { [LOCAL_RECOVERY_HEADER]: TOKEN } }),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(contextFor({ socket: { remoteAddress: '::1' }, ip: '::1', headers: { [LOCAL_RECOVERY_HEADER]: TOKEN } })),
    ).toBe(true);
  });

  it('refuses a request from the network even with the right token', () => {
    const guard = new LocalRecoveryGuard(configWith(TOKEN));
    const fromLan = contextFor({ socket: { remoteAddress: '192.168.1.23' }, ip: '192.168.1.23', headers: { [LOCAL_RECOVERY_HEADER]: TOKEN } });
    expect(() => guard.canActivate(fromLan)).toThrow(ForbiddenException);
  });

  it('refuses a LAN client relayed by a local proxy (loopback socket, remote req.ip)', () => {
    const guard = new LocalRecoveryGuard(configWith(TOKEN));
    const relayed = contextFor({ socket: { remoteAddress: '127.0.0.1' }, ip: '192.168.1.23', headers: { [LOCAL_RECOVERY_HEADER]: TOKEN } });
    expect(() => guard.canActivate(relayed)).toThrow(ForbiddenException);
  });

  it('refuses a missing, repeated or wrong token', () => {
    const guard = new LocalRecoveryGuard(configWith(TOKEN));
    expect(() => guard.canActivate(contextFor({ ...local, headers: {} }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextFor({ ...local, headers: { [LOCAL_RECOVERY_HEADER]: [TOKEN, TOKEN] } }))).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(contextFor({ ...local, headers: { [LOCAL_RECOVERY_HEADER]: TOKEN.slice(1) } }))).toThrow(
      ForbiddenException,
    );
  });

  it('is absent (404) when no token, or a token too short to be a generated secret, is configured', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    for (const token of [null, 'too-short']) {
      const guard = new LocalRecoveryGuard(configWith(token));
      expect(() => guard.canActivate(contextFor({ ...local, headers: { [LOCAL_RECOVERY_HEADER]: token ?? '' } }))).toThrow(
        NotFoundException,
      );
    }
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('isLoopbackRequest', () => {
  it('knows the loopback spellings and nothing else', () => {
    expect(['127.0.0.1', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1'].every(isLoopbackAddress)).toBe(true);
    expect(['192.168.1.2', '10.0.0.1', '0.0.0.0', '', undefined, null, '127.0.0.1.evil'].some(isLoopbackAddress)).toBe(false);
  });

  it('trusts the socket, not headers', () => {
    expect(isLoopbackRequest({ socket: { remoteAddress: '10.0.0.5' }, ip: '127.0.0.1' } as never)).toBe(false);
    expect(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, ip: undefined } as never)).toBe(true);
  });
});

/* =================================================================== service */

function makeService(admin: { id: string; email: string; companyId: string } | null) {
  const tx = {
    user: { update: jest.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })) },
    refreshToken: { updateMany: jest.fn(async () => ({ count: 3 })) },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  const prisma = {
    user: { findFirst: jest.fn(async () => admin) },
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const passwords = { hash: jest.fn(async (plain: string) => `argon2id$${plain.length}`) };
  const temporary = new TemporaryPasswordService(
    prisma as unknown as PrismaService,
    passwords as unknown as PasswordService,
  );
  return { service: new LocalRecoveryService(prisma as unknown as PrismaService, temporary), prisma, tx, passwords };
}

describe('LocalRecoveryService', () => {
  const admin = { id: 'u-admin', email: 'admin@acme.test', companyId: 'c1' };
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('picks the first active administrator by creation date when no e-mail is given', async () => {
    const { service, prisma } = makeService(admin);
    await service.recover(undefined);
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: 'COMPANY_ADMIN', isActive: true }, orderBy: { createdAt: 'asc' } }),
    );
  });

  it('only resets an active administrator with that e-mail', async () => {
    const { service, prisma } = makeService(admin);
    await service.recover('admin@acme.test');
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: 'COMPANY_ADMIN', isActive: true, email: 'admin@acme.test' } }),
    );
  });

  it('answers 404 when no administrator matches', async () => {
    const { service, tx } = makeService(null);
    await expect(service.recover('driver@acme.test')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.recover(undefined)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('returns a strong temporary password once, stores only its hash, unlocks and signs out', async () => {
    const { service, tx, passwords } = makeService(admin);
    const result = await service.recover(undefined, { ipAddress: '127.0.0.1', userAgent: 'SCIP desktop' });

    expect(result.email).toBe('admin@acme.test');
    expect(result.temporaryPassword).toMatch(STRONG_PASSWORD);
    expect(passwords.hash).toHaveBeenCalledWith(result.temporaryPassword);

    const update = (tx.user.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0];
    expect(update).toMatchObject({
      where: { id: 'u-admin' },
      data: { mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
    });
    expect(update.data.passwordHash).not.toContain(result.temporaryPassword);
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u-admin', revokedAt: null } }),
    );
  });

  it('writes an audit row without the password, and never logs the password', async () => {
    const { service, tx } = makeService(admin);
    const { temporaryPassword } = await service.recover(undefined, { ipAddress: '127.0.0.1' });

    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const row = (tx.auditLog.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(row).toMatchObject({
      action: LOCAL_RECOVERY_AUDIT_ACTION,
      resource: 'user',
      resourceId: 'u-admin',
      companyId: 'c1',
      ipAddress: '127.0.0.1',
      statusCode: 200,
    });
    expect(JSON.stringify(row)).not.toContain(temporaryPassword);
    for (const call of warn.mock.calls) expect(JSON.stringify(call)).not.toContain(temporaryPassword);
    // And were the response ever audited, the redaction would hide the field by its name.
    expect(redact({ email: 'admin@acme.test', temporaryPassword })).toEqual({
      email: 'admin@acme.test',
      temporaryPassword: '[redacted]',
    });
  });
});
