import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { UserRole } from '@scip/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PasswordService } from '../auth/password.service';
import { STRONG_PASSWORD } from '../auth/password-policy';
import { TemporaryPasswordService } from '../auth/temporary-password.service';
import { CreateUserDto, UpdateUserDto, UserQueryDto } from './users.dto';
import { UsersService, assignableRoles, canAssignRole, canManageRole } from './users.service';

/* ---------------------------------------------------------------- fixtures */

interface Row {
  id: string;
  companyId: string | null;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  role: UserRole;
  isActive: boolean;
  lockedUntil: Date | null;
  failedLoginCount: number;
  lastLoginAt: Date | null;
  mustChangePassword: boolean;
  createdAt: Date;
  isDemoData: boolean;
  linkedSupplierId: string | null;
  linkedCustomerId: string | null;
}

interface DriverRow {
  id: string;
  companyId: string;
  userId: string | null;
  firstName: string;
  lastName: string;
}

const actor = (id: string, role: UserRole, companyId: string | null = 'c1'): AuthenticatedUser => ({
  id,
  email: `${id}@acme.test`,
  role,
  companyId,
  linkedSupplierId: null,
  linkedCustomerId: null,
});

const admin = actor('a1', 'COMPANY_ADMIN');
const superAdmin = actor('s1', 'SUPER_ADMIN', null);
const logistics = actor('l1', 'LOGISTICS_MANAGER');

function user(id: string, role: UserRole, extra: Partial<Row> = {}): Row {
  return {
    id,
    companyId: 'c1',
    email: `${id}@acme.test`,
    passwordHash: 'argon2id$old',
    firstName: id.toUpperCase(),
    lastName: 'Test',
    phone: null,
    role,
    isActive: true,
    lockedUntil: null,
    failedLoginCount: 0,
    lastLoginAt: null,
    mustChangePassword: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    isDemoData: false,
    linkedSupplierId: null,
    linkedCustomerId: null,
    ...extra,
  };
}

/**
 * A small in-memory stand-in for the Prisma calls UsersService makes. Enough behaviour to check
 * the rules (counts, links, what gets written), none of the query language beyond that.
 */
function setup(
  seedUsers: Row[] = [
    user('a1', 'COMPANY_ADMIN'),
    user('d1', 'DRIVER', { lockedUntil: new Date(Date.now() + 600_000), failedLoginCount: 8 }),
    user('l1', 'LOGISTICS_MANAGER'),
    user('x1', 'COMPANY_ADMIN', { companyId: 'c2' }),
  ],
  seedDrivers: DriverRow[] = [
    { id: 'drv1', companyId: 'c1', userId: null, firstName: 'Kwame', lastName: 'Mensah' },
    { id: 'drv2', companyId: 'c1', userId: 'd1', firstName: 'Ama', lastName: 'Owusu' },
    { id: 'drv3', companyId: 'c2', userId: null, firstName: 'Other', lastName: 'Tenant' },
  ],
) {
  const users = seedUsers.map((row) => ({ ...row }));
  const drivers = seedDrivers.map((row) => ({ ...row }));
  const suppliers = [
    { id: 'sup1', companyId: 'c1' },
    { id: 'sup2', companyId: 'c2' },
  ];
  const customers = [{ id: 'cus1', companyId: 'c1' }];

  const view = (row: Row) => {
    const { passwordHash: _hash, failedLoginCount: _count, ...rest } = row;
    const driver = drivers.find((d) => d.userId === row.id);
    return {
      ...rest,
      driverProfile: driver ? { id: driver.id, firstName: driver.firstName, lastName: driver.lastName } : null,
    };
  };
  const find = (where: { id?: string; email?: string }) =>
    users.find((row) => (where.id !== undefined ? row.id === where.id : row.email === where.email));

  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id?: string; email?: string } }) => {
        const row = find(where);
        return row ? view(row) : null;
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = find(where);
        if (!row) throw new Error('not found');
        return view(row);
      }),
      findMany: jest.fn(async (_args: unknown) => users.map(view)),
      count: jest.fn(
        async ({ where }: { where: { companyId?: string; role?: string; isActive?: boolean; id?: { not: string } } }) =>
          users.filter(
            (row) =>
              (where.companyId === undefined || row.companyId === where.companyId) &&
              (where.role === undefined || row.role === where.role) &&
              (where.isActive === undefined || row.isActive === where.isActive) &&
              (where.id === undefined || row.id !== where.id.not),
          ).length,
      ),
      create: jest.fn(async ({ data }: { data: Partial<Row> }) => {
        const row = user(`u${users.length + 1}`, data.role as UserRole, data);
        users.push(row);
        return { id: row.id };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = find(where)!;
        Object.assign(row, data);
        return row;
      }),
    },
    driver: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => drivers.find((d) => d.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<DriverRow> }) => {
        const row = drivers.find((d) => d.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
      updateMany: jest.fn(
        async ({ where, data }: { where: { userId: string; NOT?: { id: string } }; data: Partial<DriverRow> }) => {
          const hit = drivers.filter((d) => d.userId === where.userId && (!where.NOT || d.id !== where.NOT.id));
          hit.forEach((d) => Object.assign(d, data));
          return { count: hit.length };
        },
      ),
    },
    supplier: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => suppliers.find((s) => s.id === where.id) ?? null) },
    customer: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => customers.find((c) => c.id === where.id) ?? null) },
    refreshToken: { updateMany: jest.fn(async () => ({ count: 2 })) },
    auditLog: { create: jest.fn(async () => ({})) },
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(),
  };
  // Rolls back on error like the real thing, so a refused call leaves nothing behind.
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    const savedUsers = users.map((row) => ({ ...row }));
    const savedDrivers = drivers.map((row) => ({ ...row }));
    try {
      return await fn(prisma);
    } catch (error) {
      users.splice(0, users.length, ...savedUsers);
      drivers.splice(0, drivers.length, ...savedDrivers);
      throw error;
    }
  });

  const passwords = { hash: jest.fn(async (plain: string) => `argon2id$hash-of-${plain.length}-chars`) };
  const temporary = new TemporaryPasswordService(prisma as unknown as PrismaService, passwords as unknown as PasswordService);
  const service = new UsersService(prisma as unknown as PrismaService, temporary);
  const row = (id: string) => users.find((r) => r.id === id)!;
  return { service, prisma, users, drivers, passwords, row };
}

const query = (values: Record<string, unknown> = {}) => plainToInstance(UserQueryDto, values);

const createDto = (values: Partial<CreateUserDto> = {}): CreateUserDto =>
  plainToInstance(CreateUserDto, { email: 'kofi@acme.test', firstName: 'Kofi', lastName: 'Asante', role: 'VIEWER', ...values });

/* ------------------------------------------------------------- role rules */

describe('role rules', () => {
  it('nobody hands out SUPER_ADMIN, not even a SUPER_ADMIN', () => {
    expect(canAssignRole('SUPER_ADMIN', 'SUPER_ADMIN')).toBe(false);
    expect(canAssignRole('COMPANY_ADMIN', 'SUPER_ADMIN')).toBe(false);
    expect(assignableRoles('COMPANY_ADMIN')).not.toContain('SUPER_ADMIN');
  });

  it('an administrator can give every company role, including administrator', () => {
    expect(assignableRoles('COMPANY_ADMIN')).toEqual([
      'COMPANY_ADMIN',
      'SUPPLY_CHAIN_MANAGER',
      'LOGISTICS_MANAGER',
      'PROCUREMENT_MANAGER',
      'WAREHOUSE_MANAGER',
      'DRIVER',
      'SUPPLIER',
      'CUSTOMER',
      'VIEWER',
    ]);
  });

  it('never grants more than the actor holds, whatever the matrix says about user:create', () => {
    expect(canAssignRole('LOGISTICS_MANAGER', 'COMPANY_ADMIN')).toBe(false);
    expect(canAssignRole('LOGISTICS_MANAGER', 'SUPPLY_CHAIN_MANAGER')).toBe(false);
    expect(canAssignRole('LOGISTICS_MANAGER', 'DRIVER')).toBe(true);
    expect(canAssignRole('VIEWER', 'DRIVER')).toBe(false);
  });

  it('only an equal or stronger role manages an account', () => {
    expect(canManageRole('COMPANY_ADMIN', 'COMPANY_ADMIN')).toBe(true);
    expect(canManageRole('COMPANY_ADMIN', 'SUPER_ADMIN')).toBe(false);
    expect(canManageRole('LOGISTICS_MANAGER', 'COMPANY_ADMIN')).toBe(false);
  });
});

/* -------------------------------------------------------------------- list */

describe('UsersService.list', () => {
  it("is scoped to the caller's company and never selects the password hash", async () => {
    const { service, prisma } = setup();
    await service.list(admin, query({ search: 'kwa', role: 'DRIVER' }));
    const args = prisma.user.findMany.mock.calls[0][0] as { where: Record<string, unknown>; select: Record<string, unknown> };
    expect(args.where).toMatchObject({ companyId: 'c1', role: 'DRIVER' });
    expect(args.where.OR).toEqual(
      expect.arrayContaining([{ email: { contains: 'kwa', mode: 'insensitive' } }]),
    );
    expect(args.select.passwordHash).toBeUndefined();
    expect(args.select.mustChangePassword).toBe(true);
  });

  it('reports the linked driver by id and name', async () => {
    const { service } = setup();
    const page = await service.list(admin, query());
    const driver = page.data.find((row) => row.id === 'd1');
    expect(driver?.driver).toEqual({ id: 'drv2', name: 'Ama Owusu' });
    expect(driver).not.toHaveProperty('passwordHash');
    expect(page.meta).toMatchObject({ page: 1, limit: 25 });
  });

  it('lets a SUPER_ADMIN see every company', async () => {
    const { service, prisma } = setup();
    await service.list(superAdmin, query());
    expect((prisma.user.findMany.mock.calls[0][0] as { where: object }).where).not.toHaveProperty('companyId');
  });
});

/* ------------------------------------------------------------------ create */

describe('UsersService.create', () => {
  it('creates the account in the caller company and returns a strong temporary password once', async () => {
    const { service, row, passwords } = setup();
    const created = await service.create(admin, createDto({ role: 'WAREHOUSE_MANAGER', phone: '+233200000000' }));

    expect(created.temporaryPassword).toHaveLength(16);
    expect(created.temporaryPassword).toMatch(STRONG_PASSWORD);
    expect(created).toMatchObject({ email: 'kofi@acme.test', role: 'WAREHOUSE_MANAGER', companyId: 'c1', mustChangePassword: true });
    expect(created).not.toHaveProperty('passwordHash');

    const stored = row(created.id);
    expect(passwords.hash).toHaveBeenCalledWith(created.temporaryPassword);
    expect(stored.passwordHash).not.toContain(created.temporaryPassword);
    expect(stored.mustChangePassword).toBe(true);
  });

  it('uses the temporary password the administrator chose, if any', async () => {
    const { service } = setup();
    const created = await service.create(admin, createDto({ temporaryPassword: 'Chosen-Passw0rd' }));
    expect(created.temporaryPassword).toBe('Chosen-Passw0rd');
  });

  it('refuses SUPER_ADMIN for everyone, and administrators from a non-administrator', async () => {
    const { service } = setup();
    await expect(service.create(admin, createDto({ role: 'SUPER_ADMIN' }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.create(superAdmin, createDto({ role: 'SUPER_ADMIN', companyId: 'c1' }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.create(logistics, createDto({ role: 'COMPANY_ADMIN' }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.create(admin, createDto({ role: 'COMPANY_ADMIN' }))).resolves.toMatchObject({ role: 'COMPANY_ADMIN' });
  });

  it('refuses an e-mail already in use (409)', async () => {
    const { service } = setup();
    await expect(service.create(admin, createDto({ email: 'd1@acme.test' }))).rejects.toBeInstanceOf(ConflictException);
  });

  it('cannot write into another company', async () => {
    const { service } = setup();
    await expect(service.create(admin, createDto({ companyId: 'c2' }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.create(actor('n1', 'COMPANY_ADMIN', null), createDto())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('links a DRIVER account to a driver of the same company', async () => {
    const { service, drivers } = setup();
    const created = await service.create(admin, createDto({ role: 'DRIVER', driverId: 'drv1' }));
    expect(drivers.find((d) => d.id === 'drv1')?.userId).toBe(created.id);
    expect(created.driver).toEqual({ id: 'drv1', name: 'Kwame Mensah' });
  });

  it('refuses a driver link that is not a DRIVER account, foreign, or already taken', async () => {
    const { service } = setup();
    await expect(service.create(admin, createDto({ role: 'VIEWER', driverId: 'drv1' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.create(admin, createDto({ role: 'DRIVER', driverId: 'drv3' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.create(admin, createDto({ role: 'DRIVER', driverId: 'drv2' }))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('requires a supplier of the same company for a SUPPLIER portal account', async () => {
    const { service } = setup();
    await expect(service.create(admin, createDto({ role: 'SUPPLIER' }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(admin, createDto({ role: 'SUPPLIER', linkedSupplierId: 'sup2' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.create(admin, createDto({ role: 'VIEWER', linkedSupplierId: 'sup1' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.create(admin, createDto({ role: 'SUPPLIER', linkedSupplierId: 'sup1' })),
    ).resolves.toMatchObject({ linkedSupplierId: 'sup1', linkedCustomerId: null });
  });
});

/* ------------------------------------------------------------------ update */

describe('UsersService.update', () => {
  it("reports another company's account as missing (tenant isolation)", async () => {
    const { service } = setup();
    await expect(service.findOne(admin, 'x1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.update(admin, 'x1', { firstName: 'Hacked' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.resetPassword(admin, 'x1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.deactivate(admin, 'x1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets you edit your own names but not your own role or activity', async () => {
    const { service } = setup([user('a1', 'COMPANY_ADMIN'), user('a2', 'COMPANY_ADMIN')]);
    await expect(service.update(admin, 'a1', { role: 'VIEWER' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.update(admin, 'a1', { isActive: false })).rejects.toBeInstanceOf(ForbiddenException);
    // The edit form sends unchanged values back: that is not a change of role.
    await expect(
      service.update(admin, 'a1', { firstName: 'Ada', role: 'COMPANY_ADMIN', isActive: true }),
    ).resolves.toMatchObject({ firstName: 'Ada', role: 'COMPANY_ADMIN' });
  });

  it('never removes the last active administrator of a company (409)', async () => {
    const { service, prisma } = setup([user('a1', 'COMPANY_ADMIN'), user('v1', 'VIEWER')]);
    await expect(service.update(superAdmin, 'a1', { role: 'VIEWER' })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.update(superAdmin, 'a1', { isActive: false })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.deactivate(superAdmin, 'a1')).rejects.toBeInstanceOf(ConflictException);
    // The check runs under a lock on the company row, so two demotions cannot race past it.
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it('demotes an administrator when another one remains', async () => {
    const { service, row } = setup([user('a1', 'COMPANY_ADMIN'), user('a2', 'COMPANY_ADMIN')]);
    await expect(service.update(admin, 'a2', { role: 'LOGISTICS_MANAGER' })).resolves.toMatchObject({
      role: 'LOGISTICS_MANAGER',
    });
    expect(row('a2').role).toBe('LOGISTICS_MANAGER');
  });

  it('does not let a weaker role promote to administrator or touch an administrator', async () => {
    const { service, row } = setup([user('a1', 'COMPANY_ADMIN'), user('l1', 'LOGISTICS_MANAGER'), user('d1', 'DRIVER')]);
    // LOGISTICS_MANAGER may manage a DRIVER account (every DRIVER permission is theirs) but not
    // turn it into an administrator, nor edit an administrator.
    await expect(service.update(logistics, 'd1', { phone: '+233' })).resolves.toMatchObject({ phone: '+233' });
    await expect(service.update(logistics, 'd1', { role: 'COMPANY_ADMIN' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.update(logistics, 'a1', { phone: '1' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.update(admin, 'd1', { role: 'SUPER_ADMIN' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(row('d1').role).toBe('DRIVER');
  });

  it('signs a deactivated account out everywhere', async () => {
    const { service, prisma, row } = setup();
    await service.update(admin, 'l1', { isActive: false });
    expect(row('l1').isActive).toBe(false);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'l1', revokedAt: null } }),
    );
  });

  it('links, moves and unlinks the driver profile', async () => {
    const { service, drivers } = setup();
    const driverOf = (id: string) => drivers.find((d) => d.id === id)?.userId;

    await service.update(admin, 'd1', { driverId: 'drv1' });
    expect(driverOf('drv1')).toBe('d1');
    expect(driverOf('drv2')).toBeNull(); // one profile per account

    await service.update(admin, 'd1', { driverId: null });
    expect(driverOf('drv1')).toBeNull();

    await expect(service.update(admin, 'l1', { driverId: 'drv1' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update(admin, 'd1', { driverId: 'drv3' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('drops the driver profile when the account stops being a DRIVER', async () => {
    const { service, drivers } = setup();
    const updated = await service.update(admin, 'd1', { role: 'VIEWER' });
    expect(drivers.find((d) => d.id === 'drv2')?.userId).toBeNull();
    expect(updated.driver).toBeNull();
  });

  it('clears the phone with null', async () => {
    const { service, row } = setup();
    row('l1').phone = '+233';
    await service.update(admin, 'l1', { phone: null });
    expect(row('l1').phone).toBeNull();
  });
});

/* ---------------------------------------------------------- reset password */

describe('UsersService.resetPassword', () => {
  it('returns a new temporary password once, unlocks the account and revokes its sessions', async () => {
    const { service, row, prisma } = setup();
    const result = await service.resetPassword(admin, 'd1');

    expect(result.temporaryPassword).toMatch(STRONG_PASSWORD);
    expect(result).toMatchObject({ id: 'd1', mustChangePassword: true, lockedUntil: null });
    const stored = row('d1');
    expect(stored.failedLoginCount).toBe(0);
    expect(stored.lockedUntil).toBeNull();
    expect(stored.mustChangePassword).toBe(true);
    expect(stored.passwordHash).not.toBe('argon2id$old');
    expect(stored.passwordHash).not.toContain(result.temporaryPassword);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'd1', revokedAt: null } }),
    );
  });

  it('gives a different password each time', async () => {
    const { service } = setup();
    const first = await service.resetPassword(admin, 'd1');
    const second = await service.resetPassword(admin, 'd1');
    expect(first.temporaryPassword).not.toBe(second.temporaryPassword);
  });

  it('is not how you change your own password', async () => {
    const { service } = setup();
    await expect(service.resetPassword(admin, 'a1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

/* -------------------------------------------------------------- deactivate */

describe('UsersService.deactivate', () => {
  it('deactivates and revokes sessions', async () => {
    const { service, row, prisma } = setup();
    const result = await service.deactivate(admin, 'd1');
    expect(result.isActive).toBe(false);
    expect(row('d1').isActive).toBe(false);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'd1', revokedAt: null } }),
    );
  });

  it('refuses to deactivate yourself', async () => {
    const { service } = setup();
    await expect(service.deactivate(admin, 'a1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

/* -------------------------------------------------------------------- DTOs */

describe('users DTOs', () => {
  const errors = async (cls: new () => object, body: object) =>
    (await validate(plainToInstance(cls, body))).map((e) => e.property).sort();

  it('normalises the e-mail and trims names', () => {
    const dto = createDto({ email: ' Kofi@ACME.test ', firstName: '  Kofi ' });
    expect(dto.email).toBe('kofi@acme.test');
    expect(dto.firstName).toBe('Kofi');
  });

  it('rejects a weak chosen temporary password and unknown roles', async () => {
    await expect(
      errors(CreateUserDto, { email: 'a@b.co', firstName: 'A', lastName: 'B', role: 'VIEWER', temporaryPassword: 'weakpassword' }),
    ).resolves.toEqual(['temporaryPassword']);
    await expect(errors(CreateUserDto, { email: 'a@b.co', firstName: 'A', lastName: 'B', role: 'GOD' })).resolves.toEqual([
      'role',
    ]);
  });

  it('accepts null only where a value can be cleared', async () => {
    await expect(errors(UpdateUserDto, { phone: null, driverId: null })).resolves.toEqual([]);
    await expect(errors(UpdateUserDto, { firstName: null, role: null, isActive: null })).resolves.toEqual([
      'firstName',
      'isActive',
      'role',
    ]);
    expect(plainToInstance(UpdateUserDto, { phone: '   ' }).phone).toBeNull();
  });
});
