'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Explanation, type Paginated } from '@/lib/api';
import { Chip, Empty, ErrorNote, Explain, Loading, Meter, Panel, fmt } from '@/components/ui';

interface ProductRow {
  id: string;
  sku: string;
  name: string;
}

interface CaseResult {
  name: string;
  totalCost: number;
  totalCostP05: number;
  totalCostP95: number;
  stockoutRisk: number;
  averageInventoryUnits: number;
  serviceLevel: number;
  expectedDelayDays: number;
  fillRate: number;
  ordersPlaced: number;
}

interface ScenarioResponse {
  cases: CaseResult[];
  iterations: number;
  explanation: Explanation;
}

const LEVERS = [
  { key: 'demandChangePercent', label: 'Demand', step: 0.05, min: -0.5, max: 1 },
  { key: 'leadTimeChangePercent', label: 'Lead time', step: 0.05, min: -0.5, max: 1 },
  { key: 'supplierDelayDays', label: 'Supplier delay (days)', step: 1, min: 0, max: 30 },
  { key: 'fuelPriceChangePercent', label: 'Fuel price', step: 0.05, min: -0.5, max: 1 },
  { key: 'transportCostChangePercent', label: 'Transport cost', step: 0.05, min: -0.5, max: 1 },
  { key: 'stockLevelChangePercent', label: 'Starting stock', step: 0.05, min: -0.9, max: 1 },
  { key: 'unitPriceChangePercent', label: 'Unit price', step: 0.05, min: -0.5, max: 1 },
] as const;

export default function ScenariosPage() {
  const [productId, setProductId] = useState('');
  const [horizon, setHorizon] = useState(90);
  const [levers, setLevers] = useState<Record<string, number>>({});

  const products = useQuery({
    queryKey: ['products', 'for-scenario'],
    queryFn: () => api<Paginated<ProductRow>>('/products?limit=100'),
  });

  const simulate = useMutation({
    mutationFn: () =>
      api<ScenarioResponse>('/ai/scenario/simulate', {
        method: 'POST',
        body: { productId, horizonDays: horizon, levers, iterations: 2000 },
      }),
  });

  const data = simulate.data;
  const base = data?.cases.find((entry) => entry.name === 'BASE_CASE');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">What-if simulation</h1>
        <p className="mt-0.5 max-w-3xl text-[0.8125rem] leading-relaxed text-[var(--color-ink-dim)]">
          Monte Carlo over a replenishment cycle. The reorder policy is sized once from the
          baseline and held fixed while conditions vary — re-optimising each case would let the
          worst case quietly adopt a better policy than the base and come out looking safer, which
          is the opposite of the question being asked.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[340px_1fr]">
        <Panel title="Levers">
          <div className="space-y-3.5 p-3.5">
            <label className="block">
              <Legend>Product</Legend>
              <select className="field" value={productId} onChange={(e) => setProductId(e.target.value)}>
                <option value="">select…</option>
                {products.data?.data.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.sku} — {product.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <Legend>Horizon · {horizon} days</Legend>
              <input
                type="range"
                min={30}
                max={365}
                step={30}
                value={horizon}
                onChange={(e) => setHorizon(Number(e.target.value))}
                className="w-full accent-[var(--color-signal)]"
              />
            </label>

            <div className="space-y-2.5 border-t border-[var(--color-hairline)] pt-3">
              {LEVERS.map((lever) => {
                const value = levers[lever.key] ?? 0;
                const isPercent = lever.key.endsWith('Percent');
                return (
                  <label key={lever.key} className="block">
                    <span className="flex items-baseline justify-between">
                      <Legend>{lever.label}</Legend>
                      <span
                        className="tnum font-mono text-[0.6875rem]"
                        style={{
                          color:
                            value === 0
                              ? 'var(--color-ink-faint)'
                              : value > 0
                                ? 'var(--color-warn)'
                                : 'var(--color-ok)',
                        }}
                      >
                        {value > 0 ? '+' : ''}
                        {isPercent ? `${Math.round(value * 100)}%` : value}
                      </span>
                    </span>
                    <input
                      type="range"
                      min={lever.min}
                      max={lever.max}
                      step={lever.step}
                      value={value}
                      onChange={(e) =>
                        setLevers((current) => ({ ...current, [lever.key]: Number(e.target.value) }))
                      }
                      className="w-full accent-[var(--color-signal)]"
                    />
                  </label>
                );
              })}
            </div>

            <div className="flex gap-2 border-t border-[var(--color-hairline)] pt-3">
              <button
                className="btn btn-primary flex-1"
                disabled={!productId || simulate.isPending}
                onClick={() => simulate.mutate()}
              >
                {simulate.isPending ? 'simulating…' : 'run 2 000 iterations'}
              </button>
              <button className="btn" onClick={() => setLevers({})}>
                reset
              </button>
            </div>
          </div>
        </Panel>

        <div className="space-y-4">
          {simulate.isError && <ErrorNote error={simulate.error} />}
          {simulate.isPending && (
            <Panel loading>
              <Loading label="Monte Carlo" />
            </Panel>
          )}

          {data ? (
            <>
              <div className="grid gap-4 md:grid-cols-3">
                {data.cases.map((entry) => {
                  const tone =
                    entry.name === 'WORST_CASE' ? 'alert' : entry.name === 'BEST_CASE' ? 'ok' : 'signal';
                  const delta =
                    base && base.totalCost > 0 && entry.name !== 'BASE_CASE'
                      ? (entry.totalCost - base.totalCost) / base.totalCost
                      : null;

                  return (
                    <Panel key={entry.name} title={entry.name.replace('_', ' ')}>
                      <div className="space-y-3 p-3.5">
                        <div>
                          <div
                            className="tnum font-mono text-xl"
                            style={{
                              color:
                                tone === 'alert'
                                  ? 'var(--color-alert)'
                                  : tone === 'ok'
                                    ? 'var(--color-ok)'
                                    : 'var(--color-signal)',
                            }}
                          >
                            {fmt.int(entry.totalCost)}
                          </div>
                          <div className="tnum font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
                            90% between {fmt.int(entry.totalCostP05)} and {fmt.int(entry.totalCostP95)}
                          </div>
                          {delta !== null && (
                            <div
                              className="tnum mt-0.5 font-mono text-[0.6875rem]"
                              style={{
                                color: delta > 0 ? 'var(--color-alert)' : 'var(--color-ok)',
                              }}
                            >
                              {delta > 0 ? '+' : ''}
                              {(delta * 100).toFixed(1)}% vs base
                            </div>
                          )}
                        </div>

                        <div className="space-y-2 border-t border-[var(--color-hairline)] pt-2.5">
                          <MetricLine
                            label="Stockout risk"
                            value={fmt.pct(entry.stockoutRisk, 1)}
                            meter={entry.stockoutRisk}
                            tone={entry.stockoutRisk > 0.25 ? 'alert' : entry.stockoutRisk > 0.1 ? 'warn' : 'ok'}
                          />
                          <MetricLine
                            label="Fill rate"
                            value={fmt.pct(entry.fillRate, 1)}
                            meter={entry.fillRate}
                            tone={entry.fillRate > 0.95 ? 'ok' : 'warn'}
                          />
                          <MetricLine label="Avg inventory" value={fmt.int(entry.averageInventoryUnits)} />
                          <MetricLine label="Orders placed" value={fmt.num(entry.ordersPlaced, 1)} />
                        </div>
                      </div>
                    </Panel>
                  );
                })}
              </div>

              <Panel title="Reading" meta={<Chip tone="neutral">{fmt.int(data.iterations)} runs</Chip>}>
                <div className="p-3.5">
                  <Explain
                    summary={data.explanation.summary}
                    reasons={data.explanation.reasons}
                    assumptions={data.explanation.assumptions}
                  />
                </div>
              </Panel>
            </>
          ) : (
            !simulate.isPending && (
              <Panel>
                <Empty
                  title="No simulation yet"
                  hint="Pick a product, move a lever, and run. Products need outbound movement in the last 90 days for the baseline to mean anything."
                />
              </Panel>
            )
          )}
        </div>
      </div>
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

function MetricLine({
  label,
  value,
  meter,
  tone,
}: {
  label: string;
  value: string;
  meter?: number;
  tone?: 'ok' | 'warn' | 'alert';
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
          {label}
        </span>
        <span className="tnum font-mono text-[0.75rem]">{value}</span>
      </div>
      {meter !== undefined && (
        <div className="mt-1">
          <Meter value={meter} tone={tone} />
        </div>
      )}
    </div>
  );
}
