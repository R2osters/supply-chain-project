'use client';

import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ClipboardList, ClipboardPlus, Factory, Hand, Sparkles, X } from 'lucide-react';
import { api, type Paginated } from '@/lib/api';
import {
  Button,
  DemoTag,
  Empty,
  ErrorNote,
  Facts,
  Kpi,
  Loading,
  Meter,
  MetricRow,
  PageHeader,
  Panel,
  SeverityIcon,
} from '@/components/ui';
import { SubTabs } from '@/components/shell/sub-tabs';
import { useToast } from '@/components/toast';
import { useAuth } from '@/lib/auth';
import { useFormat, useI18n } from '@/lib/i18n';
import { NewOrderPanel } from './_components/new-order-panel';
import { OPEN_STATUSES, PO_NEXT, PO_STATUSES, isLate, poStatusKey } from './_components/po-status';

interface PurchaseOrderRow {
  id: string;
  orderNumber: string;
  status: string;
  currency: string;
  totalAmount: string;
  expectedDeliveryDate: string | null;
  actualDeliveryDate: string | null;
  createdAt: string;
  isDemoData: boolean;
  sourceRecommendationId: string | null;
  supplier: { id: string; code: string; name: string; reliabilityScore: number };
  warehouse: { id: string; code: string; name: string } | null;
  _count: { items: number; shipments: number };
}

interface PurchaseOrderDetail extends Omit<PurchaseOrderRow, '_count'> {
  createdBy: { firstName: string; lastName: string } | null;
  approvedBy: { firstName: string; lastName: string } | null;
  items: Array<{
    id: string;
    quantity: string;
    receivedQuantity: string;
    rejectedQuantity: string;
    unitPrice: string;
    lineTotal: string;
    product: { id: string; sku: string; name: string; unitOfMeasure: string };
  }>;
  shipments: Array<{ id: string; trackingNumber: string; status: string; estimatedArrivalAt: string | null }>;
  allowedTransitions: string[];
}

interface SupplierOption {
  id: string;
  code: string;
  name: string;
}

const TABS = [
  { href: '/suppliers', labelKey: 'nav.suppliers' as const, icon: Factory },
  { href: '/purchase-orders', labelKey: 'nav.orders' as const, icon: ClipboardList },
];

export default function PurchaseOrdersPage() {
  const client = useQueryClient();
  const { can } = useAuth();
  const { t } = useI18n();
  const f = useFormat();
  const toast = useToast();

  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);

  const orders = useQuery({
    queryKey: ['purchase-orders', { status, page }],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: '30' });
      if (status) params.set('status', status);
      return api<Paginated<PurchaseOrderRow>>(`/purchase-orders?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  // One count per status pill. The list endpoint has no aggregate, so each count reads a page's
  // `meta.total`. Terminal statuses fetch a single row; open ones fetch their rows too, because
  // "late" is judged on open orders across every page, not just the visible one.
  const counts = useQueries({
    queries: PO_STATUSES.map((value) => ({
      queryKey: ['purchase-orders', 'count', value],
      queryFn: () =>
        api<Paginated<PurchaseOrderRow>>(
          `/purchase-orders?status=${value}&limit=${OPEN_STATUSES.includes(value) ? 200 : 1}`,
        ),
    })),
  });
  const countOf = (value: string): number | undefined =>
    counts[PO_STATUSES.indexOf(value as (typeof PO_STATUSES)[number])]?.data?.meta.total;
  const countsReady = counts.every((query) => query.data);
  const allCount = countsReady ? PO_STATUSES.reduce((sum, value) => sum + (countOf(value) ?? 0), 0) : undefined;
  const openCount = countsReady ? OPEN_STATUSES.reduce((sum, value) => sum + (countOf(value) ?? 0), 0) : undefined;

  // Open and past their expected date. An order delivered late is history, flagged on its row.
  const openRows = OPEN_STATUSES.flatMap((value) => counts[PO_STATUSES.indexOf(value as (typeof PO_STATUSES)[number])]?.data?.data ?? []);
  const lateCount = openRows.filter(isLate).length;
  const lateCapped = OPEN_STATUSES.some(
    (value) => counts[PO_STATUSES.indexOf(value as (typeof PO_STATUSES)[number])]?.data?.meta.hasNextPage,
  );

  // Suppliers for the new-order form.
  const suppliers = useQuery({
    queryKey: ['suppliers', 'leaderboard'],
    queryFn: () => api<SupplierOption[]>('/suppliers/leaderboard?limit=50'),
    enabled: can('purchase_order:create'),
  });

  const transition = useMutation({
    mutationFn: (input: { id: string; status: string; from: string; orderNumber: string }) =>
      api(`/purchase-orders/${input.id}/transition`, {
        method: 'POST',
        body: {
          status: input.status,
          ...(input.status === 'CANCELLED' ? { reason: t('po.cancelReason') } : {}),
        },
      }),
    onSuccess: (_data, input) => {
      void client.invalidateQueries({ queryKey: ['purchase-orders'] });
      setFlashId(input.id);
      window.setTimeout(() => setFlashId((current) => (current === input.id ? null : current)), 1200);
      // The API's state machine is forward-only, so Undo is offered only for a move that can be
      // walked back — today none can, and the toast says what happened without pretending.
      const reversible = PO_NEXT[input.status]?.includes(input.from);
      toast.show({
        message: t('po.v3.moved', { order: input.orderNumber, status: t(poStatusKey(input.status)) }),
        onUndo: reversible
          ? () =>
              transition.mutate({
                id: input.id,
                status: input.from,
                from: input.status,
                orderNumber: input.orderNumber,
              })
          : undefined,
      });
    },
    onError: (error) => toast.show({ message: error instanceof Error ? error.message : String(error), tone: 'error' }),
  });

  const pageRows = useMemo(() => orders.data?.data ?? [], [orders.data]);
  const fromReco = pageRows.filter((order) => order.sourceRecommendationId).length;

  const title = !countsReady
    ? t('common.loading')
    : allCount === 0
      ? t('po.v3.titleEmpty')
      : lateCount === 0
        ? t('po.v3.titleOk', { open: f.int(openCount) })
        : lateCount === 1 && !lateCapped
          ? t('po.v3.titleLateOne', { open: f.int(openCount) })
          : t('po.v3.titleLate', { n: `${f.int(lateCount)}${lateCapped ? '+' : ''}`, open: f.int(openCount) });

  const canCreate = can('purchase_order:create');
  const selected = pageRows.find((order) => order.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <SubTabs tabs={TABS} />

      <PageHeader
        kicker={`${t('nav.pillar.network')} · ${t('nav.orders')}`}
        title={title}
        description={t('po.v3.intro')}
        actions={
          canCreate ? (
            <Button
              variant="primary"
              icon={ClipboardPlus}
              disabled={!suppliers.data || suppliers.data.length === 0}
              onClick={() => {
                setSelectedId(null);
                setComposing(true);
              }}
            >
              {t('sup.v3.newOrder')}
            </Button>
          ) : null
        }
      />

      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Kpi label={t('po.v3.kpiOpen')} value={f.int(openCount)} icon={ClipboardList} />
        <Kpi
          label={t('po.v3.kpiLate')}
          value={countsReady ? `${f.int(lateCount)}${lateCapped ? '+' : ''}` : '—'}
          sub={t('po.v3.kpiLateSub')}
          tone={lateCount > 0 ? 'warn' : 'neutral'}
        />
        <Kpi
          label={t('po.v3.kpiOrigin')}
          value={pageRows.length > 0 ? f.pct(fromReco / pageRows.length, 0) : '—'}
          sub={t('po.v3.kpiOriginSub', { n: fromReco, total: pageRows.length })}
          icon={Sparkles}
        />
      </div>

      {/* Status filter: one pill per state, each with its count. */}
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('po.status')}>
        <button
          type="button"
          className="pill"
          aria-pressed={status === ''}
          onClick={() => {
            setStatus('');
            setPage(1);
          }}
        >
          {t('po.v3.all')}
          {allCount !== undefined && <span className="pill-count">{f.int(allCount)}</span>}
        </button>
        {PO_STATUSES.map((value) => {
          const n = countOf(value);
          return (
            <button
              key={value}
              type="button"
              className="pill"
              aria-pressed={status === value}
              onClick={() => {
                setStatus(value);
                setPage(1);
              }}
            >
              {t(poStatusKey(value))}
              {n !== undefined && <span className="pill-count">{f.int(n)}</span>}
            </button>
          );
        })}
      </div>

      <div className={`grid items-start gap-6 ${selected || composing ? 'xl:grid-cols-[minmax(0,1fr)_400px]' : ''}`}>
        <Panel
          title={t('po.title')}
          icon={ClipboardList}
          meta={orders.data ? <span className="pill-count">{f.int(orders.data.meta.total)}</span> : null}
          loading={orders.isFetching && !orders.isLoading}
        >
          {orders.isError ? (
            <ErrorNote error={orders.error} onRetry={() => void orders.refetch()} />
          ) : orders.isLoading ? (
            <Loading rows={6} />
          ) : pageRows.length > 0 ? (
            <div className="overflow-x-auto pt-2">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>{t('po.order')}</th>
                    <th>{t('po.v3.origin')}</th>
                    <th>{t('po.status')}</th>
                    <th>{t('po.supplier')}</th>
                    <th>{t('po.receiving')}</th>
                    <th className="text-right">{t('po.lines')}</th>
                    <th className="text-right">{t('po.value')}</th>
                    <th className="text-right">{t('po.expected')}</th>
                    <th className="text-right">{t('po.actual')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((order) => {
                    const late = isLate(order);
                    const isSelected = order.id === selectedId;
                    const next = PO_NEXT[order.status] ?? [];
                    return (
                      <tr
                        key={order.id}
                        aria-selected={isSelected}
                        tabIndex={0}
                        className={`cursor-pointer ${flashId === order.id ? 'flash' : ''}`}
                        onClick={() => {
                          setComposing(false);
                          setSelectedId(isSelected ? null : order.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setComposing(false);
                            setSelectedId(isSelected ? null : order.id);
                          }
                        }}
                      >
                        <td>
                          <span className="flex items-center gap-2">
                            <span className="t-data text-[12.5px]">{order.orderNumber}</span>
                            {order.isDemoData && <DemoTag />}
                          </span>
                        </td>
                        <td>
                          {order.sourceRecommendationId ? (
                            <span
                              className="flex items-center gap-1.5 text-[12.5px]"
                              title={t('po.raisedByAi')}
                            >
                              <Sparkles className="h-3.5 w-3.5 text-[var(--color-muted)]" />
                              {t('po.v3.fromReco')}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-muted)]">
                              <Hand className="h-3.5 w-3.5" />
                              {t('po.v3.manual')}
                            </span>
                          )}
                        </td>
                        <td>
                          <span className="flex items-center gap-1.5 whitespace-nowrap text-[12.5px]">
                            {order.status === 'CANCELLED' ? (
                              <span className="text-[var(--color-dim)]">{t(poStatusKey(order.status))}</span>
                            ) : (
                              t(poStatusKey(order.status))
                            )}
                          </span>
                        </td>
                        <td>
                          <span className="block text-[13px]">{order.supplier.name}</span>
                          <span className="t-data text-[11px] text-[var(--color-dim)]">
                            {t('po.reliability', { score: f.num(order.supplier.reliabilityScore, 0) })}
                          </span>
                        </td>
                        <td className="t-data text-[12px] text-[var(--color-muted)]">
                          {order.warehouse?.code ?? '—'}
                        </td>
                        <td className="t-data text-right text-[12.5px]">{f.int(order._count.items)}</td>
                        <td className="t-data whitespace-nowrap text-right text-[12.5px]">
                          {f.money(order.totalAmount, order.currency)}
                        </td>
                        <td className="t-data whitespace-nowrap text-right text-[12px] text-[var(--color-muted)]">
                          <span className="inline-flex items-center gap-1.5">
                            {late && !order.actualDeliveryDate && <SeverityIcon severity="warning" size={14} />}
                            {f.date(order.expectedDeliveryDate)}
                          </span>
                        </td>
                        <td className="t-data whitespace-nowrap text-right text-[12px] text-[var(--color-muted)]">
                          <span className="inline-flex items-center gap-1.5">
                            {late && order.actualDeliveryDate && <SeverityIcon severity="warning" size={14} />}
                            {f.date(order.actualDeliveryDate)}
                          </span>
                        </td>
                        <td className="text-right" onClick={(event) => event.stopPropagation()}>
                          {can('purchase_order:approve') && next.length > 0 ? (
                            confirmCancel === order.id ? (
                              <span className="fade-in inline-flex items-center gap-2">
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  onClick={() => {
                                    setConfirmCancel(null);
                                    transition.mutate({
                                      id: order.id,
                                      status: 'CANCELLED',
                                      from: order.status,
                                      orderNumber: order.orderNumber,
                                    });
                                  }}
                                >
                                  {t('po.v3.confirmCancel')}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(null)}>
                                  {t('po.v3.keep')}
                                </Button>
                              </span>
                            ) : (
                              <select
                                className="field !h-[30px] !w-auto !text-[12px]"
                                value=""
                                aria-label={t('po.moveTo')}
                                disabled={transition.isPending}
                                onChange={(event) => {
                                  const target = event.target.value;
                                  if (!target) return;
                                  // Cancelling cannot be undone, so it alone asks first.
                                  if (target === 'CANCELLED') {
                                    setConfirmCancel(order.id);
                                    return;
                                  }
                                  transition.mutate({
                                    id: order.id,
                                    status: target,
                                    from: order.status,
                                    orderNumber: order.orderNumber,
                                  });
                                }}
                              >
                                <option value="">{t('po.moveTo')}</option>
                                {next.map((value) => (
                                  <option key={value} value={value}>
                                    {t(poStatusKey(value))}
                                  </option>
                                ))}
                              </select>
                            )
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : status ? (
            <Empty
              title={t('po.v3.filterEmpty', { status: t(poStatusKey(status)) })}
              hint={t('po.v3.filterEmptyHint')}
              icon={ClipboardList}
              action={
                <Button size="sm" onClick={() => setStatus('')}>
                  {t('po.v3.showAll')}
                </Button>
              }
            />
          ) : (
            <Empty title={t('po.none')} hint={t('po.noneHint')} icon={ClipboardList} />
          )}

          {orders.data && orders.data.meta.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-[var(--color-line)] px-5 py-3">
              <span className="t-label">
                {t('tbl.page', { page: orders.data.meta.page, total: orders.data.meta.totalPages })}
              </span>
              <div className="flex gap-2">
                <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  {t('tbl.prev')}
                </Button>
                <Button size="sm" disabled={!orders.data.meta.hasNextPage} onClick={() => setPage((p) => p + 1)}>
                  {t('tbl.next')}
                </Button>
              </div>
            </div>
          )}
        </Panel>

        {composing && suppliers.data ? (
          <NewOrderPanel suppliers={suppliers.data} onClose={() => setComposing(false)} />
        ) : selected ? (
          <OrderDetail key={selected.id} id={selected.id} onClose={() => setSelectedId(null)} />
        ) : null}
      </div>
    </div>
  );
}

/** The order's lines, how much of each has been received, and the shipments carrying it. */
function OrderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const f = useFormat();

  const detail = useQuery({
    queryKey: ['purchase-orders', 'detail', id],
    queryFn: () => api<PurchaseOrderDetail>(`/purchase-orders/${id}`),
  });

  const order = detail.data;
  const ordered = order?.items.reduce((sum, item) => sum + Number(item.quantity), 0) ?? 0;
  const received = order?.items.reduce((sum, item) => sum + Number(item.receivedQuantity), 0) ?? 0;
  const late = order ? isLate(order) : false;
  const person = (p: { firstName: string; lastName: string } | null) => (p ? `${p.firstName} ${p.lastName}` : '—');

  return (
    <aside className="panel slide-in-right flex flex-col gap-5 p-5" aria-label={order?.orderNumber ?? t('po.order')}>
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="t-label">{order ? t(poStatusKey(order.status)) : t('po.order')}</span>
          <h2 className="t-h3 m-0 flex items-center gap-2">
            {late && <SeverityIcon severity="warning" />}
            <span className="t-data truncate">{order?.orderNumber ?? '…'}</span>
            {order?.isDemoData && <DemoTag />}
          </h2>
          {order && <span className="text-[13px] text-[var(--color-muted)]">{order.supplier.name}</span>}
        </div>
        <Button variant="ghost" size="sm" icon={X} onClick={onClose} aria-label={t('common.close')} />
      </header>

      {detail.isError ? (
        <ErrorNote error={detail.error} onRetry={() => void detail.refetch()} />
      ) : !order ? (
        <Loading rows={5} />
      ) : (
        <>
          <div className="tile flex flex-col gap-2 p-4">
            <MetricRow
              label={t('po.v3.receivingProgress')}
              value={`${f.int(received)} / ${f.int(ordered)}`}
              meter={ordered > 0 ? received / ordered : 0}
              tone="signal"
            />
          </div>

          <Facts
            items={[
              [
                t('po.v3.origin'),
                order.sourceRecommendationId ? (
                  <span className="flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-[var(--color-muted)]" />
                    {t('po.v3.fromReco')}
                  </span>
                ) : (
                  t('po.v3.manual')
                ),
              ],
              [t('po.receiving'), <span className="t-data">{order.warehouse?.code ?? '—'}</span>],
              [t('po.value'), <span className="t-data">{f.money(order.totalAmount, order.currency)}</span>],
              [t('po.created'), <span className="t-data">{f.date(order.createdAt)}</span>],
              [t('po.expected'), <span className="t-data">{f.date(order.expectedDeliveryDate)}</span>],
              [t('po.actual'), <span className="t-data">{f.date(order.actualDeliveryDate)}</span>],
              [t('po.v3.createdBy'), person(order.createdBy)],
              [t('po.v3.approvedBy'), person(order.approvedBy)],
            ]}
          />

          <section className="flex flex-col gap-3">
            <h3 className="t-h4 m-0">{t('po.lines')}</h3>
            <ul className="stagger m-0 flex list-none flex-col gap-3 p-0">
              {order.items.map((item) => {
                const qty = Number(item.quantity);
                const got = Number(item.receivedQuantity);
                const rejected = Number(item.rejectedQuantity);
                return (
                  <li key={item.id} className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0">
                        <span className="t-data text-[12.5px]">{item.product.sku}</span>{' '}
                        <span className="text-[12.5px] text-[var(--color-muted)]">{item.product.name}</span>
                      </span>
                      <span className="t-data whitespace-nowrap text-[12px]">
                        {f.int(got)} / {f.int(qty)} {item.product.unitOfMeasure}
                      </span>
                    </div>
                    <Meter value={qty > 0 ? got / qty : 0} tone="signal" />
                    {rejected > 0 && (
                      <span className="flex items-center gap-1.5 text-[12px] text-[var(--color-muted)]">
                        <SeverityIcon severity="warning" size={14} />
                        {t('po.v3.rejected', { n: f.int(rejected) })}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="t-h4 m-0">{t('po.v3.shipments')}</h3>
            {order.shipments.length === 0 ? (
              <p className="m-0 text-[13px] text-[var(--color-muted)]">{t('po.v3.noShipments')}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {order.shipments.map((shipment) => (
                  <li key={shipment.id} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                    <a
                      href={`/shipments?q=${encodeURIComponent(shipment.trackingNumber)}`}
                      className="t-data underline-offset-2 hover:underline"
                    >
                      {shipment.trackingNumber}
                    </a>
                    <span className="text-[var(--color-muted)]">
                      {shipment.status} · {f.date(shipment.estimatedArrivalAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </aside>
  );
}
