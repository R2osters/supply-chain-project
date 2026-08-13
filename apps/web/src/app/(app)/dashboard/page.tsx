'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
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
import { api, type Overview, type Paginated, type Recommendation } from '@/lib/api';
import {
  Chip,
  Empty,
  ErrorNote,
  Explain,
  Kpi,
  Loading,
  Meter,
  Panel,
  fmt,
  priorityTone,
  riskTone,
} from '@/components/ui';

interface DeliveryPerformance {
  windowDays: number;
  deliveries: number;
  onTimeRate: number | null;
  averageDelayHours: number | null;
  p90DelayHours: number | null;
  etaAccuracyMinutes: number | null;
  note: string;
}

interface DayRow {
  day: string;
  created: number;
  delivered: number;
  delayed: number;
  on_time: number;
}

interface SupplierRow {
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

const CHART_AXIS = {
  stroke: 'var(--color-hairline-bright)',
  tick: { fill: 'var(--color-ink-faint)', fontSize: 10, fontFamily: 'var(--font-mono)' },
};

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="panel px-2.5 py-2">
      <div className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
        {label}
      </div>
      {payload.map((entry: any) => (
        <div key={entry.dataKey} className="mt-1 flex items-center gap-2 text-[0.6875rem]">
          <span className="h-1.5 w-1.5" style={{ background: entry.color }} />
          <span className="text-[var(--color-ink-dim)]">{entry.name}</span>
          <span className="tnum ml-auto font-mono text-[var(--color-ink)]">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const overview = useQuery({
    queryKey: ['analytics', 'overview'],
    queryFn: () => api<Overview>('/analytics/overview'),
    refetchInterval: 20_000,
  });

  const perDay = useQuery({
    queryKey: ['analytics', 'shipments-per-day'],
    queryFn: () => api<DayRow[]>('/analytics/shipments-per-day?days=30'),
  });

  const performance = useQuery({
    queryKey: ['analytics', 'delivery-performance'],
    queryFn: () => api<DeliveryPerformance>('/analytics/delivery-performance?days=90'),
  });

  const suppliers = useQuery({
    queryKey: ['analytics', 'supplier-performance'],
    queryFn: () => api<SupplierRow[]>('/analytics/supplier-performance'),
  });

  const advice = useQuery({
    queryKey: ['recommendations', 'top'],
    queryFn: () => api<Paginated<Recommendation>>('/recommendations?limit=4'),
    refetchInterval: 60_000,
  });

  const data = overview.data;

  const chartData = (perDay.data ?? []).map((row) => ({
    day: new Date(row.day).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
    Created: Number(row.created),
    Delivered: Number(row.delivered),
    Late: Number(row.delayed),
  }));

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------- KPIs */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Kpi
          label="Active shipments"
          value={data ? fmt.int(data.shipments.active) : '—'}
          sub={
            data && data.shipments.delayed > 0 ? (
              <span className="text-[var(--color-warn)]">{data.shipments.delayed} running late</span>
            ) : (
              <span className="text-[var(--color-ok)]">none late</span>
            )
          }
          tone="info"
          delay={0}
        />
        <Kpi
          label="At risk"
          value={data ? fmt.int(data.shipments.atRisk) : '—'}
          sub={<span>delay probability ≥ 50%</span>}
          tone={data && data.shipments.atRisk > 0 ? 'warn' : 'ok'}
          delay={40}
        />
        <Kpi
          label="Delivered today"
          value={data ? fmt.int(data.shipments.deliveredToday) : '—'}
          sub={
            performance.data?.onTimeRate !== null && performance.data?.onTimeRate !== undefined ? (
              <span>{fmt.pct(performance.data.onTimeRate)} on time (90 d)</span>
            ) : (
              <span>no history yet</span>
            )
          }
          tone="ok"
          delay={80}
        />
        <Kpi
          label="Inventory value"
          value={data ? fmt.int(data.inventory.value) : '—'}
          unit="GHS"
          sub={<span>{data ? fmt.int(data.inventory.distinctSkus) : '—'} SKUs</span>}
          tone="signal"
          delay={120}
        />
        <Kpi
          label="Stock exceptions"
          value={data ? fmt.int(data.inventory.lowStockProducts + data.inventory.outOfStockProducts) : '—'}
          sub={
            data ? (
              <span>
                {data.inventory.outOfStockProducts} out · {data.inventory.lowStockProducts} low
              </span>
            ) : null
          }
          tone={data && data.inventory.outOfStockProducts > 0 ? 'alert' : 'warn'}
          delay={160}
        />
        <Kpi
          label="Fleet reporting"
          value={data ? `${data.fleet.reportingWithinTheHour}/${data.fleet.total}` : '—'}
          sub={<span>{data ? fmt.int(data.fleet.inTransit) : '—'} in transit</span>}
          tone="neutral"
          delay={200}
        />
      </section>

      {data?.demoData.note && (
        <div className="flex items-center gap-2 border border-[var(--color-hairline)] bg-[var(--color-panel)] px-3 py-2">
          <Chip tone="neutral">demo data</Chip>
          <span className="text-[0.75rem] text-[var(--color-ink-dim)]">{data.demoData.note}</span>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.55fr_1fr]">
        {/* --------------------------------------------------------- charts */}
        <div className="space-y-4">
          <Panel
            title="Shipment flow · 30 days"
            loading={perDay.isLoading}
            actions={
              <span className="flex items-center gap-3">
                {[
                  ['Created', 'var(--color-info)'],
                  ['Delivered', 'var(--color-ok)'],
                  ['Late', 'var(--color-alert)'],
                ].map(([label, colour]) => (
                  <span key={label} className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5" style={{ background: colour }} />
                    <span className="text-[0.5625rem]">{label}</span>
                  </span>
                ))}
              </span>
            }
          >
            <div className="h-[228px] p-2.5">
              {perDay.isError ? (
                <ErrorNote error={perDay.error} />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 6, right: 6, left: -22, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gCreated" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-info)" stopOpacity={0.28} />
                        <stop offset="100%" stopColor="var(--color-info)" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gDelivered" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-ok)" stopOpacity={0.28} />
                        <stop offset="100%" stopColor="var(--color-ok)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="var(--color-hairline)" strokeDasharray="2 4" vertical={false} />
                    <XAxis dataKey="day" {...CHART_AXIS} interval="preserveStartEnd" minTickGap={28} />
                    <YAxis {...CHART_AXIS} width={44} allowDecimals={false} />
                    <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--color-hairline-bright)' }} />
                    <Area
                      type="monotone"
                      dataKey="Created"
                      stroke="var(--color-info)"
                      strokeWidth={1.5}
                      fill="url(#gCreated)"
                    />
                    <Area
                      type="monotone"
                      dataKey="Delivered"
                      stroke="var(--color-ok)"
                      strokeWidth={1.5}
                      fill="url(#gDelivered)"
                    />
                    <Area
                      type="monotone"
                      dataKey="Late"
                      stroke="var(--color-alert)"
                      strokeWidth={1.5}
                      fill="none"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </Panel>

          <div className="grid gap-4 md:grid-cols-2">
            <Panel title="Delivery performance · 90 days" loading={performance.isLoading}>
              <div className="space-y-3 p-3.5">
                {performance.data ? (
                  <>
                    <MetricRow
                      label="On time"
                      value={fmt.pct(performance.data.onTimeRate, 1)}
                      meter={performance.data.onTimeRate ?? 0}
                      tone={
                        (performance.data.onTimeRate ?? 0) > 0.9
                          ? 'ok'
                          : (performance.data.onTimeRate ?? 0) > 0.75
                            ? 'warn'
                            : 'alert'
                      }
                    />
                    <MetricRow
                      label="Mean delay"
                      value={`${fmt.num(performance.data.averageDelayHours, 1)} h`}
                    />
                    <MetricRow
                      label="p90 delay"
                      value={`${fmt.num(performance.data.p90DelayHours, 1)} h`}
                    />
                    <MetricRow
                      label="ETA error"
                      value={
                        performance.data.etaAccuracyMinutes === null
                          ? '—'
                          : `${fmt.num(performance.data.etaAccuracyMinutes, 0)} min`
                      }
                    />
                    <p className="border-t border-[var(--color-hairline)] pt-2.5 text-[0.6875rem] leading-relaxed text-[var(--color-ink-faint)]">
                      {performance.data.note}
                    </p>
                  </>
                ) : (
                  <Loading />
                )}
              </div>
            </Panel>

            <Panel title="Supplier reliability" loading={suppliers.isLoading}>
              <div className="h-[212px] p-2.5">
                {suppliers.data && suppliers.data.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={suppliers.data.map((supplier) => ({
                        name: supplier.name.split(' ')[0],
                        score: Math.round(supplier.reliabilityScore),
                        measured: supplier.measured,
                      }))}
                      margin={{ top: 6, right: 6, left: -26, bottom: 0 }}
                    >
                      <CartesianGrid stroke="var(--color-hairline)" strokeDasharray="2 4" vertical={false} />
                      <XAxis dataKey="name" {...CHART_AXIS} />
                      <YAxis {...CHART_AXIS} width={44} domain={[0, 100]} />
                      <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgb(255 255 255 / 0.03)' }} />
                      <Bar dataKey="score" name="Reliability" radius={[1, 1, 0, 0]}>
                        {suppliers.data.map((supplier) => (
                          <Cell
                            key={supplier.id}
                            fill={
                              supplier.reliabilityScore >= 90
                                ? 'var(--color-ok)'
                                : supplier.reliabilityScore >= 80
                                  ? 'var(--color-signal)'
                                  : 'var(--color-alert)'
                            }
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <Empty title="No suppliers" hint="Add suppliers to see reliability." />
                )}
              </div>
            </Panel>
          </div>
        </div>

        {/* ---------------------------------------------------------- advice */}
        <Panel
          title="What to do next"
          meta={
            data && data.openRecommendations > 0 ? (
              <Chip tone="signal">{data.openRecommendations} open</Chip>
            ) : null
          }
          actions={
            <Link href="/recommendations" className="hover:text-[var(--color-signal)]">
              all →
            </Link>
          }
          loading={advice.isLoading}
        >
          {advice.isError ? (
            <ErrorNote error={advice.error} />
          ) : advice.data && advice.data.data.length > 0 ? (
            <ul className="divide-y divide-[var(--color-hairline)]">
              {advice.data.data.map((recommendation) => (
                <li key={recommendation.id} className="p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <Link
                      href={`/recommendations#${recommendation.id}`}
                      className="text-[0.8125rem] font-medium leading-snug hover:text-[var(--color-signal)]"
                    >
                      {recommendation.title}
                    </Link>
                    <Chip tone={priorityTone(recommendation.priority)}>{recommendation.priority}</Chip>
                  </div>
                  <div className="mt-2">
                    <Explain
                      reasons={recommendation.explanation?.reasons?.slice(0, 2) ?? []}
                    />
                  </div>
                  {recommendation.estimatedCostDelta !== null && (
                    <div className="mt-2 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
                      {recommendation.estimatedCostDelta >= 0 ? 'commits' : 'releases'}{' '}
                      <span className="text-[var(--color-ink-dim)]">
                        {fmt.money(Math.abs(recommendation.estimatedCostDelta))}
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              title="Nothing needs attention"
              hint="Generate advice from the Advice screen once there is enough history."
            />
          )}
        </Panel>
      </div>
    </div>
  );
}

function MetricRow({
  label,
  value,
  meter,
  tone,
}: {
  label: string;
  value: string;
  meter?: number;
  tone?: 'ok' | 'warn' | 'alert' | 'signal';
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
          {label}
        </span>
        <span className="tnum font-mono text-[0.875rem] text-[var(--color-ink)]">{value}</span>
      </div>
      {meter !== undefined && (
        <div className="mt-1.5">
          <Meter value={meter} tone={tone} />
        </div>
      )}
    </div>
  );
}
