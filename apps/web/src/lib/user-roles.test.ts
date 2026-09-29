import { describe, expect, it } from 'vitest';
import { accountStatus, assignableRoles, canAssignRole, canManageRole, passwordGroups } from './user-roles';

describe('role rules (mirror of the API)', () => {
  it('lets an administrator give every company role, never SUPER_ADMIN', () => {
    const roles = assignableRoles('COMPANY_ADMIN');
    expect(roles).not.toContain('SUPER_ADMIN');
    expect(roles).toContain('COMPANY_ADMIN');
    expect(roles).toContain('DRIVER');
    expect(roles).toHaveLength(9);
  });

  it('never offers a role with more permissions than the actor', () => {
    expect(canAssignRole('LOGISTICS_MANAGER', 'COMPANY_ADMIN')).toBe(false);
    expect(canAssignRole('LOGISTICS_MANAGER', 'DRIVER')).toBe(true);
    expect(canAssignRole('VIEWER', 'DRIVER')).toBe(false);
    expect(canAssignRole('SUPER_ADMIN', 'SUPER_ADMIN')).toBe(false);
  });

  it('only lets an equal or stronger role manage an account', () => {
    expect(canManageRole('COMPANY_ADMIN', 'DRIVER')).toBe(true);
    expect(canManageRole('COMPANY_ADMIN', 'SUPER_ADMIN')).toBe(false);
    expect(canManageRole('VIEWER', 'COMPANY_ADMIN')).toBe(false);
  });
});

describe('accountStatus', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const base = { isActive: true, lockedUntil: null, mustChangePassword: false };

  it('reports the status that needs attention first', () => {
    expect(accountStatus(base, now)).toBe('active');
    expect(accountStatus({ ...base, mustChangePassword: true }, now)).toBe('mustChange');
    expect(accountStatus({ ...base, mustChangePassword: true, lockedUntil: '2026-09-29T12:10:00Z' }, now)).toBe('locked');
    expect(accountStatus({ ...base, isActive: false, lockedUntil: '2026-09-29T12:10:00Z' }, now)).toBe('inactive');
  });

  it('forgets a lockout that has expired', () => {
    expect(accountStatus({ ...base, lockedUntil: '2026-09-29T11:00:00Z' }, now)).toBe('active');
  });
});

describe('passwordGroups', () => {
  it('splits into fours without losing a character', () => {
    expect(passwordGroups('Kx7mPq3rTz9wHb4n')).toEqual(['Kx7m', 'Pq3r', 'Tz9w', 'Hb4n']);
    expect(passwordGroups('Chosen-Passw0rd').join('')).toBe('Chosen-Passw0rd');
    expect(passwordGroups('')).toEqual([]);
  });
});
