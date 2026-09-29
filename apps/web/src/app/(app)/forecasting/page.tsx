'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Database, Play, Table2, TrendingUp } from 'lucide-react';
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
import {
  Button,
  Chip,
  Empty,
  ErrorNote,
  Explain,
  Legend,
  PageHeader,
  Panel,
  SeverityIcon,
  type Severity,
} from '@/components/ui';
import { useFormat, useI18n } from '@/lib/i18n';
import {
  FieldLabel,
  ResultSkeleton,
  Timing,
  WhyToggle,
  timed,
} from '../allocation/_components/optimise-kit';

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

/** Axis text per charte: 11px mono, dim. */
const AXIS_TICK = { fill: 'var(--color-dim)', fontSize: 11, fontFamily: 'var(--font-mono)' };

function issueSeverity(severity: string): Severity {
  if (severity === 'BLOCKING') return 'critical';
  if (severity === 'WARNING') return 'warning';
  return 'info';
}

export default function ForecastingPage() {
  const { t, intlLocale } = useI18n();
  const format = useFormat();
  const [productId, setProductId] = useState('');
  const [horizon, setHorizon] = useState<number>(30);
  const [why, setWhy] = useState(true);

  const products = useQuery({
    queryKey: ['products', 'for-forecast'],
    queryFn: () => api<Paginated<ProductRow>>('/products?limit=100'),
  });

  const forecast = useMutation({
    mutationFn: (input: { productId: string; horizon: number }) =>
      timed(() =>
        api<ForecastResponse>(`/ai/forecast/${input.productId}?horizonDays=${input.horizon}`, {
          method: 'POST',
        }),
      ),
  });

  const data = forecast.data;

  const chartData =
    data?.forecast.map((point) => ({
      date: new Date(point.date).toLocaleDateString(intlLocale, { day: '2-digit', month: 'short' }),
      demand: point.demand,
      lowerBound: point.lowerBound,
      upperBound: point.upperBound,
      // Recharts stacks an area from a base, so the band is [lower, span] rather than two lines.
      lower: point.lowerBound,
      span: Math.max(0, point.upperBound - point.lowerBound),
    })) ?? [];

  const scored = (data?.evaluations ?? [])
    .filter((evaluation) => !evaluation.skippedReason)
    .sort((a, b) => (a.wape ?? Infinity) - (b.wape ?? Infinity));
  const skipped = (data?.evaluations ?? []).filter((evaluation) => evaluation.skippedReason);

  const total = data?.forecast.reduce((sum, point) => sum + point.demand, 0) ?? 0;
  const product = products.data?.data.find((row) => row.id === productId);
  const blocking = data?.dataQuality.issues.filter((issue) => issue.severity === 'BLOCKING').length ?? 0;

  const title = forecast.isPending
    ? t('fc.v3.titleRunning')
    : data
      ? t('fc.v3.titleResult', { sku: data.sku, total: format.int(total), days: data.horizonDays })
      : t('fc.v3.titleIdle');

  const run = () => forecast.mutate({ productId, horizon });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={`${t('nav.pillar.optimise')} · ${t('nav.forecasting')}`}
        title={title}
        description={t('fc.intro')}
      />

      {/* ------------------------------------------------------------ form */}
      <Panel icon={TrendingUp} title={t('fc.run')}>
        <div className="flex flex-wrap items-end gap-4 px-5 pb-5 pt-3">
          <div className="min-w-[240px] flex-1">
            <FieldLabel htmlFor="fc-product">{t('fc.product')}</FieldLabel>
            <select
              id="fc-product"
              className="field"
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
            >
              <option value="">{t('fc.selectProduct')}</option>
              {products.data?.data.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.sku} — {row.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className="t-label mb-1.5 block">{t('fc.horizon')}</span>
            <div className="segmented" role="group" aria-label={t('fc.horizon')}>
              {HORIZONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={horizon === option}
                  onClick={() => setHorizon(option)}
                >
                  {t('fc.v3.days', { n: option })}
                </button>
              ))}
            </div>
          </div>

          <Button
            variant="primary"
            icon={Play}
            disabled={!productId}
            loading={forecast.isPending}
            onClick={run}
          >
            {forecast.isPending ? t('fc.comparing') : t('fc.forecast')}
          </Button>
        </div>
        {products.isError && <ErrorNote error={products.error} onRetry={() => void products.refetch()} />}
      </Panel>

      {forecast.isError && <ErrorNote error={forecast.error} onRetry={productId ? run : undefined} />}

      {forecast.isPending && (
        <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
          <Panel loading title={t('fc.validating')}>
            <ResultSkeleton chart rows={3} />
          </Panel>
          <Panel loading title={t('fc.comparison')}>
            <ResultSkeleton rows={6} />
          </Panel>
        </div>
      )}

      {data && !forecast.isPending && (
        <div className="stagger grid gap-4 xl:grid-cols-[1.6fr_1fr]">
          <Panel
            icon={TrendingUp}
            title={t('fc.chartTitle', { sku: data.sku, days: data.horizonDays })}
            meta={
              <Chip tone="neutral" title={t('fc.v3.selectedModel')}>
                {data.selectedModel.replace(/_/g, ' ').toLowerCase()}
              </Chip>
            }
            actions={<Timing ms={data.elapsedMs} kind="roundtrip" />}
          >
            <div className="flex flex-col gap-3 px-5 pb-5 pt-3">
              {product && (
                <span className="t-data text-[12px] text-[var(--color-muted)]">
                  {product.sku} · {product.name}
                </span>
              )}
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                    <CartesianGrid stroke="var(--color-line)" strokeDasharray="2 4" vertical={false} />
                    <XAxis
                      dataKey="date"
                      stroke="var(--color-line)"
                      tick={AXIS_TICK}
                      tickLine={false}
                      interval="preserveStartEnd"
                      minTickGap={30}
                    />
                    <YAxis stroke="var(--color-line)" tick={AXIS_TICK} tickLine={false} width={52} />
                    <Tooltip
                      content={<ForecastTooltip />}
                      cursor={{ stroke: 'var(--color-muted)', strokeDasharray: '2 3' }}
                    />
                    {/* Invisible base + visible span renders the interval as a band. */}
                    <Area dataKey="lower" stackId="band" stroke="none" fill="transparent" isAnimationActive={false} />
                    <Area
                      dataKey="span"
                      stackId="band"
                      stroke="none"
                      fill="var(--color-muted)"
                      fillOpacity={0.18}
                      name={t('fc.interval')}
                    />
                    <Line
                      type="monotone"
                      dataKey="demand"
                      stroke="var(--color-ink)"
                      strokeWidth={1.8}
                      dot={false}
                      name={t('fc.series')}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <Legend
                items={[
                  { label: t('fc.series'), colour: 'var(--color-ink)', shape: 'line' },
                  { label: t('fc.interval'), colour: 'color-mix(in srgb, var(--color-muted) 40%, transparent)' },
                ]}
              />
              <div className="border-t border-[var(--color-line)] pt-3">
                <WhyToggle open={why} onToggle={() => setWhy((open) => !open)} label={t('fc.v3.why')}>
                  <Explain
                    summary={data.explanation.summary}
                    reasons={data.explanation.reasons}
                    assumptions={data.explanation.assumptions}
                  />
                </WhyToggle>
              </div>
            </div>
          </Panel>

          <div className="flex flex-col gap-4">
            <Panel icon={Table2} title={t('fc.comparison')}>
              <div className="overflow-x-auto px-2 pb-2">
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
                      <tr key={evaluation.model} aria-selected={evaluation.selected}>
                        <td className="text-[13px]">
                          <span className="flex items-center gap-1.5">
                            {evaluation.model.replace(/_/g, ' ').toLowerCase()}
                            {evaluation.selected && (
                              <span className="t-label text-[var(--color-ink)]">{t('fc.v3.chosen')}</span>
                            )}
                          </span>
                        </td>
                        <td className="t-data text-right">{format.num(evaluation.wape, 2)}</td>
                        <td className="t-data text-right text-[var(--color-muted)]">
                          {format.num(evaluation.mae, 1)}
                        </td>
                        <td className="t-data text-right text-[var(--color-muted)]">
                          {format.num(evaluation.rmse, 1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {skipped.length > 0 && (
                <p className="m-0 border-t border-[var(--color-line)] px-5 py-3 text-[12px] leading-relaxed text-[var(--color-dim)]">
                  {t('fc.notEvaluated', {
                    list: skipped
                      .map((evaluation) => `${evaluation.model.toLowerCase()} (${evaluation.skippedReason})`)
                      .join('; '),
                  })}
                </p>
              )}
            </Panel>

            <Panel
              icon={Database}
              title={t('fc.dataQuality')}
              meta={
                <span className="flex items-center gap-1.5 text-[12.5px] font-normal text-[var(--color-muted)]">
                  <SeverityIcon severity={data.dataQuality.passed ? 'ok' : 'critical'} size={14} />
                  {data.dataQuality.passed ? t('fc.passed') : t('fc.blocked')}
                </span>
              }
            >
              <div className="flex flex-col gap-3 px-5 pb-5 pt-3">
                <span className="t-data text-[12px] text-[var(--color-muted)]">
                  {t('fc.rowsUsed', {
                    used: format.int(data.dataQuality.rowsUsed),
                    total: format.int(data.dataQuality.rowsIn),
                  })}
                  {data.residualStd !== null && ` · ${t('fc.residual', { value: format.num(data.residualStd, 1) })}`}
                </span>
                {data.dataQuality.issues.length > 0 ? (
                  <ul className="stagger m-0 flex list-none flex-col gap-2 p-0" aria-live="polite">
                    {data.dataQuality.issues.map((issue) => (
                      <li key={issue.code} className="flex items-start gap-2.5">
                        <span className="mt-0.5">
                          <SeverityIcon severity={issueSeverity(issue.severity)} size={14} />
                        </span>
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-[13px] leading-relaxed text-[var(--color-ink)]">{issue.message}</span>
                          <span className="t-data text-[11px] text-[var(--color-dim)]">
                            {issue.code} · {t('fc.v3.affectedRows', { n: format.int(issue.affectedRows) })}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="m-0 text-[13px] text-[var(--color-muted)]">{t('fc.noIssue')}</p>
                )}
                {blocking > 0 && (
                  <p className="m-0 text-[12px] text-[var(--color-muted)]">{t('fc.v3.blockedHint')}</p>
                )}
              </div>
            </Panel>
          </div>
        </div>
      )}

      {!data && !forecast.isPending && (
        <Panel>
          <Empty icon={TrendingUp} title={t('fc.none')} hint={t('fc.noneHint')} />
        </Panel>
      )}
    </div>
  );
}

/** Tooltip as a surface-2 card: date, forecast and its interval, figures in mono. */
function ForecastTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ payload: { demand: number; lowerBound: number; upperBound: number } }>;
  label?: string;
}) {
  const { t } = useI18n();
  const format = useFormat();
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-[var(--color-surface-2)] px-3 py-2 shadow-[var(--shadow-md)]">
      <span className="t-data text-[11px] text-[var(--color-dim)]">{label}</span>
      <span className="flex items-baseline justify-between gap-4 text-[12px] text-[var(--color-muted)]">
        {t('fc.series')}
        <b className="t-data text-[13px] text-[var(--color-ink)]">{format.int(point.demand)}</b>
      </span>
      <span className="flex items-baseline justify-between gap-4 text-[12px] text-[var(--color-muted)]">
        {t('fc.interval')}
        <span className="t-data text-[12px] text-[var(--color-muted)]">
          {format.int(point.lowerBound)} – {format.int(point.upperBound)}
        </span>
      </span>
    </div>
  );
}
