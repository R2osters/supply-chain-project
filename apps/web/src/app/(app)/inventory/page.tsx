'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  Bell,
  Boxes,
  Coins,
  PackageX,
  RefreshCw,
  Search,
  Sparkles,
  TriangleAlert,
  Warehouse,
  Layers,
} from 'lucide-react';
import { api, type InventoryRow, type Paginated } from '@/lib/api';
import {
  AlertRow,
  Button,
  Empty,
  ErrorNote,
  Kpi,
  Loading,
  Meter,
  PageHeader,
  Panel,
  SeverityIcon,
  toSeverity,
} from '@/components/ui';
import { useToast } from '@/components/toast';
import { useAuth } from '@/lib/auth';
import { useFormat, useI18n } from '@/lib/i18n';
import { Projection } from './_components/projection';

interface Valuation {
  inventoryValue: number;
  totalUnits: number;
  distinctSkus: number;
  outOfStockRows: number;
  belowReorderPointRows: number;
  overstockRows: number;
}

interface StockAlert {
  id: string;
  type: string;
  severity: string;
  message: string;
  currentValue: string;
  threshold: string;
  createdAt: string;
  product: { id: string; sku: string; name: string };
}

type RowState = 'out' | 'below' | 'incoming' | 'ok';

/** One word per row, the three states the charte asks this screen to draw (plus out-of-stock). */
function rowState(row: InventoryRow): RowState {
  if (row.freeStock <= 0) return 'out';
  if (row.belowReorderPoint) return row.incomingStock > 0 ? 'incoming' : 'below';
  return 'ok';
}

export default function InventoryPage() {
  // `useSearchParams` needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<Loading rows={8} />}>
      <InventoryScreen />
    </Suspense>
  );
}

function InventoryScreen() {
  const client = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useAuth();
  const { t } = useI18n();
  const f = useFormat();
  const toast = useToast();

  // The command palette deep-links here with ?q=, which seeds the search.
  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const [belowReorder, setBelowReorder] = useState(false);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const q = params.get('q');
    if (q !== null) {
      setSearch(q);
      setPage(1);
    }
  }, [params]);

  const valuation = useQuery({
    queryKey: ['inventory', 'valuation'],
    queryFn: () => api<Valuation>('/inventory/valuation'),
  });

  const rows = useQuery({
    queryKey: ['inventory', { search, belowReorder, page }],
    queryFn: () => {
      const query = new URLSearchParams({ page: String(page), limit: '40' });
      if (search) query.set('search', search);
      if (belowReorder) query.set('belowReorderPoint', 'true');
      return api<Paginated<InventoryRow>>(`/inventory?${query}`);
    },
    placeholderData: keepPreviousData,
  });

  const alerts = useQuery({
    queryKey: ['inventory', 'alerts'],
    queryFn: () => api<Paginated<StockAlert>>('/inventory/alerts?limit=15'),
  });

  const sweep = useMutation({
    mutationFn: () => api('/inventory/alerts/sweep', { method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['inventory'] });
      toast.show({ message: t('inv.v3.swept') });
    },
    onError: (error) => toast.show({ message: error instanceof Error ? error.message : String(error), tone: 'error' }),
  });

  // The generate endpoint is company-wide; it supersedes rather than duplicates open advice, so
  // asking again is harmless. The operator still accepts each recommendation on its own screen.
  const generate = useMutation({
    mutationFn: () => api('/ai/recommendations/generate', { method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['recommendations'] });
      toast.show({
        message: t('inv.v3.askedReco'),
        action: { label: t('inv.v3.viewReco'), onClick: () => router.push('/recommendations') },
      });
    },
    onError: (error) => toast.show({ message: error instanceof Error ? error.message : String(error), tone: 'error' }),
  });

  const list = useMemo(() => rows.data?.data ?? [], [rows.data]);

  // Keep a row projected: the operator's pick, else the first one that needs attention.
  useEffect(() => {
    if (list.length === 0) return;
    if (selectedId && list.some((row) => row.id === selectedId)) return;
    const firstException = list.find((row) => rowState(row) !== 'ok') ?? list[0];
    setSelectedId(firstException.id);
  }, [list, selectedId]);

  const selected = list.find((row) => row.id === selectedId) ?? null;

  const v = valuation.data;
  const title = !v
    ? t('common.loading')
    : v.belowReorderPointRows === 0 && v.outOfStockRows === 0
      ? t('inv.v3.titleOk')
      : t('inv.v3.titleShort', { below: f.int(v.belowReorderPointRows), out: f.int(v.outOfStockRows) });

  const askAction = can('recommendation:create') ? (
    <Button variant="primary" icon={Sparkles} loading={generate.isPending} onClick={() => generate.mutate()}>
      {t('inv.v3.askReco')}
    </Button>
  ) : (
    <Link href="/recommendations" className="btn btn-primary">
      <Sparkles />
      {t('inv.v3.askReco')}
    </Link>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={`${t('nav.pillar.network')} · ${t('nav.inventory')}`}
        title={title}
        description={t('inv.v3.intro')}
        actions={askAction}
      />

      {valuation.isError ? (
        <div className="panel">
          <ErrorNote error={valuation.error} onRetry={() => void valuation.refetch()} />
        </div>
      ) : (
        <div className="stagger grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Kpi label={t('inv.value')} value={f.int(v?.inventoryValue)} unit="GHS" icon={Coins} />
          <Kpi label={t('inv.units')} value={f.int(v?.totalUnits)} icon={Boxes} />
          <Kpi label={t('inv.skus')} value={f.int(v?.distinctSkus)} icon={Layers} />
          <Kpi
            label={t('inv.outOfStock')}
            value={f.int(v?.outOfStockRows)}
            icon={PackageX}
            tone={v?.outOfStockRows ? 'alert' : 'neutral'}
          />
          <Kpi
            label={t('inv.belowReorder')}
            value={f.int(v?.belowReorderPointRows)}
            icon={TriangleAlert}
            tone={v?.belowReorderPointRows ? 'warn' : 'neutral'}
          />
          <Kpi
            label={t('inv.overstocked')}
            value={f.int(v?.overstockRows)}
            icon={Warehouse}
            tone={v?.overstockRows ? 'warn' : 'neutral'}
          />
        </div>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(360px,1fr)]">
        <Panel
          title={t('inv.byProduct')}
          icon={Warehouse}
          meta={rows.data ? <span className="pill-count">{f.int(rows.data.meta.total)}</span> : null}
          loading={rows.isFetching && !rows.isLoading}
        >
          <div className="flex flex-wrap items-center gap-2 px-5 pb-1 pt-3">
            <label className="relative min-w-[200px] flex-1 sm:max-w-[300px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-dim)]" />
              <input
                className="field !pl-9"
                type="search"
                placeholder={t('inv.searchPlaceholder')}
                aria-label={t('tbl.search')}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
              />
            </label>
            <button
              type="button"
              className="pill"
              aria-pressed={belowReorder}
              onClick={() => {
                setBelowReorder((value) => !value);
                setPage(1);
              }}
            >
              <TriangleAlert />
              {t('inv.onlyBelowReorder')}
              {v && <span className="pill-count">{f.int(v.belowReorderPointRows)}</span>}
            </button>
          </div>

          {rows.isError ? (
            <ErrorNote error={rows.error} onRetry={() => void rows.refetch()} />
          ) : rows.isLoading ? (
            <Loading rows={8} />
          ) : list.length > 0 ? (
            <div className="overflow-x-auto pt-2">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>{t('inv.product')}</th>
                    <th>{t('inv.warehouse')}</th>
                    <th className="text-right">{t('inv.free')}</th>
                    <th className="text-right">{t('inv.reserved')}</th>
                    <th className="text-right">{t('inv.incoming')}</th>
                    <th className="text-right">{t('inv.reorderPtShort')}</th>
                    <th className="min-w-28">{t('inv.cover')}</th>
                    <th className="text-right">{t('inv.valueCol')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((row) => {
                    const reorderPoint = Number(row.reorderPoint);
                    // Cover drawn against twice the reorder point, so "full" means comfortably above it.
                    const ratio = reorderPoint > 0 ? row.availableStock / (reorderPoint * 2) : 1;
                    const state = rowState(row);
                    const isSelected = row.id === selectedId;
                    return (
                      <tr
                        key={row.id}
                        aria-selected={isSelected}
                        tabIndex={0}
                        className="cursor-pointer"
                        onClick={() => setSelectedId(row.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setSelectedId(row.id);
                          }
                        }}
                      >
                        <td className="t-data text-[12.5px]">{row.product.sku}</td>
                        <td className="max-w-[240px] truncate text-[13px] text-[var(--color-muted)]">
                          {row.product.name}
                        </td>
                        <td className="t-data text-[12px] text-[var(--color-muted)]">{row.warehouse.code}</td>
                        <td className="t-data text-right text-[12.5px]">
                          <span className="inline-flex items-center gap-1.5">
                            {state === 'out' && <SeverityIcon severity="critical" size={14} />}
                            {state === 'below' && <SeverityIcon severity="warning" size={14} />}
                            {f.int(row.freeStock)}
                          </span>
                        </td>
                        <td className="t-data text-right text-[12.5px] text-[var(--color-dim)]">
                          {f.int(row.reservedStock)}
                        </td>
                        <td className="t-data text-right text-[12.5px]">
                          {row.incomingStock > 0 ? (
                            <span
                              className="inline-flex items-center gap-1.5"
                              title={state === 'incoming' ? t('inv.v3.state.incoming') : undefined}
                            >
                              <ArrowDownToLine className="h-3.5 w-3.5 text-[var(--color-info)]" />
                              {f.int(row.incomingStock)}
                            </span>
                          ) : (
                            <span className="text-[var(--color-dim)]">—</span>
                          )}
                        </td>
                        <td className="t-data text-right text-[12.5px] text-[var(--color-dim)]">
                          {f.int(reorderPoint)}
                        </td>
                        <td title={t(`inv.v3.state.${state}`)}>
                          <Meter
                            value={Math.min(1, ratio)}
                            tone={state === 'out' ? 'alert' : state === 'below' ? 'warn' : 'signal'}
                          />
                        </td>
                        <td className="t-data text-right text-[12.5px] text-[var(--color-muted)]">
                          {f.int(row.value)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : search || belowReorder ? (
            <Empty
              title={t('inv.noRows')}
              hint={t('inv.noneHint')}
              icon={Search}
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    setSearch('');
                    setBelowReorder(false);
                    setPage(1);
                  }}
                >
                  {t('inv.v3.clearFilters')}
                </Button>
              }
            />
          ) : (
            <Empty title={t('inv.none')} hint={t('inv.noneHint')} icon={Warehouse} />
          )}

          {rows.data && rows.data.meta.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-[var(--color-line)] px-5 py-3">
              <span className="t-label">
                {t('tbl.page', { page: rows.data.meta.page, total: rows.data.meta.totalPages })}
              </span>
              <div className="flex gap-2">
                <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  {t('tbl.prev')}
                </Button>
                <Button size="sm" disabled={!rows.data.meta.hasNextPage} onClick={() => setPage((p) => p + 1)}>
                  {t('tbl.next')}
                </Button>
              </div>
            </div>
          )}
        </Panel>

        <div className="flex flex-col gap-6">
          <Projection row={selected} />

          <Panel
            title={t('inv.openAlerts')}
            icon={Bell}
            meta={alerts.data ? <span className="pill-count">{f.int(alerts.data.meta.total)}</span> : null}
            actions={
              can('inventory:update') ? (
                <Button size="sm" variant="ghost" icon={RefreshCw} loading={sweep.isPending} onClick={() => sweep.mutate()}>
                  {sweep.isPending ? t('inv.sweeping') : t('inv.reevaluate')}
                </Button>
              ) : null
            }
          >
            {alerts.isError ? (
              <ErrorNote error={alerts.error} onRetry={() => void alerts.refetch()} />
            ) : alerts.isLoading ? (
              <Loading rows={4} />
            ) : alerts.data && alerts.data.data.length > 0 ? (
              <div className="stagger flex flex-col py-2" aria-live="polite">
                {alerts.data.data.map((alert) => (
                  <AlertRow
                    key={alert.id}
                    severity={toSeverity(alert.severity)}
                    title={
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="t-data text-[12.5px]">{alert.product.sku}</span>
                        <span className="font-normal text-[var(--color-muted)]">
                          {alert.type.replace(/_/g, ' ').toLowerCase()}
                        </span>
                      </span>
                    }
                    context={alert.message}
                    age={f.relative(alert.createdAt)}
                    onClick={() => {
                      setSearch(alert.product.sku);
                      setBelowReorder(false);
                      setPage(1);
                    }}
                  />
                ))}
              </div>
            ) : (
              <Empty title={t('inv.noAlerts')} hint={t('inv.noAlertsHint')} />
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
