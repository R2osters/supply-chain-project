'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ClipboardList,
  ListChecks,
  Play,
  Scale,
  Split,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, type Explanation, type Paginated } from '@/lib/api';
import {
  Banner,
  Button,
  Chip,
  Empty,
  ErrorNote,
  Explain,
  Meter,
  PageHeader,
  Panel,
  SeverityIcon,
  StatTile,
  type Tone,
} from '@/components/ui';
import { SubTabs } from '@/components/shell/sub-tabs';
import { useToast } from '@/components/toast';
import { useAuth } from '@/lib/auth';
import { useFormat, useI18n, type TranslationKey } from '@/lib/i18n';
import {
  FieldLabel,
  HumanConsent,
  OPTIMISE_TABS,
  ResultSkeleton,
  Timing,
  WhyToggle,
} from './_components/optimise-kit';

interface ProductRow {
  id: string;
  sku: string;
  name: string;
}

interface AllocationLine {
  supplierId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  purchaseCost: number;
  transportCost: number;
  expectedLeadTimeDays: number;
  reliability: number;
  sharePercent: number;
}

interface AllocationResponse {
  status: string;
  lines: AllocationLine[];
  unmetDemand: number;
  objectiveValue: number | null;
  costBreakdown: Record<string, number> | null;
  expectedDeliveryDays: number;
  stockoutRisk: number;
  concentrationIndex: number;
  constraints: string[];
  solverWallTimeMs: number;
  explanation: Explanation;
}

interface CreatedOrder {
  id: string;
  orderNumber: string;
}

/** Cost components the solver reports. Anything outside this set falls back to its raw key. */
const COST_KEYS = new Set([
  'purchase',
  'transport',
  'holding',
  'stockoutPenalty',
  'delayPenalty',
  'riskPenalty',
]);

export default function AllocationPage() {
  const { t } = useI18n();
  const format = useFormat();
  const router = useRouter();
  const client = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState(20000);
  const [budget, setBudget] = useState<string>('');
  const [deadline, setDeadline] = useState<string>('7');
  const [maxShare, setMaxShare] = useState<string>('0.5');
  const [why, setWhy] = useState(false);
  // Orders are raised once per solved plan: re-clicking would duplicate them at the supplier.
  const [ordersFor, setOrdersFor] = useState<AllocationResponse | null>(null);

  const products = useQuery({
    queryKey: ['products', 'for-allocation'],
    queryFn: () => api<Paginated<ProductRow>>('/products?limit=100'),
  });

  const allocate = useMutation({
    mutationFn: () =>
      api<AllocationResponse>('/ai/supplier/allocation', {
        method: 'POST',
        body: {
          productId,
          quantity,
          ...(budget ? { budget: Number(budget) } : {}),
          ...(deadline ? { requiredWithinDays: Number(deadline) } : {}),
          ...(maxShare ? { maxSupplierSharePercent: Number(maxShare) } : {}),
        },
      }),
  });

  const data = allocate.data;
  const orderable = data?.lines.filter((line) => Math.round(line.quantity) > 0) ?? [];

  /**
   * One DRAFT purchase order per supplier line, through the ordinary purchase-order endpoint, at
   * the unit price the solver used. DRAFT means nothing reaches a supplier until someone moves it
   * on from the purchase-order screen — the human consent the charte asks for.
   */
  const createOrders = useMutation({
    mutationFn: async (plan: AllocationResponse) => {
      const created: CreatedOrder[] = [];
      const failures: string[] = [];
      for (const line of plan.lines.filter((entry) => Math.round(entry.quantity) > 0)) {
        try {
          created.push(
            await api<CreatedOrder>('/purchase-orders', {
              method: 'POST',
              body: {
                supplierId: line.supplierId,
                items: [{ productId, quantity: Math.round(line.quantity), unitPrice: line.unitPrice }],
                notes: t('alloc.v3.poNote'),
              },
            }),
          );
        } catch (error) {
          failures.push(`${line.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { created, failures };
    },
    onSuccess: ({ created, failures }, plan) => {
      void client.invalidateQueries({ queryKey: ['purchase-orders'] });
      if (created.length > 0) setOrdersFor(plan);
      if (failures.length > 0) {
        toast.show({
          tone: 'error',
          durationMs: 10000,
          message: t('alloc.v3.poPartial', { ok: created.length, failed: failures.length, list: failures.join(' · ') }),
        });
      }
      if (created.length === 0) return;
      toast.show({
        tone: 'success',
        durationMs: 8000,
        message: t('alloc.v3.poCreated', {
          n: created.length,
          list: created.map((order) => order.orderNumber).join(', '),
        }),
        action: { label: t('rec.v3.openPo'), onClick: () => router.push('/purchase-orders') },
        // DRAFT → CANCELLED is an allowed transition, so the orders can genuinely be withdrawn.
        onUndo: can('purchase_order:approve')
          ? () => {
              void Promise.allSettled(
                created.map((order) =>
                  api(`/purchase-orders/${order.id}/transition`, {
                    method: 'POST',
                    body: { status: 'CANCELLED', reason: t('alloc.v3.poUndoReason') },
                  }),
                ),
              ).then(() => {
                setOrdersFor(null);
                void client.invalidateQueries({ queryKey: ['purchase-orders'] });
                toast.show({ tone: 'info', message: t('alloc.v3.poUndone', { n: created.length }) });
              });
            }
          : undefined,
      });
    },
  });

  const state: 'idle' | 'running' | 'result' = allocate.isPending ? 'running' : data ? 'result' : 'idle';
  const product = products.data?.data.find((row) => row.id === productId);
  const totalCost = data?.lines.reduce((sum, line) => sum + line.purchaseCost + line.transportCost, 0) ?? 0;

  const title =
    state === 'running'
      ? t('alloc.v3.titleRunning')
      : state === 'result' && data
        ? data.lines.length === 0
          ? t('alloc.infeasible')
          : t('alloc.v3.titleResult', { n: data.lines.length, cost: format.money(totalCost) })
        : t('alloc.v3.titleIdle');

  const costTotal = data?.costBreakdown
    ? Object.values(data.costBreakdown).reduce((sum, value) => sum + value, 0)
    : 0;

  const statusChip = (status: string) => {
    if (status === 'OPTIMAL') return <Chip tone="neutral">{t('alloc.v3.status.OPTIMAL')}</Chip>;
    if (status === 'FEASIBLE')
      return (
        <span className="flex items-center gap-1.5">
          <SeverityIcon severity="warning" size={14} />
          <Chip tone="warn">{t('alloc.v3.status.FEASIBLE')}</Chip>
        </span>
      );
    return (
      <span className="flex items-center gap-1.5">
        <SeverityIcon severity="critical" size={14} />
        <Chip tone="alert">{status === 'INFEASIBLE' ? t('alloc.v3.status.INFEASIBLE') : status}</Chip>
      </span>
    );
  };

  const riskTone: Tone = data ? (data.stockoutRisk > 0.15 ? 'alert' : data.stockoutRisk > 0.05 ? 'warn' : 'neutral') : 'neutral';

  return (
    <div className="flex flex-col gap-6">
      <SubTabs tabs={OPTIMISE_TABS} />

      <PageHeader
        kicker={`${t('nav.pillar.optimise')} · ${t('alloc.v3.kicker')}`}
        title={title}
        description={t('alloc.v3.question')}
      />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
        {/* ------------------------------------------------------- question */}
        <Panel icon={Split} title={t('alloc.question')}>
          <div className="flex flex-col gap-4 px-5 pb-5 pt-3">
            <p className="m-0 text-[13px] leading-relaxed text-[var(--color-muted)]">{t('alloc.intro')}</p>

            <div>
              <FieldLabel htmlFor="alloc-product">{t('alloc.product')}</FieldLabel>
              <select
                id="alloc-product"
                className="field"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
              >
                <option value="">{t('alloc.select')}</option>
                {products.data?.data.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.sku} — {row.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel htmlFor="alloc-qty">{t('alloc.quantity')}</FieldLabel>
                <input
                  id="alloc-qty"
                  className="field t-data"
                  type="number"
                  min={1}
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                />
              </div>
              <div>
                <FieldLabel htmlFor="alloc-deadline">{t('alloc.withinDays')}</FieldLabel>
                <input
                  id="alloc-deadline"
                  className="field t-data"
                  type="number"
                  min={0}
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                  placeholder={t('alloc.noDeadline')}
                />
              </div>
              <div>
                <FieldLabel htmlFor="alloc-share">{t('alloc.maxShare')}</FieldLabel>
                <input
                  id="alloc-share"
                  className="field t-data"
                  type="number"
                  step="0.05"
                  min="0.05"
                  max="1"
                  value={maxShare}
                  onChange={(e) => setMaxShare(e.target.value)}
                  placeholder={t('alloc.unconstrained')}
                />
              </div>
              <div>
                <FieldLabel htmlFor="alloc-budget">{t('alloc.budget')}</FieldLabel>
                <input
                  id="alloc-budget"
                  className="field t-data"
                  type="number"
                  min={0}
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder={t('alloc.noCap')}
                />
              </div>
            </div>

            <Button
              variant={state === 'result' ? 'secondary' : 'primary'}
              icon={Play}
              disabled={!productId || quantity <= 0}
              loading={allocate.isPending}
              onClick={() => allocate.mutate()}
            >
              {allocate.isPending ? t('alloc.solving') : state === 'result' ? t('alloc.v3.resolve') : t('alloc.solve')}
            </Button>
            {products.isError && <ErrorNote error={products.error} onRetry={() => void products.refetch()} />}
          </div>
        </Panel>

        {/* --------------------------------------------------------- result */}
        <div className="flex min-w-0 flex-col gap-4" aria-live="polite">
          {allocate.isError && <ErrorNote error={allocate.error} onRetry={() => allocate.mutate()} />}

          {state === 'idle' && (
            <Panel>
              <Empty icon={Split} title={t('alloc.noPlan')} hint={t('alloc.noPlanHint')} />
            </Panel>
          )}

          {state === 'running' && (
            <Panel loading title={t('alloc.branchAndBound')}>
              <ResultSkeleton rows={6} />
            </Panel>
          )}

          {state === 'result' && data && (
            <div className="stagger flex flex-col gap-4">
              <Panel
                icon={Scale}
                title={t('alloc.v3.proposed')}
                meta={statusChip(data.status)}
                actions={<Timing ms={data.solverWallTimeMs} kind="solver" />}
              >
                {data.lines.length === 0 ? (
                  <Empty
                    icon={Split}
                    title={t('alloc.infeasible')}
                    hint={data.explanation.summary}
                  />
                ) : (
                  <div className="flex flex-col gap-4 pb-5 pt-2">
                    {product && (
                      <span className="t-data px-5 text-[12px] text-[var(--color-muted)]">
                        {product.sku} · {product.name} · {format.int(quantity)} u
                      </span>
                    )}
                    <div className="overflow-x-auto px-2">
                      <table className="grid-table">
                        <thead>
                          <tr>
                            <th>{t('alloc.supplier')}</th>
                            <th className="text-right">{t('alloc.quantity')}</th>
                            <th className="min-w-[120px]">{t('alloc.share')}</th>
                            <th className="text-right">{t('alloc.unitPrice')}</th>
                            <th className="text-right">{t('alloc.leadTime')}</th>
                            <th className="text-right">{t('alloc.reliability')}</th>
                            <th className="text-right">{t('alloc.cost')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.lines.map((line) => (
                            <tr key={line.supplierId}>
                              <td className="text-[13px]">{line.name}</td>
                              <td className="t-data text-right">{format.int(line.quantity)}</td>
                              <td>
                                <div className="flex items-center gap-2">
                                  <div className="flex-1">
                                    <Meter value={line.sharePercent / 100} />
                                  </div>
                                  <span className="t-data text-[11px] text-[var(--color-muted)]">
                                    {format.num(line.sharePercent, 0)} %
                                  </span>
                                </div>
                              </td>
                              <td className="t-data text-right">{format.num(line.unitPrice, 2)}</td>
                              <td className="t-data text-right">
                                {t('fc.v3.days', { n: format.num(line.expectedLeadTimeDays, 0) })}
                              </td>
                              <td className="t-data text-right">{format.pct(line.reliability)}</td>
                              <td className="t-data text-right text-[var(--color-muted)]">
                                {format.int(line.purchaseCost + line.transportCost)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {data.unmetDemand > 0 && (
                      <div className="px-5">
                        <Banner
                          tone="alert"
                          icon={Split}
                          title={t('alloc.unmet', { n: format.int(data.unmetDemand) })}
                        >
                          {t('alloc.v3.unmetHint')}
                        </Banner>
                      </div>
                    )}

                    <div className="px-5">
                      <WhyToggle open={why} onToggle={() => setWhy((open) => !open)} label={t('alloc.v3.why')}>
                        <Explain
                          summary={data.explanation.summary}
                          reasons={data.explanation.reasons}
                          assumptions={data.explanation.assumptions}
                        />
                      </WhyToggle>
                    </div>

                    {can('purchase_order:create') && orderable.length > 0 && (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--color-line)] px-5 pt-4">
                        <Button
                          variant="primary"
                          icon={ClipboardList}
                          loading={createOrders.isPending}
                          disabled={ordersFor === data}
                          onClick={() => createOrders.mutate(data)}
                        >
                          {ordersFor === data
                            ? t('alloc.v3.poDone', { n: orderable.length })
                            : t('alloc.v3.createPo', { n: orderable.length })}
                        </Button>
                        <span className="flex flex-col gap-0.5">
                          <span className="text-[12px] text-[var(--color-muted)]">{t('alloc.v3.poDraft')}</span>
                          <HumanConsent />
                        </span>
                      </div>
                    )}
                    {createOrders.isError && <ErrorNote error={createOrders.error} />}
                  </div>
                )}
              </Panel>

              <div className="grid gap-4 xl:grid-cols-2">
                <Panel icon={Scale} title={t('alloc.outcome')}>
                  <div className="grid grid-cols-2 gap-3 px-5 pb-5 pt-3">
                    <StatTile
                      label={t('alloc.objective')}
                      value={format.int(data.objectiveValue)}
                      sub={t('alloc.objectiveHint')}
                    />
                    <StatTile
                      label={t('alloc.expectedLeadTime')}
                      value={format.num(data.expectedDeliveryDays, 1)}
                      unit={t('alloc.v3.daysUnit')}
                      sub={t('alloc.expectedLeadTimeHint')}
                    />
                    <StatTile
                      label={t('alloc.shortfallRisk')}
                      value={format.pct(data.stockoutRisk, 1)}
                      sub={t('alloc.shortfallRiskHint')}
                      tone={riskTone}
                    />
                    <StatTile
                      label={t('alloc.concentration')}
                      value={format.num(data.concentrationIndex, 2)}
                      sub={t('alloc.concentrationHint')}
                      tone={data.concentrationIndex > 0.6 ? 'warn' : 'neutral'}
                    />
                  </div>
                </Panel>

                {data.costBreakdown && (
                  <Panel icon={Scale} title={t('alloc.costBreakdown')}>
                    <ul className="m-0 flex list-none flex-col gap-3 px-5 pb-5 pt-3">
                      {Object.entries(data.costBreakdown)
                        .filter(([, value]) => value > 0)
                        .sort((a, b) => b[1] - a[1])
                        .map(([key, value]) => (
                          <li key={key} className="flex flex-col gap-1.5">
                            <span className="flex items-baseline justify-between gap-3">
                              <span className="flex items-center gap-1.5 text-[13px] text-[var(--color-muted)]">
                                {key.includes('Penalty') && <SeverityIcon severity="warning" size={14} />}
                                {COST_KEYS.has(key) ? t(`alloc.cost.${key}` as TranslationKey) : key}
                              </span>
                              <span className="t-data text-[13px]">{format.int(value)}</span>
                            </span>
                            <Meter
                              value={costTotal > 0 ? value / costTotal : 0}
                              tone={key.includes('Penalty') ? 'warn' : 'signal'}
                            />
                          </li>
                        ))}
                    </ul>
                  </Panel>
                )}
              </div>

              <Panel icon={ListChecks} title={t('alloc.constraints')}>
                <ul className="m-0 flex list-none flex-col gap-1.5 px-5 pb-5 pt-3">
                  {data.constraints.map((constraint, index) => (
                    <li key={index} className="flex gap-2 text-[13px] leading-relaxed text-[var(--color-muted)]">
                      <span className="mt-[0.6rem] h-px w-2 shrink-0 bg-[var(--color-muted)]" />
                      {constraint}
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
