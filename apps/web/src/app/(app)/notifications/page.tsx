'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api, type Paginated } from '@/lib/api';
import { Chip, Empty, ErrorNote, Loading, Panel, fmt } from '@/components/ui';

interface NotificationRow {
  id: string;
  type: string;
  channel: string;
  severity: string;
  title: string;
  body: string;
  target: Record<string, string>;
  readAt: string | null;
  deliveryError: string | null;
  createdAt: string;
}

const TARGET_PATH: Record<string, (id: string) => string> = {
  shipment: (id) => `/shipments/${id}`,
  product: () => '/inventory',
  purchase_order: () => '/purchase-orders',
  incident: () => '/incidents',
  recommendations: () => '/recommendations',
};

export default function NotificationsPage() {
  const client = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);

  const list = useQuery({
    queryKey: ['notifications', { unreadOnly }],
    queryFn: () =>
      api<Paginated<NotificationRow> & { unreadCount: number }>(
        `/notifications?limit=50${unreadOnly ? '&unreadOnly=true' : ''}`,
      ),
    refetchInterval: 30_000,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const markAll = useMutation({
    mutationFn: () => api('/notifications/read-all', { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['notifications'] }),
  });

  return (
    <div className="space-y-4">
      <Panel
        title="Alerts"
        meta={
          list.data && list.data.unreadCount > 0 ? (
            <Chip tone="alert">{list.data.unreadCount} unread</Chip>
          ) : null
        }
        loading={list.isFetching}
        actions={
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={unreadOnly}
                onChange={(event) => setUnreadOnly(event.target.checked)}
                className="accent-[var(--color-signal)]"
              />
              unread only
            </label>
            <button
              onClick={() => markAll.mutate()}
              disabled={markAll.isPending}
              className="hover:text-[var(--color-signal)]"
            >
              mark all read
            </button>
          </div>
        }
      >
        {list.isError ? (
          <ErrorNote error={list.error} />
        ) : list.isLoading ? (
          <Loading />
        ) : list.data && list.data.data.length > 0 ? (
          <ul className="divide-y divide-[var(--color-hairline)]">
            {list.data.data.map((notification) => {
              const entity = notification.target?.entity;
              const id = notification.target?.id;
              const href =
                entity && TARGET_PATH[entity] ? TARGET_PATH[entity](id ?? '') : undefined;

              return (
                <li
                  key={notification.id}
                  className={`p-3.5 ${notification.readAt ? 'opacity-55' : ''}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {!notification.readAt && (
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-signal)]" />
                        )}
                        <Chip
                          tone={
                            notification.severity === 'CRITICAL'
                              ? 'alert'
                              : notification.severity === 'WARNING'
                                ? 'warn'
                                : 'neutral'
                          }
                        >
                          {notification.type.replace(/_/g, ' ')}
                        </Chip>
                        <span className="font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
                          {fmt.relative(notification.createdAt)}
                        </span>
                      </div>

                      <h3 className="mt-1.5 text-[0.875rem] font-medium">{notification.title}</h3>
                      <p className="mt-0.5 max-w-3xl text-[0.75rem] leading-relaxed text-[var(--color-ink-dim)]">
                        {notification.body}
                      </p>

                      {notification.deliveryError && (
                        <p className="mt-1 font-mono text-[0.625rem] text-[var(--color-warn)]">
                          email delivery failed: {notification.deliveryError}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      {href && (
                        <Link
                          href={href}
                          className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-[var(--color-signal)] hover:underline"
                        >
                          open →
                        </Link>
                      )}
                      {!notification.readAt && (
                        <button
                          onClick={() => markRead.mutate(notification.id)}
                          className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
                        >
                          mark read
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty
            title={unreadOnly ? 'Nothing unread' : 'No alerts'}
            hint="Alerts are routed by role — you see what your role is responsible for."
          />
        )}
      </Panel>
    </div>
  );
}
