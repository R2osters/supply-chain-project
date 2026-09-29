import {
  ClipboardList,
  Database,
  Factory,
  FlaskConical,
  KeyRound,
  LayoutDashboard,
  Map,
  Package,
  Radar,
  RadioTower,
  Route,
  Settings,
  Ship,
  Sparkles,
  Split,
  TrendingUp,
  TriangleAlert,
  Truck,
  Users,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@scip/shared';
import type { TranslationKey } from './i18n';

export type Pillar = 'TRACK' | 'OPTIMISE' | 'NETWORK';

export interface NavItem {
  href: string;
  labelKey: TranslationKey;
  permission: Permission;
  pillar: Pillar;
  icon: LucideIcon;
}

/**
 * Three pillars, then the pillar's modules as pills (charte §07 "Navigation"). The order inside a
 * pillar follows the operator's day: what needs a decision, where things are, what went wrong.
 */
export const NAV: NavItem[] = [
  { href: '/dashboard', labelKey: 'nav.control', permission: 'analytics:read', pillar: 'TRACK', icon: LayoutDashboard },
  { href: '/map', labelKey: 'nav.map', permission: 'gps:read', pillar: 'TRACK', icon: Map },
  { href: '/situation', labelKey: 'nav.situation', permission: 'gps:read', pillar: 'TRACK', icon: Radar },
  { href: '/shipments', labelKey: 'nav.shipments', permission: 'shipment:read', pillar: 'TRACK', icon: Package },
  { href: '/incidents', labelKey: 'nav.incidents', permission: 'incident:read', pillar: 'TRACK', icon: TriangleAlert },
  { href: '/deliveries', labelKey: 'nav.deliveries', permission: 'delivery:read', pillar: 'TRACK', icon: Truck },
  { href: '/maritime', labelKey: 'nav.maritime', permission: 'gps:read', pillar: 'TRACK', icon: Ship },
  { href: '/devices', labelKey: 'dev.nav', permission: 'vehicle:read', pillar: 'TRACK', icon: RadioTower },

  { href: '/recommendations', labelKey: 'nav.recommendations', permission: 'recommendation:read', pillar: 'OPTIMISE', icon: Sparkles },
  { href: '/forecasting', labelKey: 'nav.forecasting', permission: 'ai:read', pillar: 'OPTIMISE', icon: TrendingUp },
  { href: '/allocation', labelKey: 'nav.allocation', permission: 'ai:read', pillar: 'OPTIMISE', icon: Split },
  { href: '/scenarios', labelKey: 'nav.scenarios', permission: 'scenario:read', pillar: 'OPTIMISE', icon: FlaskConical },
  { href: '/routing', labelKey: 'nav.routing', permission: 'ai:read', pillar: 'OPTIMISE', icon: Route },

  { href: '/suppliers', labelKey: 'nav.suppliers', permission: 'supplier:read', pillar: 'NETWORK', icon: Factory },
  { href: '/purchase-orders', labelKey: 'nav.orders', permission: 'purchase_order:read', pillar: 'NETWORK', icon: ClipboardList },
  { href: '/inventory', labelKey: 'nav.inventory', permission: 'inventory:read', pillar: 'NETWORK', icon: Warehouse },
  { href: '/master-data', labelKey: 'md.nav', permission: 'product:read', pillar: 'NETWORK', icon: Database },
];

/**
 * Account pages: reached from the account menu rather than a pillar's module row, and listed in
 * the ⌘K palette too. `permission: null` is open to every signed-in user.
 */
export interface AccountNavItem {
  href: string;
  labelKey: TranslationKey;
  permission: Permission | null;
  icon: LucideIcon;
}

export const ACCOUNT_NAV: AccountNavItem[] = [
  { href: '/users', labelKey: 'users.nav', permission: 'user:read', icon: Users },
  { href: '/settings', labelKey: 'settings.nav', permission: 'company:update', icon: Settings },
  { href: '/account', labelKey: 'account.nav', permission: null, icon: KeyRound },
];

export const PILLARS: Array<{ id: Pillar; labelKey: TranslationKey; icon: LucideIcon }> = [
  { id: 'TRACK', labelKey: 'nav.pillar.track', icon: Radar },
  { id: 'OPTIMISE', labelKey: 'nav.pillar.optimise', icon: Sparkles },
  { id: 'NETWORK', labelKey: 'nav.pillar.network', icon: Factory },
];

export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
