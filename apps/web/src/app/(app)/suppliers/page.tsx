'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ClipboardList, ClipboardPlus, Factory, RefreshCw, X } from 'lucide-react';
import { api, type Paginated } from '@/lib/api';
import {
  Button,
  Chip,
  DemoTag,
  Empty,
  ErrorNote,
  Facts,
  Kpi,
  Loading,
  Meter,
  PageHeader,
  Panel,
  SeverityIcon,
} from '@/components/ui';
import { SubTabs } from '@/components/shell/sub-tabs';
import { useToast } from '@/components/toast';
import { useAuth } from '@/lib/auth';
import { useFormat, useI18n } from '@/lib/i18n';
import { NewOrderPanel } from '../purchase-orders/_components/new-order-panel';
import { OPEN_STATUSES, isLate, poStatusKey } from '../purchase-orders/_components/po-status';

interface LeaderboardRow {
  rank: number;
  id: string;
  code: string;
  name: string;
  country: string;
  reliabilityScore: number;
  onTimeDeliveryRate: number;
  qualityAcceptanceRate: number;
  fillRate: number;
  observedLeadTimeDays: number;
  observedLeadTimeStdDays: number;
  ordersPlaced: number;
  scoreIsMeasured: boolean;
  performanceUpdatedAt: string | null;
}

interface SupplierOrderRow {
  id: string;
  orderNumber: string;
  status: string;
  currency: string;
  totalAmount: string;
  expectedDeliveryDate: string | null;
  actualDeliveryDate: string | null;
  isDemoData: boolean;
  sourceRecommendationId: string | null;
}

/**
 * Below this reliability a supplier is an exception worth a warning icon. The same cut the
 * league table has always used for its meter colour; only measured scores are judged against it,
 * because a prior is not evidence.
 */
const RELIABILITY_THRESHOLD = 80;

const TABS = [
  { href: '/suppliers', labelKey: 'nav.suppliers' as const, icon: Factory },
  { href: '/purchase-orders', labelKey: 'nav.orders' as const, icon: ClipboardList },
];

function underThreshold(row: LeaderboardRow): boolean {
  return row.scoreIsMeasured && row.reliabilityScore < RELIABILITY_THRESHOLD;
}

export default function SuppliersPage() {
  const client = useQueryClient();
  const { can } = useAuth();
  const { t } = useI18n();
  const f = useFormat();
  const toast = useToast();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composing, setComposing] = useState<{ supplierId?: string } | null>(null);

  const leaderboard = useQuery({
    queryKey: ['suppliers', 'leaderboard'],
    queryFn: () => api<LeaderboardRow[]>('/suppliers/leaderboard?limit=50'),
  });

  const recompute = useMutation({
    mutationFn: () => api('/suppliers/recompute-performance', { method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['suppliers'] });
      toast.show({ message: t('sup.v3.recomputed') });
    },
    onError: (error) => toast.show({ message: error instanceof Error ? error.message : String(error), tone: 'error' }),
  });

  const rows = useMemo(() => leaderboard.data ?? [], [leaderboard.data]);
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  const summary = useMemo(() => {
    const measured = rows.filter((row) => row.scoreIsMeasured);
    const under = rows.filter(underThreshold);
    const avgOnTime =
      measured.length > 0 ? measured.reduce((sum, row) => sum + row.onTimeDeliveryRate, 0) / measured.length : null;
    const lastComputed = measured
      .map((row) => row.performanceUpdatedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);
    return { measured: measured.length, under: under.length, avgOnTime, lastComputed };
  }, [rows]);

  const title = leaderboard.isLoading
    ? t('common.loading')
    : rows.length === 0
      ? t('sup.v3.titleNone')
      : summary.under === 0
        ? t('sup.v3.titleOk')
        : summary.under === 1
          ? t('sup.v3.titleUnderOne')
          : t('sup.v3.titleUnder', { n: summary.under });

  const canCreate = can('purchase_order:create');

  return (
    <div className="flex flex-col gap-6">
      <SubTabs tabs={TABS} />

      <PageHeader
        kicker={`${t('nav.pillar.network')} · ${t('nav.suppliers')}`}
        title={title}
        description={t('sup.intro')}
        actions={
          <>
            {can('supplier:update') && (
              <Button icon={RefreshCw} loading={recompute.isPending} onClick={() => recompute.mutate()}>
                {recompute.isPending ? t('sup.recomputing') : t('sup.recompute')}
              </Button>
            )}
            {canCreate && rows.length > 0 && (
              <Button
                variant="primary"
                icon={ClipboardPlus}
                onClick={() => {
                  setSelectedId(null);
                  setComposing({ supplierId: selected?.id });
                }}
              >
                {t('sup.v3.newOrder')}
              </Button>
            )}
          </>
        }
      />

      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={t('sup.v3.kpiRanked')} value={f.int(rows.length)} icon={Factory} />
        <Kpi
          label={t('sup.v3.kpiOnTime')}
          value={summary.avgOnTime === null ? '—' : f.pct(summary.avgOnTime, 1)}
          sub={t('sup.v3.kpiOnTimeSub', { n: summary.measured })}
          source={
            summary.lastComputed
              ? t('sup.v3.computed', { when: f.relative(summary.lastComputed) })
              : t('sup.v3.neverComputed')
          }
        />
        <Kpi
          label={t('sup.v3.kpiUnder', { n: RELIABILITY_THRESHOLD })}
          value={f.int(summary.under)}
          tone={summary.under > 0 ? 'warn' : 'neutral'}
        />
        <Kpi label={t('sup.v3.kpiPrior')} value={f.int(rows.length - summary.measured)} sub={t('sup.prior')} />
      </div>

      <div
        className={`grid items-start gap-6 ${
          selected || composing ? 'xl:grid-cols-[minmax(0,1fr)_400px]' : ''
        }`}
      >
        <Panel title={t('sup.league')} icon={Factory} loading={leaderboard.isFetching && !leaderboard.isLoading}>
          {leaderboard.isError ? (
            <ErrorNote error={leaderboard.error} onRetry={() => void leaderboard.refetch()} />
          ) : leaderboard.isLoading ? (
            <Loading rows={6} />
          ) : rows.length > 0 ? (
            <div className="overflow-x-auto pt-2">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th className="w-10">#</th>
                    <th>{t('sup.supplier')}</th>
                    <th>{t('sup.country')}</th>
                    <th className="min-w-36">{t('sup.reliability')}</th>
                    <th className="text-right">{t('sup.onTime')}</th>
                    <th className="text-right">{t('sup.quality')}</th>
                    <th className="text-right">{t('sup.fillRate')}</th>
                    <th className="text-right">{t('sup.leadTime')}</th>
                    <th className="text-right">{t('sup.orders')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((supplier) => {
                    const exception = underThreshold(supplier);
                    const isSelected = supplier.id === selectedId;
                    return (
                      <tr
                        key={supplier.id}
                        aria-selected={isSelected}
                        tabIndex={0}
                        className="cursor-pointer"
                        onClick={() => {
                          setComposing(null);
                          setSelectedId(isSelected ? null : supplier.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setComposing(null);
                            setSelectedId(isSelected ? null : supplier.id);
                          }
                        }}
                      >
                        <td className="t-data text-[12px] text-[var(--color-dim)]">{supplier.rank}</td>
                        <td>
                          <span className="block text-[13.5px]">{supplier.name}</span>
                          <span className="t-data text-[11px] text-[var(--color-dim)]">{supplier.code}</span>
                        </td>
                        <td className="t-data text-[12px] text-[var(--color-muted)]">{supplier.country}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            {exception ? (
                              <SeverityIcon severity="warning" size={14} />
                            ) : (
                              <span className="w-[14px] shrink-0" aria-hidden />
                            )}
                            <div className="flex-1">
                              {/* Neutral by default; only a measured score under the threshold earns colour. */}
                              <Meter value={supplier.reliabilityScore / 100} tone={exception ? 'warn' : 'signal'} />
                            </div>
                            <span className="t-data text-[12.5px]">{f.num(supplier.reliabilityScore, 1)}</span>
                          </div>
                        </td>
                        <td className="t-data text-right text-[12.5px]">{f.pct(supplier.onTimeDeliveryRate, 1)}</td>
                        <td className="t-data text-right text-[12.5px]">{f.pct(supplier.qualityAcceptanceRate, 1)}</td>
                        <td className="t-data text-right text-[12.5px]">{f.pct(supplier.fillRate, 1)}</td>
                        <td className="t-data whitespace-nowrap text-right text-[12.5px]">
                          {f.num(supplier.observedLeadTimeDays, 1)}
                          <span className="text-[var(--color-dim)]">
                            {' '}
                            ± {f.num(supplier.observedLeadTimeStdDays, 1)} {t('sup.v3.dayUnit')}
                          </span>
                        </td>
                        <td className="t-data text-right text-[12.5px] text-[var(--color-muted)]">
                          {f.int(supplier.ordersPlaced)}
                        </td>
                        <td className="text-right">
                          {supplier.scoreIsMeasured ? (
                            <Chip tone="neutral">{t('sup.measured')}</Chip>
                          ) : (
                            <Chip tone="neutral" title={t('sup.priorNote')}>
                              {t('sup.prior')}
                            </Chip>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="m-0 px-5 py-3 text-[12px] leading-relaxed text-[var(--color-dim)]">{t('sup.priorNote')}</p>
            </div>
          ) : (
            <Empty title={t('sup.none')} hint={t('sup.v3.noneHint')} icon={Factory} />
          )}
        </Panel>

        {composing ? (
          <NewOrderPanel
            key={composing.supplierId ?? 'new'}
            suppliers={rows}
            initialSupplierId={composing.supplierId}
            onClose={() => setComposing(null)}
          />
        ) : selected ? (
          <SupplierDetail
            key={selected.id}
            supplier={selected}
            canCreate={canCreate}
            canRecompute={can('supplier:update')}
            onClose={() => setSelectedId(null)}
            onNewOrder={() => setComposing({ supplierId: selected.id })}
          />
        ) : null}
      </div>
    </div>
  );
}

function SupplierDetail({
  supplier,
  canCreate,
  canRecompute,
  onClose,
  onNewOrder,
}: {
  supplier: LeaderboardRow;
  canCreate: boolean;
  canRecompute: boolean;
  onClose: () => void;
  onNewOrder: () => void;
}) {
  const { t } = useI18n();
  const f = useFormat();
  const client = useQueryClient();
  const toast = useToast();
  const exception = underThreshold(supplier);

  const orders = useQuery({
    queryKey: ['purchase-orders', { supplierId: supplier.id }],
    queryFn: () =>
      api<Paginated<SupplierOrderRow>>(`/purchase-orders?supplierId=${supplier.id}&limit=50`),
  });

  const recomputeOne = useMutation({
    mutationFn: () => api(`/suppliers/${supplier.id}/recompute-performance`, { method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['suppliers'] });
      toast.show({ message: t('sup.v3.recomputedOne', { name: supplier.name }) });
    },
    onError: (error) => toast.show({ message: error instanceof Error ? error.message : String(error), tone: 'error' }),
  });

  const open = (orders.data?.data ?? []).filter((order) => OPEN_STATUSES.includes(order.status));
  const late = open.filter(isLate).length;

  return (
    <aside className="panel slide-in-right flex flex-col gap-5 p-5" aria-label={supplier.name}>
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="t-label">
            {t('sup.v3.rank')} {supplier.rank} · {supplier.country}
          </span>
          <h2 className="t-h3 m-0 flex items-center gap-2">
            {exception && <SeverityIcon severity="warning" />}
            <span className="truncate">{supplier.name}</span>
          </h2>
          <span className="t-data text-[12px] text-[var(--color-muted)]">{supplier.code}</span>
        </div>
        <Button variant="ghost" size="sm" icon={X} onClick={onClose} aria-label={t('common.close')} />
      </header>

      <div className="tile flex flex-col gap-2 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] text-[var(--color-muted)]">{t('sup.reliability')}</span>
          <span className="t-kpi text-[28px]">{f.num(supplier.reliabilityScore, 1)}</span>
        </div>
        <Meter value={supplier.reliabilityScore / 100} tone={exception ? 'warn' : 'signal'} />
        <span className="text-[12px] text-[var(--color-muted)]">
          {exception
            ? t('sup.v3.underNote', { n: RELIABILITY_THRESHOLD })
            : supplier.scoreIsMeasured
              ? t('sup.v3.aboveNote', { n: RELIABILITY_THRESHOLD })
              : t('sup.priorNote')}
        </span>
      </div>

      <Facts
        items={[
          [t('sup.onTime'), <span className="t-data">{f.pct(supplier.onTimeDeliveryRate, 1)}</span>],
          [t('sup.quality'), <span className="t-data">{f.pct(supplier.qualityAcceptanceRate, 1)}</span>],
          [t('sup.fillRate'), <span className="t-data">{f.pct(supplier.fillRate, 1)}</span>],
          [
            t('sup.leadTime'),
            <span className="t-data">
              {f.num(supplier.observedLeadTimeDays, 1)} ± {f.num(supplier.observedLeadTimeStdDays, 1)}{' '}
              {t('sup.v3.dayUnit')}
            </span>,
          ],
          [t('sup.orders'), <span className="t-data">{f.int(supplier.ordersPlaced)}</span>],
          [
            t('sup.v3.lastComputed'),
            <span className="t-data">
              {supplier.performanceUpdatedAt ? f.relative(supplier.performanceUpdatedAt) : t('sup.v3.never')}
            </span>,
          ],
        ]}
      />

      <div className="flex flex-wrap gap-2">
        {canCreate && (
          <Button variant="primary" size="sm" icon={ClipboardPlus} onClick={onNewOrder}>
            {t('sup.v3.newOrder')}
          </Button>
        )}
        {canRecompute && (
          <Button size="sm" icon={RefreshCw} loading={recomputeOne.isPending} onClick={() => recomputeOne.mutate()}>
            {t('sup.v3.recomputeOne')}
          </Button>
        )}
      </div>

      <section className="flex flex-col gap-2">
        <header className="flex items-center justify-between gap-2">
          <h3 className="t-h4 m-0 flex items-center gap-2">
            {t('sup.v3.openOrders')}
            {orders.data && <span className="pill-count">{open.length}</span>}
          </h3>
          {late > 0 && (
            <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-muted)]">
              <SeverityIcon severity="warning" size={14} />
              {t('sup.v3.lateCount', { n: late })}
            </span>
          )}
        </header>
        {orders.isError ? (
          <ErrorNote error={orders.error} onRetry={() => void orders.refetch()} />
        ) : orders.isLoading ? (
          <Loading rows={3} />
        ) : open.length === 0 ? (
          <p className="m-0 text-[13px] text-[var(--color-muted)]">{t('sup.v3.noOpenOrders')}</p>
        ) : (
          <ul className="stagger m-0 flex list-none flex-col p-0">
            {open.map((order) => {
              const lateOrder = isLate(order);
              return (
                <li
                  key={order.id}
                  className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 border-t border-[var(--color-line)] py-2 first:border-t-0"
                >
                  {lateOrder ? <SeverityIcon severity="warning" size={14} /> : <span aria-hidden />}
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-2">
                      <span className="t-data text-[12.5px]">{order.orderNumber}</span>
                      {order.isDemoData && <DemoTag />}
                    </span>
                    <span className="text-[12px] text-[var(--color-muted)]">
                      {t(poStatusKey(order.status))} · {t('po.expected')} {f.date(order.expectedDeliveryDate)}
                    </span>
                  </span>
                  <span className="t-data text-[12px] text-[var(--color-muted)]">
                    {f.money(order.totalAmount, order.currency)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <Link
          href="/purchase-orders"
          className="self-start text-[12.5px] text-[var(--color-muted)] underline underline-offset-2 hover:text-[var(--color-ink)]"
        >
          {t('sup.v3.allOrders')}
        </Link>
      </section>
    </aside>
  );
}
