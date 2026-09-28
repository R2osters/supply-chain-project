'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Area,
  ComposedChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, type Explanation, type Paginated } from '@/lib/api';
import { Chip, Empty, ErrorNote, Explain, Loading, Panel, fmt } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

interface ProductRow {
  id: string;
  sku: string;
  name: string;
}

interface Evaluation {
  model: string;
  mae: number | null;
  rmse: number | null;
  mape: number | null;
  wape: number | null;
  folds: number;
  selected: boolean;
  skippedReason?: string;
}

interface ForecastResponse {
  sku: string;
  horizonDays: number;
  forecast: Array<{ date: string; demand: number; lowerBound: number; upperBound: number }>;
  selectedModel: string;
  evaluations: Evaluation[];
  residualStd: number | null;
  dataQuality: {
    rowsIn: number;
    rowsUsed: number;
    passed: boolean;
    issues: Array<{ code: string; severity: string; message: string; affectedRows: number }>;
  };
  explanation: Explanation;
}

const HORIZONS = [7, 30, 90, 180] as const;

export default function ForecastingPage() {
  const { t } = useI18n();
  const [productId, setProductId] = useState('');
  const [horizon, setHorizon] = useState<number>(30);

  const products = useQuery({
    queryKey: ['products', 'for-forecast'],
    queryFn: () => api<Paginated<ProductRow>>('/products?limit=100'),
  });

  const forecast = useMutation({
    mutationFn: (input: { productId: string; horizon: number }) =>
      api<ForecastResponse>(`/ai/forecast/${input.productId}?horizonDays=${input.horizon}`, {
        method: 'POST',
      }),
  });

  const data = forecast.data;

  const chartData =
    data?.forecast.map((point) => ({
      date: new Date(point.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
      demand: point.demand,
      // Recharts stacks an area from a base, so the band is [lower, span] rather than two lines.
      lower: point.lowerBound,
      span: Math.max(0, point.upperBound - point.lowerBound),
    })) ?? [];

  const scored = (data?.evaluations ?? [])
    .filter((evaluation) => !evaluation.skippedReason)
    .sort((a, b) => (a.wape ?? Infinity) - (b.wape ?? Infinity));
  const skipped = (data?.evaluations ?? []).filter((evaluation) => evaluation.skippedReason);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">{t('fc.title')}</h1>
        <p className="mt-0.5 max-w-3xl text-[0.8125rem] leading-relaxed text-[var(--color-ink-dim)]">
          {t('fc.intro')}
        </p>
      </div>

      <Panel title={t('fc.run')}>
        <div className="flex flex-wrap items-end gap-3 p-3.5">
          <label className="min-w-[240px] flex-1">
            <span className="mb-1 block font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
              {t('fc.product')}
            </span>
            <select
              className="field"
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
            >
              <option value="">{t('fc.selectProduct')}</option>
              {products.data?.data.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.sku} — {product.name}
                </option>
              ))}
            </select>
          </label>

          <div>
            <span className="mb-1 block font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
              {t('fc.horizon')}
            </span>
            <div className="flex gap-1">
              {HORIZONS.map((option) => (
                <button
                  key={option}
                  onClick={() => setHorizon(option)}
                  className={`btn !px-3 ${horizon === option ? '!border-[var(--color-signal)] !text-[var(--color-signal)]' : ''}`}
                >
                  {option}d
                </button>
              ))}
            </div>
          </div>

          <button
            className="btn btn-primary"
            disabled={!productId || forecast.isPending}
            onClick={() => forecast.mutate({ productId, horizon })}
          >
            {forecast.isPending ? t('fc.comparing') : t('fc.forecast')}
          </button>
        </div>
      </Panel>

      {forecast.isError && <ErrorNote error={forecast.error} />}
      {forecast.isPending && (
        <Panel loading>
          <Loading label={t('fc.validating')} />
        </Panel>
      )}

      {data && (
        <>
          <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
            <Panel
              title={t('fc.chartTitle', { sku: data.sku, days: data.horizonDays })}
              meta={<Chip tone="signal">{data.selectedModel.replace(/_/g, ' ')}</Chip>}
            >
              <div className="h-[300px] p-2.5">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                    <CartesianGrid stroke="var(--color-hairline)" strokeDasharray="2 4" vertical={false} />
                    <XAxis
                      dataKey="date"
                      stroke="var(--color-hairline-bright)"
                      tick={{ fill: 'var(--color-ink-faint)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
                      interval="preserveStartEnd"
                      minTickGap={30}
                    />
                    <YAxis
                      stroke="var(--color-hairline-bright)"
                      tick={{ fill: 'var(--color-ink-faint)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
                      width={48}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--color-panel)',
                        border: '1px solid var(--color-hairline-bright)',
                        borderRadius: 2,
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                      }}
                      labelStyle={{ color: 'var(--color-ink-faint)' }}
                    />
                    {/* Invisible base + visible span renders the interval as a band. */}
                    <Area dataKey="lower" stackId="band" stroke="none" fill="transparent" />
                    <Area
                      dataKey="span"
                      stackId="band"
                      stroke="none"
                      fill="var(--color-signal)"
                      fillOpacity={0.13}
                      name={t('fc.interval')}
                    />
                    <Line
                      type="monotone"
                      dataKey="demand"
                      stroke="var(--color-signal)"
                      strokeWidth={1.8}
                      dot={false}
                      name={t('fc.series')}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div className="border-t border-[var(--color-hairline)] p-3.5">
                <Explain
                  summary={data.explanation.summary}
                  reasons={data.explanation.reasons}
                  assumptions={data.explanation.assumptions}
                />
              </div>
            </Panel>

            <div className="space-y-4">
              <Panel title={t('fc.comparison')}>
                <table className="grid-table">
                  <thead>
                    <tr>
                      <th>{t('fc.model')}</th>
                      <th className="text-right">WAPE</th>
                      <th className="text-right">MAE</th>
                      <th className="text-right">RMSE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scored.map((evaluation) => (
                      <tr
                        key={evaluation.model}
                        className={evaluation.selected ? 'bg-[color-mix(in_srgb,var(--color-signal)_7%,transparent)]' : ''}
                      >
                        <td className="text-[0.75rem]">
                          <span className="flex items-center gap-1.5">
                            {evaluation.selected && (
                              <span className="h-1.5 w-1.5 bg-[var(--color-signal)]" />
                            )}
                            {evaluation.model.replace(/_/g, ' ').toLowerCase()}
                          </span>
                        </td>
                        <td className="tnum text-right font-mono text-[0.75rem]">
                          {fmt.num(evaluation.wape, 2)}
                        </td>
                        <td className="tnum text-right font-mono text-[0.6875rem] text-[var(--color-ink-faint)]">
                          {fmt.num(evaluation.mae, 1)}
                        </td>
                        <td className="tnum text-right font-mono text-[0.6875rem] text-[var(--color-ink-faint)]">
                          {fmt.num(evaluation.rmse, 1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {skipped.length > 0 && (
                  <div className="border-t border-[var(--color-hairline)] p-3 text-[0.6875rem] leading-relaxed text-[var(--color-ink-faint)]">
                    {t('fc.notEvaluated', {
                      list: skipped
                        .map(
                          (evaluation) =>
                            `${evaluation.model.toLowerCase()} (${evaluation.skippedReason})`,
                        )
                        .join('; '),
                    })}
                  </div>
                )}
              </Panel>

              <Panel
                title={t('fc.dataQuality')}
                meta={
                  <Chip tone={data.dataQuality.passed ? 'ok' : 'alert'}>
                    {data.dataQuality.passed ? t('fc.passed') : t('fc.blocked')}
                  </Chip>
                }
              >
                <div className="p-3.5">
                  <div className="tnum font-mono text-[0.75rem] text-[var(--color-ink-dim)]">
                    {t('fc.rowsUsed', {
                      used: fmt.int(data.dataQuality.rowsUsed),
                      total: fmt.int(data.dataQuality.rowsIn),
                    })}
                    {data.residualStd !== null &&
                      ` · ${t('fc.residual', { value: fmt.num(data.residualStd, 1) })}`}
                  </div>
                  {data.dataQuality.issues.length > 0 ? (
                    <ul className="mt-2.5 space-y-1.5">
                      {data.dataQuality.issues.map((issue) => (
                        <li key={issue.code} className="flex gap-2">
                          <Chip
                            tone={
                              issue.severity === 'BLOCKING'
                                ? 'alert'
                                : issue.severity === 'WARNING'
                                  ? 'warn'
                                  : 'neutral'
                            }
                          >
                            {issue.severity}
                          </Chip>
                          <span className="text-[0.6875rem] leading-relaxed text-[var(--color-ink-dim)]">
                            {issue.message}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-[0.75rem] text-[var(--color-ink-faint)]">
                      {t('fc.noIssue')}
                    </p>
                  )}
                </div>
              </Panel>
            </div>
          </div>
        </>
      )}

      {!data && !forecast.isPending && (
        <Panel>
          <Empty
            title={t('fc.none')}
            hint={t('fc.noneHint')}
          />
        </Panel>
      )}
    </div>
  );
}
