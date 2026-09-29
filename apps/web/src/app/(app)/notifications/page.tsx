'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, CheckCheck, FilterX, MailWarning } from 'lucide-react';
import { api, type Paginated } from '@/lib/api';
import {
  AlertRow,
  Button,
  DemoTag,
  Empty,
  ErrorNote,
  Loading,
  PageHeader,
  Panel,
  Provenance,
  toSeverity,
} from '@/components/ui';
import { useToast } from '@/components/toast';
import { useFormat, useI18n } from '@/lib/i18n';
import { FilterPill, useListKeys } from '../shipments/_components/track-kit';
import { shipmentHref } from '@/lib/routes';

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
  /** Every scalar is returned; optional for older API builds. */
  isDemoData?: boolean;
}

const TARGET_PATH: Record<string, (id: string) => string> = {
  shipment: (id) => shipmentHref(id),
  product: () => '/inventory',
  purchase_order: () => '/purchase-orders',
  incident: () => '/incidents',
  recommendations: () => '/recommendations',
};

type Filter = 'all' | 'unread' | 'critical';

function hrefOf(notification: NotificationRow): string | undefined {
  const entity = notification.target?.entity;
  const id = notification.target?.id;
  return entity && TARGET_PATH[entity] ? TARGET_PATH[entity](id ?? '') : undefined;
}

export default function NotificationsPage() {
  const client = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const { t } = useI18n();
  const f = useFormat();
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const unreadOnly = filter === 'unread';

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
    onSuccess: () => {
      toast.show({ message: t('notif.v3.markedRead'), tone: 'success', durationMs: 3000 });
      client.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (error) => toast.show({ message: (error as Error).message ?? String(error), tone: 'error' }),
  });

  const markAll = useMutation({
    mutationFn: () => api('/notifications/read-all', { method: 'POST' }),
    onSuccess: () => {
      toast.show({ message: t('notif.v3.allMarkedRead'), tone: 'success' });
      client.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (error) => toast.show({ message: (error as Error).message ?? String(error), tone: 'error' }),
  });

  const loaded = list.data?.data ?? [];
  const isCritical = (row: NotificationRow) => toSeverity(row.severity) === 'critical';
  const rows = filter === 'critical' ? loaded.filter(isCritical) : loaded;
  const unread = list.data?.unreadCount ?? 0;
  const criticalUnread = loaded.filter((row) => isCritical(row) && !row.readAt).length;

  const ids = useMemo(() => rows.map((row) => row.id), [rows]);
  const select = useCallback((id: string | null) => setSelectedId(id), []);
  const openSelected = useCallback(
    (id: string) => {
      const row = rows.find((candidate) => candidate.id === id);
      const href = row && hrefOf(row);
      if (href) router.push(href);
    },
    [rows, router],
  );
  useListKeys(ids, selectedId, select, openSelected);

  // A new unread critical alert is announced assertively (charte §10); everything else politely.
  const [announcement, setAnnouncement] = useState('');
  const previousCritical = useRef<number | null>(null);
  useEffect(() => {
    if (!list.data) return;
    if (previousCritical.current !== null && criticalUnread > previousCritical.current) {
      setAnnouncement(t('notif.v3.newCritical', { n: criticalUnread }));
    }
    previousCritical.current = criticalUnread;
  }, [criticalUnread, list.data, t]);

  const title = !list.data
    ? t('notif.title')
    : unread === 0
      ? t('notif.v3.titleNone')
      : criticalUnread > 0
        ? t('notif.v3.titleCritical', { n: f.int(unread), c: f.int(criticalUnread) })
        : t(unread === 1 ? 'notif.v3.titleOne' : 'notif.v3.titleMany', { n: f.int(unread) });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={t('notif.v3.kicker')}
        title={title}
        description={t('notif.noneHint')}
        meta={<Provenance kind="poll" seconds={30} />}
        actions={
          <Button
            icon={CheckCheck}
            onClick={() => markAll.mutate()}
            loading={markAll.isPending}
            disabled={unread === 0}
          >
            {t('notif.v3.markAllRead')}
          </Button>
        }
      />

      <div className="sr-only" aria-live="polite">
        {list.data ? title : ''}
      </div>
      <div className="sr-only" aria-live="assertive">
        {announcement}
      </div>

      <div className="rise flex flex-wrap items-center gap-2">
        <FilterPill active={filter === 'all'} count={list.data && !unreadOnly ? list.data.meta.total : null} onClick={() => setFilter('all')}>
          {t('notif.v3.pillAll')}
        </FilterPill>
        <FilterPill active={filter === 'unread'} count={list.data ? unread : null} onClick={() => setFilter(filter === 'unread' ? 'all' : 'unread')}>
          {t('notif.v3.pillUnread')}
        </FilterPill>
        <FilterPill
          active={filter === 'critical'}
          count={list.data ? loaded.filter(isCritical).length : null}
          onClick={() => setFilter(filter === 'critical' ? 'all' : 'critical')}
        >
          {t('notif.v3.pillCritical')}
        </FilterPill>
        <span className="ml-auto hidden items-center gap-1.5 text-[12px] text-[var(--color-dim)] md:flex">
          <kbd className="kbd">J</kbd>
          <kbd className="kbd">K</kbd>
          {t('notif.v3.keysHint')}
        </span>
      </div>

      <Panel
        icon={Bell}
        title={t('notif.title')}
        meta={unread > 0 ? <span key={unread} className="pill-count pop">{t('notif.unread', { n: unread })}</span> : null}
        loading={list.isFetching}
      >
        {list.isError ? (
          <ErrorNote error={list.error} onRetry={() => list.refetch()} />
        ) : list.isLoading ? (
          <Loading rows={6} />
        ) : rows.length > 0 ? (
          <ul className="stagger m-0 flex list-none flex-col gap-1 p-2" aria-label={t('notif.title')}>
            {rows.map((notification) => {
              const href = hrefOf(notification);
              const isUnread = !notification.readAt;
              return (
                <li
                  key={notification.id}
                  data-row-id={notification.id}
                  aria-current={notification.id === selectedId || undefined}
                  onClick={() => setSelectedId(notification.id)}
                  className={`cursor-pointer rounded-[var(--radius-md)] ${isUnread ? '' : 'opacity-60'}`}
                >
                  <AlertRow
                    severity={toSeverity(notification.severity)}
                    selected={notification.id === selectedId}
                    title={
                      <span className="flex items-center gap-2">
                        {isUnread && (
                          <span
                            className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-info)]"
                            aria-label={t('notif.v3.unreadDot')}
                          />
                        )}
                        <span className={isUnread ? '' : 'font-normal'}>{notification.title}</span>
                      </span>
                    }
                    context={
                      <>
                        {notification.body}
                        {notification.deliveryError && (
                          <span className="mt-1 flex items-center gap-1.5 text-[12px] text-[var(--color-muted)]">
                            <MailWarning className="h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
                            {t('notif.emailFailed', { reason: notification.deliveryError })}
                          </span>
                        )}
                      </>
                    }
                    source={`${notification.type.replace(/_/g, ' ').toLowerCase()} · ${notification.channel.toLowerCase()}`}
                    provenance={notification.isDemoData ? <DemoTag /> : undefined}
                    age={f.relative(notification.createdAt)}
                    actions={
                      href || isUnread ? (
                        <>
                          {href && (
                            <Link
                              href={href}
                              onClick={(event) => event.stopPropagation()}
                              className="btn btn-sm"
                            >
                              {t('notif.open')}
                            </Link>
                          )}
                          {isUnread && (
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={markRead.isPending && markRead.variables === notification.id}
                              onClick={(event) => {
                                event.stopPropagation();
                                markRead.mutate(notification.id);
                              }}
                            >
                              {t('notif.markRead')}
                            </Button>
                          )}
                        </>
                      ) : undefined
                    }
                  />
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty
            icon={filter === 'all' ? undefined : FilterX}
            title={filter === 'unread' ? t('notif.noneUnread') : filter === 'critical' ? t('notif.v3.noneCritical') : t('notif.none')}
            hint={t('notif.noneHint')}
            action={
              filter !== 'all' ? (
                <Button size="sm" icon={FilterX} onClick={() => setFilter('all')}>
                  {t('notif.v3.showAll')}
                </Button>
              ) : undefined
            }
          />
        )}
      </Panel>
    </div>
  );
}
