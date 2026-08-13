'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Permission } from '@scip/shared';

interface NavItem {
  href: string;
  label: string;
  permission: Permission;
  context: 'TRACK' | 'OPTIMISE' | 'DATA';
}

/**
 * Navigation is grouped by the two halves of the product rather than alphabetically, because the
 * split is the product's actual mental model: "where is my cargo" and "what should I do next"
 * are different jobs, often different people.
 */
const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Control', permission: 'analytics:read', context: 'TRACK' },
  { href: '/map', label: 'Live map', permission: 'gps:read', context: 'TRACK' },
  { href: '/shipments', label: 'Shipments', permission: 'shipment:read', context: 'TRACK' },
  { href: '/deliveries', label: 'Deliveries', permission: 'delivery:read', context: 'TRACK' },
  { href: '/incidents', label: 'Incidents', permission: 'incident:read', context: 'TRACK' },

  { href: '/recommendations', label: 'Advice', permission: 'recommendation:read', context: 'OPTIMISE' },
  { href: '/forecasting', label: 'Forecasting', permission: 'ai:read', context: 'OPTIMISE' },
  { href: '/allocation', label: 'Allocation', permission: 'ai:read', context: 'OPTIMISE' },
  { href: '/routing', label: 'Routing', permission: 'ai:read', context: 'OPTIMISE' },
  { href: '/scenarios', label: 'Scenarios', permission: 'scenario:read', context: 'OPTIMISE' },

  { href: '/inventory', label: 'Inventory', permission: 'inventory:read', context: 'DATA' },
  { href: '/purchase-orders', label: 'Orders', permission: 'purchase_order:read', context: 'DATA' },
  { href: '/suppliers', label: 'Suppliers', permission: 'supplier:read', context: 'DATA' },
];

const CONTEXT_LABEL = {
  TRACK: 'Track',
  OPTIMISE: 'Optimise',
  DATA: 'Master data',
} as const;

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut, can } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  const { data: unread } = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => api<{ unread: number }>('/notifications/unread-count'),
    enabled: Boolean(user),
    refetchInterval: 30_000,
  });

  const { data: aiStatus } = useQuery({
    queryKey: ['ai', 'status'],
    queryFn: () => api<{ reachable: boolean; detail: string }>('/ai/status'),
    enabled: Boolean(user),
    refetchInterval: 60_000,
  });

  if (loading || !user) {
    return (
      <div className="deck-surface flex min-h-screen items-center justify-center">
        <span className="font-mono text-[0.6875rem] uppercase tracking-[0.2em] text-[var(--color-ink-faint)]">
          Establishing session…
        </span>
      </div>
    );
  }

  const visible = NAV.filter((item) => can(item.permission));
  const groups = (['TRACK', 'OPTIMISE', 'DATA'] as const)
    .map((context) => ({ context, items: visible.filter((item) => item.context === context) }))
    .filter((group) => group.items.length > 0);

  return (
    <div className="deck-surface flex min-h-screen">
      {/* ------------------------------------------------------------- rail */}
      <aside className="sticky top-0 flex h-screen w-[190px] shrink-0 flex-col border-r border-[var(--color-hairline)] bg-[var(--color-void)]">
        <div className="flex items-baseline gap-2 border-b border-[var(--color-hairline)] px-4 py-3.5">
          <span className="font-mono text-sm font-semibold tracking-[0.24em] text-[var(--color-signal)]">
            SCIP
          </span>
        </div>

        <nav className="flex-1 overflow-y-auto py-3">
          {groups.map((group) => (
            <div key={group.context} className="mb-4">
              <div className="px-4 pb-1.5 font-mono text-[0.5rem] uppercase tracking-[0.22em] text-[var(--color-ink-faint)]">
                {CONTEXT_LABEL[group.context]}
              </div>
              {group.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`relative flex items-center px-4 py-[0.4rem] text-[0.8125rem] transition-colors ${
                      active
                        ? 'bg-[color-mix(in_srgb,var(--color-signal)_9%,transparent)] text-[var(--color-signal)]'
                        : 'text-[var(--color-ink-dim)] hover:bg-[color-mix(in_srgb,var(--color-ink)_4%,transparent)] hover:text-[var(--color-ink)]'
                    }`}
                  >
                    {active && (
                      <span className="absolute inset-y-0 left-0 w-[2px] bg-[var(--color-signal)]" />
                    )}
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* AI reachability is on the rail, not buried: half the product depends on it. */}
        <div className="border-t border-[var(--color-hairline)] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className={`live-dot ${aiStatus?.reachable ? '' : 'live-dot-stale'}`} />
            <span className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
              {aiStatus?.reachable ? 'AI online' : 'AI offline'}
            </span>
          </div>
          {aiStatus && !aiStatus.reachable && (
            <p className="mt-1 text-[0.625rem] leading-snug text-[var(--color-ink-faint)]">
              Tracking and stock still work.
            </p>
          )}
        </div>

        <div className="border-t border-[var(--color-hairline)] px-4 py-3">
          <div className="truncate text-[0.75rem] text-[var(--color-ink)]">
            {user.firstName} {user.lastName}
          </div>
          <div className="font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
            {user.role.replace(/_/g, ' ')}
          </div>
          <button
            onClick={() => void signOut()}
            className="mt-2 font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)] hover:text-[var(--color-alert)]"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* ------------------------------------------------------------ stage */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex items-center justify-between gap-4 border-b border-[var(--color-hairline)] bg-[color-mix(in_srgb,var(--color-void)_88%,transparent)] px-5 py-2.5 backdrop-blur">
          <div className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
            {visible.find((item) => pathname.startsWith(item.href))?.label ?? 'SCIP'}
          </div>

          <Link
            href="/notifications"
            className="flex items-center gap-2 font-mono text-[0.625rem] uppercase tracking-[0.14em] text-[var(--color-ink-dim)] hover:text-[var(--color-signal)]"
          >
            Alerts
            {unread && unread.unread > 0 ? (
              <span className="chip chip-alert tnum">{unread.unread}</span>
            ) : (
              <span className="chip chip-neutral">0</span>
            )}
          </Link>
        </header>

        <main className="min-w-0 flex-1 p-5">{children}</main>
      </div>
    </div>
  );
}
