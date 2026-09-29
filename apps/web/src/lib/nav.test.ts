import { roleHasPermission, USER_ROLES, type UserRole } from '@scip/shared';
import { describe, expect, it } from 'vitest';
import { homeFor, pageFor } from './nav';

describe('homeFor', () => {
  it('opens office roles on the control dashboard', () => {
    for (const role of ['SUPER_ADMIN', 'COMPANY_ADMIN', 'SUPPLY_CHAIN_MANAGER', 'LOGISTICS_MANAGER', 'VIEWER']) {
      expect(homeFor(role)).toBe('/dashboard');
    }
  });

  it('opens party-scoped roles on their own work', () => {
    expect(homeFor('DRIVER')).toBe('/deliveries');
    expect(homeFor('SUPPLIER')).toBe('/purchase-orders');
    expect(homeFor('CUSTOMER')).toBe('/shipments');
  });

  it('never lands a role on a page it would be refused', () => {
    for (const role of USER_ROLES) {
      const page = pageFor(homeFor(role));
      expect(page, role).toBeDefined();
      if (page?.permission) expect(roleHasPermission(role as UserRole, page.permission), role).toBe(true);
    }
  });

  it('falls back to the account page for a role it does not know', () => {
    expect(homeFor('INTERN')).toBe('/account');
  });
});

describe('pageFor', () => {
  it('finds the module of a nested page', () => {
    expect(pageFor('/shipments/detail')?.href).toBe('/shipments');
    expect(pageFor('/users')?.permission).toBe('user:read');
    expect(pageFor('/account')?.permission).toBeNull();
  });

  it('knows nothing of pages outside the navigation', () => {
    expect(pageFor('/notifications')).toBeUndefined();
    expect(pageFor('/dashboards')).toBeUndefined();
  });
});
