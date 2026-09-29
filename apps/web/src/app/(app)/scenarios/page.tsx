'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { BookOpen, FlaskConical, Play, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { api, type Explanation, type Paginated } from '@/lib/api';
import {
  Button,
  Empty,
  ErrorNote,
  Explain,
  MetricRow,
  PageHeader,
  Panel,
  SeverityIcon,
  type Tone,
} from '@/components/ui';
import { SubTabs } from '@/components/shell/sub-tabs';
import { useAuth } from '@/lib/auth';
import { useFormat, useI18n, type TranslationKey } from '@/lib/i18n';
import {
  FieldLabel,
  OPTIMISE_TABS,
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

const ITERATIONS = 2000;

/** Stockout risk above which the worst case is an exception worth colouring. */
const HIGH_RISK = 0.25;

const LEVERS = [
  { key: 'demandChangePercent', step: 0.05, min: -0.5, max: 1 },
  { key: 'leadTimeChangePercent', step: 0.05, min: -0.5, max: 1 },
  { key: 'supplierDelayDays', step: 1, min: 0, max: 30 },
  { key: 'fuelPriceChangePercent', step: 0.05, min: -0.5, max: 1 },
  { key: 'transportCostChangePercent', step: 0.05, min: -0.5, max: 1 },
  { key: 'stockLevelChangePercent', step: 0.05, min: -0.9, max: 1 },
  { key: 'unitPriceChangePercent', step: 0.05, min: -0.5, max: 1 },
] as const;

/** Best, base, worst — reading left to right from the good news to the bad. */
const CASE_ORDER = ['BEST_CASE', 'BASE_CASE', 'WORST_CASE'];

export default function ScenariosPage() {
  const { t } = useI18n();
  const format = useFormat();
  const { can } = useAuth();
  const [productId, setProductId] = useState('');
  const [horizon, setHorizon] = useState(90);
  const [levers, setLevers] = useState<Record<string, number>>({});
  const [why, setWhy] = useState(true);

  const products = useQuery({
    queryKey: ['products', 'for-scenario'],
    queryFn: () => api<Paginated<ProductRow>>('/products?limit=100'),
  });

  const simulate = useMutation({
    mutationFn: () =>
      timed(() =>
        api<ScenarioResponse>('/ai/scenario/simulate', {
          method: 'POST',
          body: { productId, horizonDays: horizon, levers, iterations: ITERATIONS },
        }),
      ),
  });

  const data = simulate.data;
  const base = data?.cases.find((entry) => entry.name === 'BASE_CASE');
  const worst = data?.cases.find((entry) => entry.name === 'WORST_CASE');
  const cases = data
    ? [...data.cases].sort((a, b) => CASE_ORDER.indexOf(a.name) - CASE_ORDER.indexOf(b.name))
    : [];
  // A shared scale for the P05–P95 bars so the three ranges can be compared by eye.
  const scaleMin = cases.length ? Math.min(...cases.map((entry) => entry.totalCostP05)) : 0;
  const scaleMax = cases.length ? Math.max(...cases.map((entry) => entry.totalCostP95)) : 1;
  const changed = Object.values(levers).filter((value) => value !== 0).length;

  const title = simulate.isPending
    ? t('v3.scenarios.titleRunning')
    : worst
      ? t('v3.scenarios.titleResult', { risk: format.pct(worst.stockoutRisk, 0) })
      : t('v3.scenarios.titleIdle');

  return (
    <div className="flex flex-col gap-6">
      <SubTabs tabs={OPTIMISE_TABS} />

      <PageHeader
        kicker={`${t('nav.pillar.optimise')} · ${t('alloc.v3.kicker')}`}
        title={title}
        description={t('v3.scenarios.intro')}
      />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
        {/* --------------------------------------------------------- levers */}
        <Panel
          icon={SlidersHorizontal}
          title={t('v3.scenarios.levers')}
          meta={
            changed > 0 ? (
              <span className="t-data text-[11px] font-normal text-[var(--color-muted)]">
                {t('v3.scenarios.changed', { n: changed })}
              </span>
            ) : undefined
          }
        >
          <div className="flex flex-col gap-4 px-5 pb-5 pt-3">
            <div>
              <FieldLabel htmlFor="scen-product">{t('alloc.product')}</FieldLabel>
              <select
                id="scen-product"
                className="field"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
              >
                <option value="">{t('alloc.select')}</option>
                {products.data?.data.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.sku} — {product.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <FieldLabel htmlFor="scen-horizon">
                <span>{t('fc.horizon')}</span>
                <span className="t-data normal-case tracking-normal text-[var(--color-ink)]">
                  {t('fc.v3.days', { n: horizon })}
                </span>
              </FieldLabel>
              <input
                id="scen-horizon"
                type="range"
                min={30}
                max={365}
                step={30}
                value={horizon}
                onChange={(e) => setHorizon(Number(e.target.value))}
                className="w-full accent-[var(--color-ink)]"
              />
            </div>

            <div className="flex flex-col gap-3 border-t border-[var(--color-line)] pt-4">
              {LEVERS.map((lever) => {
                const value = levers[lever.key] ?? 0;
                const isPercent = lever.key.endsWith('Percent');
                const inputId = `lever-${lever.key}`;
                const shown = isPercent
                  ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(Math.round(value * 100))} %`
                  : `${value > 0 ? '+' : ''}${value} ${t('v3.scenarios.unitDays')}`;
                return (
                  <div key={lever.key}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <label htmlFor={inputId} className="t-label">
                        {t(`v3.scenarios.lever.${lever.key}` as TranslationKey)}
                      </label>
                      <span className="flex items-center gap-1">
                        <span
                          className="t-data text-[12px]"
                          style={{ color: value === 0 ? 'var(--color-dim)' : 'var(--color-ink)' }}
                        >
                          {shown}
                        </span>
                        {value !== 0 && (
                          <button
                            type="button"
                            className="pop flex h-6 w-6 items-center justify-center rounded-[var(--radius-xs)] text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
                            aria-label={t('v3.scenarios.resetOne')}
                            title={t('v3.scenarios.resetOne')}
                            onClick={() => setLevers((current) => ({ ...current, [lever.key]: 0 }))}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </span>
                    </div>
                    <input
                      id={inputId}
                      type="range"
                      min={lever.min}
                      max={lever.max}
                      step={lever.step}
                      value={value}
                      onChange={(e) =>
                        setLevers((current) => ({ ...current, [lever.key]: Number(e.target.value) }))
                      }
                      className="w-full accent-[var(--color-ink)]"
                    />
                  </div>
                );
              })}
            </div>

            <div className="flex flex-wrap gap-2 border-t border-[var(--color-line)] pt-4">
              <Button
                variant="primary"
                icon={Play}
                className="flex-1"
                disabled={!productId || !can('scenario:create')}
                loading={simulate.isPending}
                onClick={() => simulate.mutate()}
              >
                {simulate.isPending
                  ? t('v3.scenarios.running')
                  : data
                    ? t('v3.scenarios.rerun')
                    : t('v3.scenarios.run')}
              </Button>
              <Button icon={RotateCcw} disabled={changed === 0} onClick={() => setLevers({})}>
                {t('v3.scenarios.reset')}
              </Button>
            </div>
            {products.isError && <ErrorNote error={products.error} onRetry={() => void products.refetch()} />}
          </div>
        </Panel>

        {/* --------------------------------------------------------- result */}
        <div className="flex min-w-0 flex-col gap-4" aria-live="polite">
          {simulate.isError && <ErrorNote error={simulate.error} onRetry={() => simulate.mutate()} />}

          {simulate.isPending && (
            <div className="grid gap-4 md:grid-cols-3">
              {CASE_ORDER.map((name) => (
                <Panel key={name} loading title={t(`v3.scenarios.case.${name}` as TranslationKey)}>
                  <ResultSkeleton rows={4} />
                </Panel>
              ))}
            </div>
          )}

          {data && !simulate.isPending && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* Neutral, not violet: a Monte-Carlo run is a computation on real history, not demo data. */}
                <span className="t-data text-[11px] text-[var(--color-muted)]">
                  {t('v3.scenarios.monteCarlo', { n: format.int(data.iterations) })}
                </span>
                <Timing ms={data.elapsedMs} kind="roundtrip" />
              </div>

              <div className="stagger grid gap-4 md:grid-cols-3">
                {cases.map((entry) => {
                  const isWorst = entry.name === 'WORST_CASE';
                  const exception = isWorst && entry.stockoutRisk > HIGH_RISK;
                  const delta =
                    base && base.totalCost > 0 && entry.name !== 'BASE_CASE'
                      ? (entry.totalCost - base.totalCost) / base.totalCost
                      : null;
                  const riskTone: Tone = exception ? 'alert' : entry.stockoutRisk > 0.1 ? 'warn' : 'signal';
                  const fillTone: Tone = entry.fillRate < 0.95 ? 'warn' : 'signal';

                  return (
                    <section
                      key={entry.name}
                      className="panel rise flex flex-col gap-4 p-5"
                      style={exception ? { boxShadow: 'inset 0 0 0 1px var(--color-crit)' } : undefined}
                    >
                      <header className="flex items-center justify-between gap-2">
                        <span className="t-h4">{t(`v3.scenarios.case.${entry.name}` as TranslationKey)}</span>
                        {exception && <SeverityIcon severity="critical" size={16} />}
                      </header>

                      <div className="flex flex-col gap-1">
                        <span className="text-[12.5px] text-[var(--color-muted)]">{t('v3.scenarios.totalCost')}</span>
                        <span className="t-kpi text-[26px] text-[var(--color-ink)]">{format.int(entry.totalCost)}</span>
                        {delta !== null && (
                          <span
                            className="t-data text-[11px]"
                            style={{ color: exception && delta > 0 ? 'var(--color-crit)' : 'var(--color-muted)' }}
                          >
                            {t('v3.scenarios.vsBase', {
                              value: `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${format.num(Math.abs(delta) * 100, 1)} %`,
                            })}
                          </span>
                        )}
                      </div>

                      <RangeBar
                        low={entry.totalCostP05}
                        high={entry.totalCostP95}
                        mean={entry.totalCost}
                        min={scaleMin}
                        max={scaleMax}
                        exception={exception}
                        label={t('v3.scenarios.range', {
                          low: format.int(entry.totalCostP05),
                          high: format.int(entry.totalCostP95),
                        })}
                      />

                      <div className="flex flex-col gap-3 border-t border-[var(--color-line)] pt-3">
                        <MetricRow
                          label={t('v3.scenarios.stockoutRisk')}
                          value={format.pct(entry.stockoutRisk, 1)}
                          meter={entry.stockoutRisk}
                          tone={riskTone}
                        />
                        <MetricRow
                          label={t('v3.scenarios.fillRate')}
                          value={format.pct(entry.fillRate, 1)}
                          meter={entry.fillRate}
                          tone={fillTone}
                        />
                        <MetricRow label={t('v3.scenarios.serviceLevel')} value={format.pct(entry.serviceLevel, 1)} />
                        <MetricRow label={t('v3.scenarios.avgInventory')} value={format.int(entry.averageInventoryUnits)} />
                        <MetricRow label={t('v3.scenarios.ordersPlaced')} value={format.num(entry.ordersPlaced, 1)} />
                        <MetricRow
                          label={t('v3.scenarios.expectedDelay')}
                          value={t('fc.v3.days', { n: format.num(entry.expectedDelayDays, 1) })}
                        />
                      </div>
                    </section>
                  );
                })}
              </div>

              <Panel icon={BookOpen} title={t('v3.scenarios.reading')}>
                <div className="px-5 pb-5 pt-3">
                  <WhyToggle open={why} onToggle={() => setWhy((open) => !open)} label={t('v3.scenarios.why')}>
                    <Explain
                      summary={data.explanation.summary}
                      reasons={data.explanation.reasons}
                      assumptions={data.explanation.assumptions}
                    />
                  </WhyToggle>
                </div>
              </Panel>
            </>
          )}

          {!data && !simulate.isPending && (
            <Panel>
              <Empty icon={FlaskConical} title={t('v3.scenarios.none')} hint={t('v3.scenarios.noneHint')} />
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * P05–P95 of total cost on a scale shared by the three cases, with a tick at the mean. Grey unless
 * the case is the exception.
 */
function RangeBar({
  low,
  high,
  mean,
  min,
  max,
  exception,
  label,
}: {
  low: number;
  high: number;
  mean: number;
  min: number;
  max: number;
  exception: boolean;
  label: string;
}) {
  const span = Math.max(1e-9, max - min);
  const left = ((low - min) / span) * 100;
  const width = Math.max(1.5, ((high - low) / span) * 100);
  const tick = ((mean - min) / span) * 100;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative h-2 w-full rounded-full bg-[var(--color-line)]" aria-hidden="true">
        <div
          className="absolute top-0 h-full origin-left rounded-full [animation:grow-x_.7s_var(--ease-out)_both]"
          style={{
            left: `${left}%`,
            width: `${width}%`,
            background: exception ? 'var(--color-crit)' : 'var(--color-muted)',
            opacity: 0.55,
          }}
        />
        <div
          className="absolute -top-1 h-4 w-0.5 rounded-full bg-[var(--color-ink)]"
          style={{ left: `calc(${tick}% - 1px)` }}
        />
      </div>
      <span className="t-data text-[11px] text-[var(--color-muted)]">{label}</span>
    </div>
  );
}
