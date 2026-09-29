import { ROLE_PERMISSIONS, USER_ROLES, roleHasPermission, type UserRole } from '@scip/shared';

/**
 * The API's role rules for the Users screen (apps/api/src/modules/users/users.service.ts), so the
 * role list only offers what the server would accept:
 * - SUPER_ADMIN is never handed out from inside a company;
 * - COMPANY_ADMIN only by an administrator;
 * - never a role holding a permission the actor lacks.
 */
export function canAssignRole(actorRole: UserRole, role: UserRole): boolean {
  if (role === 'SUPER_ADMIN') return false;
  if (role === 'COMPANY_ADMIN' && actorRole !== 'COMPANY_ADMIN' && actorRole !== 'SUPER_ADMIN') return false;
  return ROLE_PERMISSIONS[role].every((permission) => roleHasPermission(actorRole, permission));
}

/** Roles the actor may give, in the matrix's order (most powerful first). */
export function assignableRoles(actorRole: UserRole): UserRole[] {
  return USER_ROLES.filter((role) => canAssignRole(actorRole, role));
}

/** Whether the actor may edit, reset or deactivate an account holding `targetRole`. */
export function canManageRole(actorRole: UserRole, targetRole: UserRole): boolean {
  return ROLE_PERMISSIONS[targetRole].every((permission) => roleHasPermission(actorRole, permission));
}

export type AccountStatus = 'inactive' | 'locked' | 'mustChange' | 'active';

/**
 * One status per account, the one that needs attention first: deactivated, then locked out
 * (too many failed sign-ins), then still on a temporary password, else active.
 */
export function accountStatus(
  account: { isActive: boolean; lockedUntil: string | null; mustChangePassword: boolean },
  now: number = Date.now(),
): AccountStatus {
  if (!account.isActive) return 'inactive';
  if (account.lockedUntil && new Date(account.lockedUntil).getTime() > now) return 'locked';
  if (account.mustChangePassword) return 'mustChange';
  return 'active';
}

/** Groups of four for reading a password out loud; copying still gives the exact string. */
export function passwordGroups(password: string, size = 4): string[] {
  return password.match(new RegExp(`.{1,${size}}`, 'gs')) ?? [];
}
