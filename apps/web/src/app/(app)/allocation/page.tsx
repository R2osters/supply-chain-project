'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Explanation, type Paginated } from '@/lib/api';
import { Chip, Empty, ErrorNote, Explain, Loading, Meter, Panel, fmt } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/lib/i18n';

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
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState(20000);
  const [budget, setBudget] = useState<string>('');
  const [deadline, setDeadline] = useState<string>('7');
  const [maxShare, setMaxShare] = useState<string>('0.5');

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

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">{t('alloc.title')}</h1>
        <p className="mt-0.5 max-w-3xl text-[0.8125rem] leading-relaxed text-[var(--color-ink-dim)]">
          {t('alloc.intro')}
        </p>
      </div>

      <Panel title={t('alloc.question')}>
        <div className="grid gap-3 p-3.5 md:grid-cols-5">
          <label className="md:col-span-2">
            <Legend>{t('alloc.product')}</Legend>
            <select className="field" value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">{t('alloc.select')}</option>
              {products.data?.data.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.sku} — {product.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            <Legend>{t('alloc.quantity')}</Legend>
            <input
              className="field"
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
            />
          </label>

          <label>
            <Legend>{t('alloc.withinDays')}</Legend>
            <input
              className="field"
              type="number"
              min={0}
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              placeholder={t('alloc.noDeadline')}
            />
          </label>

          <label>
            <Legend>{t('alloc.maxShare')}</Legend>
            <input
              className="field"
              type="number"
              step="0.05"
              min="0.05"
              max="1"
              value={maxShare}
              onChange={(e) => setMaxShare(e.target.value)}
              placeholder={t('alloc.unconstrained')}
            />
          </label>

          <label className="md:col-span-2">
            <Legend>{t('alloc.budget')}</Legend>
            <input
              className="field"
              type="number"
              min={0}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder={t('alloc.noCap')}
            />
          </label>

          <div className="flex items-end md:col-span-3">
            <button
              className="btn btn-primary"
              disabled={!productId || quantity <= 0 || allocate.isPending}
              onClick={() => allocate.mutate()}
            >
              {allocate.isPending ? t('alloc.solving') : t('alloc.solve')}
            </button>
          </div>
        </div>
      </Panel>

      {allocate.isError && <ErrorNote error={allocate.error} />}
      {allocate.isPending && (
        <Panel loading>
          <Loading label={t('alloc.branchAndBound')} />
        </Panel>
      )}

      {data && (
        <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
          <Panel
            title={t('alloc.plan')}
            meta={
              <Chip tone={data.status === 'OPTIMAL' ? 'ok' : data.status === 'FEASIBLE' ? 'warn' : 'alert'}>
                {data.status}
              </Chip>
            }
            actions={
              <span className="tnum">{t('alloc.solvedIn', { ms: data.solverWallTimeMs })}</span>
            }
          >
            {data.lines.length === 0 ? (
              <Empty title={t('alloc.infeasible')} hint={data.explanation.summary} />
            ) : (
              <>
                <table className="grid-table">
                  <thead>
                    <tr>
                      <th>{t('alloc.supplier')}</th>
                      <th className="text-right">{t('alloc.quantity')}</th>
                      <th className="w-28">{t('alloc.share')}</th>
                      <th className="text-right">{t('alloc.unitPrice')}</th>
                      <th className="text-right">{t('alloc.leadTime')}</th>
                      <th className="text-right">{t('alloc.reliability')}</th>
                      <th className="text-right">{t('alloc.cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lines.map((line) => (
                      <tr key={line.supplierId}>
                        <td className="text-[0.8125rem]">{line.name}</td>
                        <td className="tnum text-right font-mono">{fmt.int(line.quantity)}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            <div className="flex-1">
                              <Meter value={line.sharePercent / 100} />
                            </div>
                            <span className="tnum font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
                              {fmt.num(line.sharePercent, 0)}%
                            </span>
                          </div>
                        </td>
                        <td className="tnum text-right font-mono text-[0.75rem]">
                          {fmt.num(line.unitPrice, 2)}
                        </td>
                        <td className="tnum text-right font-mono text-[0.75rem]">
                          {fmt.num(line.expectedLeadTimeDays, 0)} d
                        </td>
                        <td className="tnum text-right font-mono text-[0.75rem]">
                          {fmt.pct(line.reliability)}
                        </td>
                        <td className="tnum text-right font-mono text-[0.75rem] text-[var(--color-ink-dim)]">
                          {fmt.int(line.purchaseCost + line.transportCost)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {data.unmetDemand > 0 && (
                  <div className="border-t border-[var(--color-alert-dim)] bg-[color-mix(in_srgb,var(--color-alert)_7%,transparent)] px-3.5 py-2.5 text-[0.8125rem] text-[var(--color-alert)]">
                    {t('alloc.unmet', { n: fmt.int(data.unmetDemand) })}
                  </div>
                )}

                <div className="border-t border-[var(--color-hairline)] p-3.5">
                  <Explain
                    summary={data.explanation.summary}
                    reasons={data.explanation.reasons}
                    assumptions={data.explanation.assumptions}
                  />
                </div>
              </>
            )}
          </Panel>

          <div className="space-y-4">
            <Panel title={t('alloc.outcome')}>
              <div className="grid grid-cols-2 gap-px bg-[var(--color-hairline)]">
                <Metric
                  label={t('alloc.objective')}
                  value={fmt.int(data.objectiveValue)}
                  hint={t('alloc.objectiveHint')}
                />
                <Metric
                  label={t('alloc.expectedLeadTime')}
                  value={`${fmt.num(data.expectedDeliveryDays, 1)} d`}
                  hint={t('alloc.expectedLeadTimeHint')}
                />
                <Metric
                  label={t('alloc.shortfallRisk')}
                  value={fmt.pct(data.stockoutRisk, 1)}
                  hint={t('alloc.shortfallRiskHint')}
                  tone={data.stockoutRisk > 0.15 ? 'alert' : data.stockoutRisk > 0.05 ? 'warn' : 'ok'}
                />
                <Metric
                  label={t('alloc.concentration')}
                  value={fmt.num(data.concentrationIndex, 2)}
                  hint={t('alloc.concentrationHint')}
                  tone={data.concentrationIndex > 0.6 ? 'warn' : 'ok'}
                />
              </div>
            </Panel>

            {data.costBreakdown && (
              <Panel title={t('alloc.costBreakdown')}>
                <ul className="p-3.5">
                  {Object.entries(data.costBreakdown)
                    .filter(([, value]) => value > 0)
                    .sort((a, b) => b[1] - a[1])
                    .map(([key, value]) => {
                      const total = Object.values(data.costBreakdown!).reduce((s, v) => s + v, 0);
                      return (
                        <li key={key} className="mb-2.5 last:mb-0">
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="text-[0.75rem] text-[var(--color-ink-dim)]">
                              {COST_KEYS.has(key)
                                ? t(`alloc.cost.${key}` as TranslationKey)
                                : key}
                            </span>
                            <span className="tnum font-mono text-[0.75rem]">{fmt.int(value)}</span>
                          </div>
                          <div className="mt-1">
                            <Meter
                              value={total > 0 ? value / total : 0}
                              tone={key.includes('Penalty') ? 'alert' : 'signal'}
                            />
                          </div>
                        </li>
                      );
                    })}
                </ul>
              </Panel>
            )}

            <Panel title={t('alloc.constraints')}>
              <ul className="space-y-1.5 p-3.5">
                {data.constraints.map((constraint, index) => (
                  <li
                    key={index}
                    className="flex gap-2 text-[0.6875rem] leading-relaxed text-[var(--color-ink-dim)]"
                  >
                    <span className="mt-[0.4rem] h-px w-2 shrink-0 bg-[var(--color-info)]" />
                    {constraint}
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </div>
      )}

      {!data && !allocate.isPending && (
        <Panel>
          <Empty
            title={t('alloc.noPlan')}
            hint={t('alloc.noPlanHint')}
          />
        </Panel>
      )}
    </div>
  );
}

function Legend({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
      {children}
    </span>
  );
}

function Metric({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'ok' | 'warn' | 'alert' | 'neutral';
}) {
  const colour = {
    ok: 'var(--color-ok)',
    warn: 'var(--color-warn)',
    alert: 'var(--color-alert)',
    neutral: 'var(--color-ink)',
  }[tone];

  return (
    <div className="bg-[var(--color-panel)] px-3.5 py-3">
      <div className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
        {label}
      </div>
      <div className="tnum mt-1 font-mono text-lg" style={{ color: colour }}>
        {value}
      </div>
      <div className="text-[0.625rem] text-[var(--color-ink-faint)]">{hint}</div>
    </div>
  );
}
