import { USER_ROLES, type UserRole } from './enums';

/**
 * Permissions are `<resource>:<action>` strings. They are the only thing guards check —
 * roles are never tested directly in business code, so adding a role is a data change here
 * rather than a code change across 20 controllers.
 *
 * Scope note: a permission grants access *within the caller's company*. Cross-company access is
 * a separate concern handled by the company-scoping interceptor, and only SUPER_ADMIN escapes it.
 */

export const RESOURCES = [
  'company',
  'user',
  'supplier',
  'customer',
  'carrier',
  'warehouse',
  'vehicle',
  'driver',
  'product',
  'inventory',
  'purchase_order',
  'shipment',
  'gps',
  'delivery',
  'incident',
  'notification',
  'analytics',
  'ai',
  'recommendation',
  'scenario',
  'audit',
] as const;
export type Resource = (typeof RESOURCES)[number];

export const ACTIONS = ['read', 'create', 'update', 'delete', 'approve', 'export'] as const;
export type Action = (typeof ACTIONS)[number];

export type Permission = `${Resource}:${Action}`;

export const ALL_PERMISSIONS: Permission[] = RESOURCES.flatMap((r) =>
  ACTIONS.map((a) => `${r}:${a}` as Permission),
);

const readAll: Permission[] = RESOURCES.map((r) => `${r}:read` as Permission);

/** Full CRUD on a resource, minus destructive/approval unless listed. */
const crud = (r: Resource): Permission[] => [`${r}:read`, `${r}:create`, `${r}:update`];
const crudFull = (r: Resource): Permission[] => [...crud(r), `${r}:delete`];

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  SUPER_ADMIN: ALL_PERMISSIONS,

  COMPANY_ADMIN: ALL_PERMISSIONS.filter((p) => !p.startsWith('company:delete')),

  SUPPLY_CHAIN_MANAGER: [
    ...readAll,
    ...crud('purchase_order'),
    'purchase_order:approve',
    ...crud('shipment'),
    ...crud('inventory'),
    ...crud('product'),
    ...crud('supplier'),
    ...crud('incident'),
    ...crud('scenario'),
    'recommendation:create',
    'recommendation:update',
    'recommendation:approve',
    'ai:create',
    'analytics:export',
    'notification:update',
  ],

  LOGISTICS_MANAGER: [
    ...readAll.filter((p) => !p.startsWith('audit') && !p.startsWith('user')),
    ...crud('shipment'),
    ...crud('vehicle'),
    ...crud('driver'),
    ...crud('carrier'),
    ...crud('delivery'),
    ...crud('incident'),
    'incident:approve',
    'gps:create',
    'ai:create',
    'analytics:export',
    'notification:update',
  ],

  PROCUREMENT_MANAGER: [
    'supplier:read',
    'supplier:create',
    'supplier:update',
    'supplier:delete',
    'product:read',
    'inventory:read',
    'warehouse:read',
    'purchase_order:read',
    'purchase_order:create',
    'purchase_order:update',
    'purchase_order:approve',
    'shipment:read',
    'analytics:read',
    'analytics:export',
    'ai:read',
    'ai:create',
    'recommendation:read',
    'recommendation:update',
    'recommendation:approve',
    'scenario:read',
    'scenario:create',
    'notification:read',
    'notification:update',
    'company:read',
  ],

  WAREHOUSE_MANAGER: [
    'company:read',
    'warehouse:read',
    'warehouse:update',
    ...crudFull('inventory'),
    ...crud('product'),
    'shipment:read',
    'shipment:update',
    'delivery:read',
    'delivery:update',
    'purchase_order:read',
    'incident:read',
    'incident:create',
    'incident:update',
    'analytics:read',
    'notification:read',
    'notification:update',
    'recommendation:read',
  ],

  DRIVER: [
    'shipment:read',
    'shipment:update',
    'gps:create',
    'gps:read',
    'delivery:read',
    'delivery:update',
    'incident:read',
    'incident:create',
    'vehicle:read',
    'notification:read',
    'notification:update',
  ],

  SUPPLIER: [
    'purchase_order:read',
    'purchase_order:update',
    'shipment:read',
    'shipment:create',
    'shipment:update',
    'product:read',
    'notification:read',
    'notification:update',
  ],

  CUSTOMER: ['shipment:read', 'delivery:read', 'incident:read', 'incident:create', 'notification:read', 'notification:update'],

  VIEWER: [...readAll.filter((p) => !p.startsWith('audit'))],
};

/** Deduplicated lookup used by the API's PermissionsGuard — O(1) per check instead of O(n). */
export const ROLE_PERMISSION_SET: Record<UserRole, ReadonlySet<Permission>> = USER_ROLES.reduce(
  (acc, role) => {
    acc[role] = new Set(ROLE_PERMISSIONS[role]);
    return acc;
  },
  {} as Record<UserRole, ReadonlySet<Permission>>,
);

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSION_SET[role]?.has(permission) ?? false;
}

/**
 * Roles whose visibility is limited to rows they are party to (their own shipments,
 * their own POs) rather than everything in the company.
 */
export const PARTY_SCOPED_ROLES: UserRole[] = ['DRIVER', 'SUPPLIER', 'CUSTOMER'];
