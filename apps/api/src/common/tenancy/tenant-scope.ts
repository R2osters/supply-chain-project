import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Multi-tenant isolation.
 *
 * Deliberately a set of explicit helpers rather than a Prisma middleware that rewrites every
 * query: a middleware silently changes the meaning of code you are reading, and one model it
 * does not know about (a join table, a raw query) becomes a cross-tenant leak that no test
 * catches. Here the filter is visible at the call site and `requireCompanyId` throws loudly if a
 * service forgets it.
 */

/** The tenant filter for a normal listing. SUPER_ADMIN gets `{}` — all companies. */
export function companyFilter(user: AuthenticatedUser): { companyId?: string } {
  if (user.role === 'SUPER_ADMIN') return {};
  if (!user.companyId) {
    throw new ForbiddenException('User is not attached to a company');
  }
  return { companyId: user.companyId };
}

/** The company a write must be attributed to. Throws for a tenant-less non-super-admin. */
export function requireCompanyId(user: AuthenticatedUser, explicit?: string | null): string {
  if (user.role === 'SUPER_ADMIN') {
    if (!explicit) {
      throw new ForbiddenException('SUPER_ADMIN must specify companyId explicitly');
    }
    return explicit;
  }
  if (!user.companyId) throw new ForbiddenException('User is not attached to a company');
  if (explicit && explicit !== user.companyId) {
    throw new ForbiddenException('Cannot write outside your own company');
  }
  return user.companyId;
}

/** Throws unless `row.companyId` belongs to the caller. Use after any findUnique by id. */
export function assertSameCompany(
  user: AuthenticatedUser,
  row: { companyId?: string | null } | null | undefined,
  entity = 'resource',
): void {
  if (!row) return;
  if (user.role === 'SUPER_ADMIN') return;
  if (row.companyId && row.companyId !== user.companyId) {
    throw new ForbiddenException(`This ${entity} belongs to another company`);
  }
}

/**
 * Extra row-level filter for roles that may only see records they are party to.
 * A DRIVER sees the shipments assigned to them; a SUPPLIER sees the shipments for their own POs;
 * a CUSTOMER sees the shipments addressed to them.
 */
export function shipmentPartyFilter(user: AuthenticatedUser): Record<string, unknown> {
  switch (user.role) {
    case 'DRIVER':
      return { driver: { userId: user.id } };
    case 'SUPPLIER':
      return user.linkedSupplierId
        ? { purchaseOrder: { supplierId: user.linkedSupplierId } }
        : { id: '__none__' };
    case 'CUSTOMER':
      return user.linkedCustomerId ? { customerId: user.linkedCustomerId } : { id: '__none__' };
    default:
      return {};
  }
}

export function purchaseOrderPartyFilter(user: AuthenticatedUser): Record<string, unknown> {
  if (user.role === 'SUPPLIER') {
    return user.linkedSupplierId ? { supplierId: user.linkedSupplierId } : { id: '__none__' };
  }
  if (user.role === 'CUSTOMER' || user.role === 'DRIVER') {
    // Neither party has a legitimate view of procurement documents.
    return { id: '__none__' };
  }
  return {};
}

/** Combines tenant + party filters into one Prisma `where`. */
export function scopedShipmentWhere(
  user: AuthenticatedUser,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...companyFilter(user), ...shipmentPartyFilter(user), ...extra };
}
