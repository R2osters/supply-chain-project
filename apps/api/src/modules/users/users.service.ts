import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ROLE_PERMISSIONS, USER_ROLES, roleHasPermission, type UserRole } from '@scip/shared';
import { paginated, safeOrderBy, type PaginatedResult } from '../../common/dto/pagination.dto';
import { companyFilter, requireCompanyId } from '../../common/tenancy/tenant-scope';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { TemporaryPasswordService } from '../auth/temporary-password.service';
import type { CreateUserDto, UpdateUserDto, UserQueryDto } from './users.dto';

/** What an administrator may see of an account. Never the hash, never a token. */
export const USER_SELECT = {
  id: true,
  companyId: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  role: true,
  isActive: true,
  lockedUntil: true,
  lastLoginAt: true,
  mustChangePassword: true,
  createdAt: true,
  isDemoData: true,
  linkedSupplierId: true,
  linkedCustomerId: true,
  driverProfile: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.UserSelect;

type UserRecord = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

export interface UserView extends Omit<UserRecord, 'driverProfile' | 'role'> {
  role: UserRole;
  /** The driver profile (Driver.userId = this account), for DRIVER accounts. */
  driver: { id: string; name: string } | null;
}

/** A created or reset account, with the temporary password the caller sees exactly once. */
export type UserWithTemporaryPassword = UserView & { temporaryPassword: string };

const SORTABLE = ['createdAt', 'lastName', 'firstName', 'email', 'role', 'lastLoginAt'] as const;

type Tx = Prisma.TransactionClient;

export function toUserView(row: UserRecord): UserView {
  const { driverProfile, ...rest } = row;
  return {
    ...rest,
    role: rest.role as UserRole,
    driver: driverProfile
      ? { id: driverProfile.id, name: `${driverProfile.firstName} ${driverProfile.lastName}`.trim() }
      : null,
  };
}

/**
 * Whether `actor` may give `role` to someone. Never SUPER_ADMIN (that role is not handed out
 * from inside a company); COMPANY_ADMIN only by an administrator; and in general never a role
 * holding a permission the actor lacks — so widening `user:create` to another role in the RBAC
 * matrix one day cannot become a way to mint administrators.
 */
export function canAssignRole(actorRole: UserRole, role: UserRole): boolean {
  if (role === 'SUPER_ADMIN') return false;
  if (role === 'COMPANY_ADMIN' && actorRole !== 'COMPANY_ADMIN' && actorRole !== 'SUPER_ADMIN') return false;
  return ROLE_PERMISSIONS[role].every((permission) => roleHasPermission(actorRole, permission));
}

/** Roles `actor` may hand out, in the matrix's order. */
export function assignableRoles(actorRole: UserRole): UserRole[] {
  return USER_ROLES.filter((role) => canAssignRole(actorRole, role));
}

/** Whether `actor` may edit, reset or deactivate an account holding `targetRole`. */
export function canManageRole(actorRole: UserRole, targetRole: UserRole): boolean {
  return ROLE_PERMISSIONS[targetRole].every((permission) => roleHasPermission(actorRole, permission));
}

/**
 * Company members: the screen an administrator uses to add colleagues and drivers on an install
 * that cannot send invitations by e-mail. New accounts and resets get a temporary password,
 * returned once and never stored in clear; its holder must replace it at the next sign-in.
 *
 * Invariants kept here, whatever the client sends:
 * - tenant isolation: another company's account is reported as missing (404), not forbidden;
 * - nobody changes their own role or deactivates themselves;
 * - a company always keeps at least one active COMPANY_ADMIN (409 otherwise);
 * - no role escalation (see canAssignRole).
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly temporaryPasswords: TemporaryPasswordService,
  ) {}

  async list(actor: AuthenticatedUser, query: UserQueryDto): Promise<PaginatedResult<UserView>> {
    const term = query.search?.trim();
    const where: Prisma.UserWhereInput = {
      ...companyFilter(actor),
      ...(query.role ? { role: query.role } : {}),
      ...(term
        ? {
            OR: [
              { email: { contains: term, mode: 'insensitive' } },
              { firstName: { contains: term, mode: 'insensitive' } },
              { lastName: { contains: term, mode: 'insensitive' } },
              { phone: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: USER_SELECT,
        orderBy: safeOrderBy(query, SORTABLE, 'createdAt'),
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginated(rows.map(toUserView), total, query);
  }

  async findOne(actor: AuthenticatedUser, id: string): Promise<UserView> {
    return toUserView(await this.load(actor, id));
  }

  async create(actor: AuthenticatedUser, dto: CreateUserDto): Promise<UserWithTemporaryPassword> {
    this.assertCanAssign(actor, dto.role);
    const companyId = requireCompanyId(actor, dto.companyId);
    if (dto.driverId && dto.role !== 'DRIVER') {
      throw new BadRequestException('Only a DRIVER account can be linked to a driver');
    }
    const links = await this.partyLinks(companyId, dto.role, dto, null);

    const taken = await this.prisma.user.findUnique({ where: { email: dto.email }, select: { id: true } });
    if (taken) throw new ConflictException('An account with this email already exists');

    const { temporaryPassword, passwordHash } = await this.temporaryPasswords.prepare(dto.temporaryPassword);

    const row = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          companyId,
          email: dto.email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone ?? null,
          role: dto.role,
          mustChangePassword: true,
          ...links,
        },
        select: { id: true },
      });
      if (dto.driverId) await this.linkDriver(tx, companyId, user.id, dto.driverId);
      return tx.user.findUniqueOrThrow({ where: { id: user.id }, select: USER_SELECT });
    });

    return { ...toUserView(row), temporaryPassword };
  }

  async update(actor: AuthenticatedUser, id: string, dto: UpdateUserDto): Promise<UserView> {
    const target = await this.load(actor, id);
    this.assertCanManage(actor, target);

    const self = target.id === actor.id;
    const nextRole = (dto.role ?? target.role) as UserRole;
    const roleChange = dto.role !== undefined && dto.role !== target.role;
    const deactivation = dto.isActive === false && target.isActive;

    if (self && roleChange) throw new ForbiddenException('You cannot change your own role');
    if (self && deactivation) throw new ForbiddenException('You cannot deactivate your own account');
    if (roleChange) this.assertCanAssign(actor, nextRole);
    if (typeof dto.driverId === 'string' && nextRole !== 'DRIVER') {
      throw new BadRequestException('Only a DRIVER account can be linked to a driver');
    }

    const data: Prisma.UserUncheckedUpdateInput = {
      ...(await this.partyLinks(target.companyId, nextRole, dto, target)),
    };
    if (dto.firstName !== undefined) data.firstName = dto.firstName;
    if (dto.lastName !== undefined) data.lastName = dto.lastName;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (roleChange) data.role = nextRole;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    const leavesAdmins = target.role === 'COMPANY_ADMIN' && target.isActive && (roleChange || deactivation);

    const row = await this.prisma.$transaction(async (tx) => {
      if (leavesAdmins) await this.assertNotLastAdmin(tx, target);
      await tx.user.update({ where: { id }, data });

      if (dto.driverId === null || (roleChange && nextRole !== 'DRIVER')) {
        // Only a DRIVER account can own a driver profile (DriversService enforces the same).
        await tx.driver.updateMany({ where: { userId: id }, data: { userId: null } });
      } else if (typeof dto.driverId === 'string') {
        await this.linkDriver(tx, target.companyId, id, dto.driverId);
      }

      if (deactivation) await this.revokeSessions(tx, id);
      return tx.user.findUniqueOrThrow({ where: { id }, select: USER_SELECT });
    });
    return toUserView(row);
  }

  /** New temporary password, returned once. Clears the lockout and ends every session. */
  async resetPassword(actor: AuthenticatedUser, id: string): Promise<UserWithTemporaryPassword> {
    const target = await this.load(actor, id);
    this.assertCanManage(actor, target);
    if (target.id === actor.id) {
      throw new ForbiddenException('Use "change password" for your own account');
    }
    const { temporaryPassword } = await this.temporaryPasswords.reset(id);
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id }, select: USER_SELECT });
    return { ...toUserView(row), temporaryPassword };
  }

  /**
   * Soft delete: the account keeps its history (orders it approved, incidents it reported) but
   * can no longer sign in, and its open sessions end now rather than at their expiry.
   */
  async deactivate(actor: AuthenticatedUser, id: string): Promise<UserView> {
    const target = await this.load(actor, id);
    this.assertCanManage(actor, target);
    if (target.id === actor.id) throw new ForbiddenException('You cannot deactivate your own account');

    const row = await this.prisma.$transaction(async (tx) => {
      if (target.role === 'COMPANY_ADMIN' && target.isActive) await this.assertNotLastAdmin(tx, target);
      await tx.user.update({ where: { id }, data: { isActive: false } });
      await this.revokeSessions(tx, id);
      return tx.user.findUniqueOrThrow({ where: { id }, select: USER_SELECT });
    });
    return toUserView(row);
  }

  /* ---------------------------------------------------------------- helpers */

  /** Another tenant's account is reported as missing: a 403 would confirm that the id exists. */
  private async load(actor: AuthenticatedUser, id: string): Promise<UserRecord> {
    const row = await this.prisma.user.findUnique({ where: { id }, select: USER_SELECT });
    if (!row || (actor.role !== 'SUPER_ADMIN' && row.companyId !== actor.companyId)) {
      throw new NotFoundException(`No user found with id ${id}`);
    }
    return row;
  }

  private assertCanAssign(actor: AuthenticatedUser, role: UserRole): void {
    if (role === 'SUPER_ADMIN') throw new ForbiddenException('The SUPER_ADMIN role cannot be given from SCIP');
    if (!canAssignRole(actor.role, role)) {
      throw new ForbiddenException(
        role === 'COMPANY_ADMIN'
          ? 'Only an administrator can appoint another administrator'
          : `Your role cannot give the ${role} role`,
      );
    }
  }

  private assertCanManage(actor: AuthenticatedUser, target: UserRecord): void {
    if (!canManageRole(actor.role, target.role as UserRole)) {
      throw new ForbiddenException(`Your role cannot manage a ${target.role} account`);
    }
  }

  /**
   * Refuses to leave a company without an active administrator: nobody could then add
   * colleagues, reset a password or change a setting, and on a desktop install there is no
   * operator above the company to fix it.
   */
  private async assertNotLastAdmin(tx: Tx, target: UserRecord): Promise<void> {
    if (!target.companyId) return;
    // Row lock on the company: two administrators demoting each other at the same instant must
    // not both see "one other administrator left".
    await tx.$queryRaw`SELECT id FROM "companies" WHERE id = ${target.companyId} FOR UPDATE`;
    const others = await tx.user.count({
      where: { companyId: target.companyId, role: 'COMPANY_ADMIN', isActive: true, id: { not: target.id } },
    });
    if (others === 0) {
      throw new ConflictException(
        'This is the last active administrator of the company: appoint another administrator first',
      );
    }
  }

  private async revokeSessions(tx: Tx, userId: string): Promise<void> {
    await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  /** Driver.userId is unique: the account's previous profile, if any, is unlinked first. */
  private async linkDriver(tx: Tx, companyId: string | null, userId: string, driverId: string): Promise<void> {
    const driver = await tx.driver.findUnique({
      where: { id: driverId },
      select: { id: true, companyId: true, userId: true },
    });
    if (!driver || driver.companyId !== companyId) {
      throw new BadRequestException('That driver does not belong to this company');
    }
    if (driver.userId && driver.userId !== userId) {
      throw new ConflictException('That driver is already linked to another account');
    }
    await tx.driver.updateMany({ where: { userId, NOT: { id: driverId } }, data: { userId: null } });
    await tx.driver.update({ where: { id: driverId }, data: { userId } });
  }

  /**
   * Supplier / customer portal links. A SUPPLIER account sees only its supplier's rows, so it
   * needs one (same rule as /auth/invite); any other role drops the link. The requirement is
   * enforced when the account becomes a portal account or the link is edited, so editing the
   * phone number of an older, unlinked account is not refused.
   */
  private async partyLinks(
    companyId: string | null,
    role: UserRole,
    given: { linkedSupplierId?: string | null; linkedCustomerId?: string | null },
    current: Pick<UserRecord, 'role' | 'linkedSupplierId' | 'linkedCustomerId'> | null,
  ): Promise<{ linkedSupplierId: string | null; linkedCustomerId: string | null }> {
    const resolve = async (
      kind: 'SUPPLIER' | 'CUSTOMER',
      field: 'linkedSupplierId' | 'linkedCustomerId',
    ): Promise<string | null> => {
      const givenId = given[field];
      if (role !== kind) {
        if (givenId) throw new BadRequestException(`${field} only applies to a ${kind} account`);
        return null;
      }
      const currentId = current?.[field] ?? null;
      const next = givenId !== undefined ? givenId : currentId;
      const mustHave = !current || current.role !== kind || givenId !== undefined;
      if (!next && mustHave) throw new BadRequestException(`${field} is required for a ${kind} portal account`);
      if (typeof givenId === 'string' && givenId !== currentId) await this.assertPartyOwned(kind, givenId, companyId);
      return next ?? null;
    };
    return {
      linkedSupplierId: await resolve('SUPPLIER', 'linkedSupplierId'),
      linkedCustomerId: await resolve('CUSTOMER', 'linkedCustomerId'),
    };
  }

  private async assertPartyOwned(kind: 'SUPPLIER' | 'CUSTOMER', id: string, companyId: string | null): Promise<void> {
    const row =
      kind === 'SUPPLIER'
        ? await this.prisma.supplier.findUnique({ where: { id }, select: { companyId: true } })
        : await this.prisma.customer.findUnique({ where: { id }, select: { companyId: true } });
    if (!row || row.companyId !== companyId) {
      throw new BadRequestException(
        `${kind === 'SUPPLIER' ? 'linkedSupplierId' : 'linkedCustomerId'} does not belong to this company`,
      );
    }
  }
}
