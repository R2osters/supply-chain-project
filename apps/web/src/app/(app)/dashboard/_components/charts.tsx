'use client';

import { Activity, Factory, Timer } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { UseQueryResult } from '@tanstack/react-query';
import { Empty, ErrorNote, Legend, Loading, MetricRow, Panel, SeverityIcon } from '@/components/ui';
import { useFormat, useI18n } from '@/lib/i18n';
import { usePalette } from '@/lib/theme';

export interface DeliveryPerformance {
  windowDays: number;
  deliveries: number;
  onTimeRate: number | null;
  averageDelayHours: number | null;
  p90DelayHours: number | null;
  etaAccuracyMinutes: number | null;
  note: string;
}

export interface DayRow {
  day: string;
  created: number;
  delivered: number;
  delayed: number;
  on_time: number;
}

export interface SupplierRow {
  id: string;
  name: string;
  country: string;
  reliabilityScore: number;
  onTimeDeliveryRate: number;
  observedLeadTimeDays: number;
  observedLeadTimeStdDays: number;
  orders: number;
  measured: boolean;
}

/** Reliability under this reads as an exception; above it the bar stays grey (charte §03). */
const RELIABILITY_FLOOR = 80;

/** Charte tooltip: a raised surface-2 card, mono label, series swatch + value. */
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="flex min-w-[140px] flex-col gap-1 rounded-[var(--radius-md)] bg-[var(--color-surface-2)] px-3 py-2 shadow-[var(--shadow-md)]">
      <span className="t-label">{label}</span>
      {payload.map((entry: any) => (
        <span key={entry.dataKey} className="flex items-center gap-2 text-[12px]">
          <span className="h-2 w-2 rounded-full" style={{ background: entry.color ?? entry.payload?.fill }} />
          <span className="text-[var(--color-muted)]">{entry.name}</span>
          <span className="t-data ml-auto text-[var(--color-ink)]">{entry.value}</span>
        </span>
      ))}
    </div>
  );
}

function useAxis() {
  const palette = usePalette();
  return {
    stroke: palette.line,
    tickLine: false,
    tick: { fill: palette.dim, fontSize: 11, fontFamily: 'var(--font-mono)' },
  };
}

export function ShipmentFlowChart({ query }: { query: UseQueryResult<DayRow[]> }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const palette = usePalette();
  const axis = useAxis();

  const created = t('dash.created');
  const delivered = t('dash.delivered');
  const late = t('dash.late');

  const data = (query.data ?? []).map((row) => ({
    day: fmt.date(row.day).replace(/\s\d{2}$/, ''),
    [created]: Number(row.created),
    [delivered]: Number(row.delivered),
    [late]: Number(row.delayed),
  }));

  return (
    <Panel
      icon={Activity}
      title={t('dash.shipmentFlow')}
      loading={query.isFetching && !query.data}
      actions={
        <Legend
          items={[
            { label: created, colour: 'var(--color-muted)', shape: 'dash' },
            { label: delivered, colour: 'var(--color-ink)', shape: 'line' },
            { label: late, colour: 'var(--color-crit)', shape: 'line' },
          ]}
        />
      }
    >
      <div className="h-[240px] px-3 pb-4 pt-2">
        {query.isError ? (
          <ErrorNote error={query.error} onRetry={() => void query.refetch()} />
        ) : query.isLoading ? (
          <Loading rows={5} />
        ) : data.length === 0 ? (
          <Empty title={t('dash.v3.noFlow')} hint={t('dash.v3.noFlowHint')} />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="dash-delivered" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={palette.ink} stopOpacity={0.12} />
                  <stop offset="100%" stopColor={palette.ink} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={palette.line} strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="day" {...axis} interval="preserveStartEnd" minTickGap={28} />
              <YAxis {...axis} width={44} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: palette.line }} />
              <Area
                type="monotone"
                dataKey={created}
                stroke={palette.muted}
                strokeDasharray="4 3"
                strokeWidth={1.5}
                fill="none"
              />
              <Area
                type="monotone"
                dataKey={delivered}
                stroke={palette.ink}
                strokeWidth={1.75}
                fill="url(#dash-delivered)"
              />
              <Area type="monotone" dataKey={late} stroke={palette.crit} strokeWidth={1.75} fill="none" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </Panel>
  );
}

export function DeliveryPerformancePanel({ query }: { query: UseQueryResult<DeliveryPerformance> }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const perf = query.data;
  const onTime = perf?.onTimeRate ?? null;
  // Grey while on target; warn and crit only for the exception, with the icon carrying severity.
  const tone = onTime === null ? 'neutral' : onTime > 0.9 ? 'signal' : onTime > 0.75 ? 'warn' : 'alert';

  return (
    <Panel icon={Timer} title={t('dash.deliveryPerformance')} loading={query.isFetching && !perf}>
      {query.isError ? (
        <ErrorNote error={query.error} onRetry={() => void query.refetch()} />
      ) : !perf ? (
        <Loading rows={4} />
      ) : (
        <div className="flex flex-col gap-4 px-5 pb-5 pt-3">
          <MetricRow
            label={
              <span className="flex items-center gap-1.5">
                {t('dash.onTime')}
                {(tone === 'warn' || tone === 'alert') && (
                  <SeverityIcon severity={tone === 'alert' ? 'critical' : 'warning'} size={14} />
                )}
              </span>
            }
            value={fmt.pct(onTime, 1)}
            meter={onTime ?? 0}
            tone={tone}
          />
          <MetricRow label={t('dash.meanDelay')} value={`${fmt.num(perf.averageDelayHours, 1)} h`} />
          <MetricRow label={t('dash.p90Delay')} value={`${fmt.num(perf.p90DelayHours, 1)} h`} />
          <MetricRow
            label={t('dash.etaError')}
            value={perf.etaAccuracyMinutes === null ? '—' : `${fmt.num(perf.etaAccuracyMinutes, 0)} min`}
          />
          <p className="m-0 border-t border-[var(--color-line)] pt-3 text-[12px] leading-relaxed text-[var(--color-dim)]">
            {perf.note}
          </p>
        </div>
      )}
    </Panel>
  );
}

export function SupplierReliabilityPanel({ query }: { query: UseQueryResult<SupplierRow[]> }) {
  const { t } = useI18n();
  const palette = usePalette();
  const axis = useAxis();
  const rows = query.data ?? [];
  const reliability = t('dash.v3.reliability');

  return (
    <Panel
      icon={Factory}
      title={t('dash.supplierReliability')}
      loading={query.isFetching && !query.data}
      actions={
        <Legend
          items={[
            { label: t('dash.v3.legend.nominal'), colour: 'var(--color-muted)' },
            { label: t('dash.v3.belowFloor', { n: RELIABILITY_FLOOR }), colour: 'var(--color-crit)' },
          ]}
        />
      }
    >
      <div className="h-[236px] px-3 pb-4 pt-2">
        {query.isError ? (
          <ErrorNote error={query.error} onRetry={() => void query.refetch()} />
        ) : query.isLoading ? (
          <Loading rows={5} />
        ) : rows.length === 0 ? (
          <Empty title={t('dash.v3.noSuppliers')} hint={t('dash.v3.noSuppliersHint')} />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={rows.map((supplier) => ({
                name: supplier.name.split(' ')[0],
                [reliability]: Math.round(supplier.reliabilityScore),
              }))}
              margin={{ top: 6, right: 8, left: -22, bottom: 0 }}
            >
              <CartesianGrid stroke={palette.line} strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="name" {...axis} />
              <YAxis {...axis} width={44} domain={[0, 100]} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: palette.line, fillOpacity: 0.35 }} />
              <Bar dataKey={reliability} radius={[4, 4, 0, 0]} maxBarSize={28}>
                {rows.map((supplier) => (
                  <Cell
                    key={supplier.id}
                    fill={supplier.reliabilityScore < RELIABILITY_FLOOR ? palette.crit : palette.muted}
                    // Unmeasured suppliers (no delivered orders yet) are drawn faint: a prior, not a fact.
                    fillOpacity={supplier.measured ? 1 : 0.4}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </Panel>
  );
}
