'use client';

import { Bell } from 'lucide-react';
import Link from 'next/link';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Paginated } from '@/lib/api';
import { AlertRow, DemoTag, Empty, ErrorNote, Loading, Panel, toSeverity } from '@/components/ui';
import { useFormat, useI18n } from '@/lib/i18n';

export interface NotificationRow {
  id: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  target: Record<string, string> | null;
  readAt: string | null;
  isDemoData?: boolean;
  createdAt: string;
}

export type NotificationPage = Paginated<NotificationRow> & { unreadCount: number };

/** Same deep links as the notifications screen, so an alert opens where it is handled. */
const TARGET_PATH: Record<string, (id: string) => string> = {
  shipment: (id) => `/shipments/${id}`,
  product: () => '/inventory',
  purchase_order: () => '/purchase-orders',
  incident: () => '/incidents',
  recommendations: () => '/recommendations',
};

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, WARNING: 1 };

/**
 * The alert queue is the operator's unread notifications — the API's single stream of things
 * that went wrong (delays, anomalies, stock breaches, incidents). Critical first, then newest.
 */
export function AlertQueue({ query }: { query: UseQueryResult<NotificationPage> }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const rows = [...(query.data?.data ?? [])].sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 2) - (SEVERITY_RANK[b.severity] ?? 2) ||
      b.createdAt.localeCompare(a.createdAt),
  );
  const critical = rows.some((row) => row.severity === 'CRITICAL');
  const unread = query.data?.unreadCount ?? 0;

  return (
    <Panel
      icon={Bell}
      title={t('dash.v3.alerts')}
      meta={unread > 0 ? <span key={unread} className="pill-count pop">{fmt.int(unread)}</span> : null}
      loading={query.isFetching && !query.data}
      actions={
        <Link href="/notifications" className="hover:text-[var(--color-ink)] hover:underline">
          {t('dash.v3.allAlerts')}
        </Link>
      }
      className="flex min-h-0 flex-col"
    >
      {query.isError ? (
        <ErrorNote error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <Loading rows={5} />
      ) : rows.length === 0 ? (
        <Empty title={t('dash.v3.alertsEmpty')} hint={t('dash.v3.alertsEmptyHint')} />
      ) : (
        // Critical alerts are announced at once; everything else waits for a pause.
        <ul
          aria-live={critical ? 'assertive' : 'polite'}
          className="stagger m-0 flex max-h-[520px] list-none flex-col gap-0.5 overflow-y-auto p-2"
        >
          {rows.map((row) => {
            const entity = row.target?.entity;
            const href = entity && TARGET_PATH[entity] ? TARGET_PATH[entity](row.target?.id ?? '') : undefined;
            return (
              <li key={row.id}>
                <AlertRow
                  severity={toSeverity(row.severity)}
                  title={row.title}
                  context={row.body}
                  source={row.type.replace(/_/g, ' ').toLowerCase()}
                  provenance={row.isDemoData ? <DemoTag /> : undefined}
                  age={fmt.relative(row.createdAt)}
                  href={href}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
