'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { LineChart as LineChartIcon, TrendingUp } from 'lucide-react';
import { ApiError, api, type InventoryRow, type Paginated } from '@/lib/api';
import { Button, Chip, DemoTag, Empty, ErrorNote, Legend, Loading, Panel, SeverityIcon } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useFormat, useI18n } from '@/lib/i18n';
import { usePalette } from '@/lib/theme';

const DAYS = 10;
const HISTORY_DAYS = 30;
const DAY_MS = 86_400_000;

interface StoredForecast {
  modelName: string;
  generatedAt: string;
  warehouseId: string | null;
  isDemoData: boolean;
  points: Array<{ date: string; demand: number }>;
}

interface Movement {
  type: 'IN' | 'OUT' | 'TRANSFER' | 'ADJUSTMENT';
  quantity: string;
  occurredAt: string;
  warehouseId: string;
}

/**
 * Ten days of projected stock for one SKU × site.
 *
 * Demand comes from the product's latest stored forecast when there is one. Without it, the
 * projection falls back to the average daily outflow of the last 30 days from the stock ledger
 * and says plainly that it is an estimate — a straight line drawn from history is not a forecast.
 * Incoming stock is drawn as a separate dashed "planned" line because the list does not know
 * when it arrives; adding it on day 0 silently would overstate the cover.
 */
export function Projection({ row }: { row: InventoryRow | null }) {
  const { t } = useI18n();

  if (!row) {
    return (
      <Panel title={t('inv.v3.projection')} icon={LineChartIcon}>
        <Empty title={t('inv.v3.projSelect')} icon={LineChartIcon} />
      </Panel>
    );
  }
  return <ProjectionFor key={row.id} row={row} />;
}

function ProjectionFor({ row }: { row: InventoryRow }) {
  const { t } = useI18n();
  const f = useFormat();
  const palette = usePalette();
  const client = useQueryClient();
  const { can } = useAuth();

  const forecast = useQuery({
    queryKey: ['ai', 'forecast', row.product.id],
    queryFn: () => api<StoredForecast>(`/ai/forecast/${row.product.id}`),
    enabled: can('ai:read'),
  });
  const noForecast =
    !can('ai:read') || (forecast.isError && forecast.error instanceof ApiError && forecast.error.status === 404);

  const movements = useQuery({
    queryKey: ['inventory', 'movements', row.product.id, row.warehouse.id],
    queryFn: () =>
      api<Paginated<Movement>>(
        `/inventory/movements?productId=${row.product.id}&warehouseId=${row.warehouse.id}&limit=200&order=desc`,
      ),
    enabled: noForecast,
  });

  const runForecast = useMutation({
    mutationFn: () => api(`/ai/forecast/${row.product.id}?horizonDays=30`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['ai', 'forecast', row.product.id] }),
  });

  const model = useMemo(() => {
    let daily: number[] | null = null;
    let estimatedRate: number | null = null;

    if (forecast.data) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const upcoming = forecast.data.points
        .filter((point) => new Date(point.date).getTime() >= today.getTime())
        .slice(0, DAYS)
        .map((point) => Math.max(0, Number(point.demand)));
      // A forecast generated long ago may have no future points left; fall back to its last ones.
      daily = upcoming.length > 0 ? upcoming : forecast.data.points.slice(-DAYS).map((p) => Math.max(0, p.demand));
    } else if (noForecast && movements.data) {
      const since = Date.now() - HISTORY_DAYS * DAY_MS;
      const outflow = movements.data.data
        .filter((m) => m.type === 'OUT' && new Date(m.occurredAt).getTime() >= since)
        .reduce((sum, m) => sum + Math.abs(Number(m.quantity)), 0);
      estimatedRate = outflow / HISTORY_DAYS;
      daily = Array.from({ length: DAYS }, () => estimatedRate as number);
    }
    if (!daily) return null;

    const reorderPoint = Number(row.reorderPoint);
    let cumulative = 0;
    const points = [{ day: 0, free: row.freeStock, withIncoming: row.freeStock + row.incomingStock }];
    daily.forEach((demand, index) => {
      cumulative += demand;
      points.push({
        day: index + 1,
        free: Math.round((row.freeStock - cumulative) * 10) / 10,
        withIncoming: Math.round((row.freeStock + row.incomingStock - cumulative) * 10) / 10,
      });
    });
    const crossing = points.find((point) => point.free < reorderPoint);
    return { points, reorderPoint, demand10: cumulative, estimatedRate, crossing };
  }, [forecast.data, noForecast, movements.data, row]);

  const loading = (forecast.isLoading && can('ai:read')) || (noForecast && movements.isLoading);
  const error = forecast.isError && !noForecast ? forecast.error : movements.isError ? movements.error : null;

  const title = (
    <span className="flex items-center gap-2">
      {t('inv.v3.projection')}
      <span className="t-data text-[12.5px] text-[var(--color-muted)]">
        {row.product.sku} · {row.warehouse.code}
      </span>
    </span>
  );

  return (
    <Panel
      title={title}
      icon={LineChartIcon}
      actions={
        forecast.data ? (
          forecast.data.isDemoData ? <DemoTag /> : null
        ) : model ? (
          <Chip tone="neutral" title={t('inv.v3.estimateNote', { n: f.num(model.estimatedRate ?? 0, 1) })}>
            {t('inv.v3.estimate')}
          </Chip>
        ) : null
      }
    >
      <div className="flex flex-col gap-4 px-5 pb-5 pt-2">
        {error ? (
          <ErrorNote
            error={error}
            onRetry={() => {
              void forecast.refetch();
              void movements.refetch();
            }}
          />
        ) : loading || !model ? (
          <Loading rows={4} />
        ) : (
          <>
            <p className="m-0 flex items-center gap-2 text-[13.5px]" aria-live="polite">
              {model.crossing ? (
                <>
                  <SeverityIcon severity={model.crossing.day === 0 ? 'critical' : 'warning'} size={16} />
                  {model.crossing.day === 0 ? t('inv.v3.alreadyBelow') : t('inv.v3.crossesOn', { n: model.crossing.day })}
                </>
              ) : (
                <>
                  <SeverityIcon severity="ok" size={16} />
                  {t('inv.v3.holds')}
                </>
              )}
            </p>

            <div className="h-[220px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={model.points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={palette.line} vertical={false} />
                  <XAxis
                    dataKey="day"
                    tickFormatter={(day: number) => (day === 0 ? t('inv.v3.today') : t('inv.v3.day', { n: day }))}
                    tick={{ fill: palette.muted, fontSize: 11, fontFamily: 'var(--font-mono)' }}
                    axisLine={{ stroke: palette.line }}
                    tickLine={false}
                  />
                  <YAxis
                    width={48}
                    tick={{ fill: palette.muted, fontSize: 11, fontFamily: 'var(--font-mono)' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(value: number) => f.int(value)}
                  />
                  <Tooltip
                    contentStyle={{
                      background: palette.surface2,
                      border: `1px solid ${palette.line}`,
                      borderRadius: 10,
                      fontSize: 12,
                      color: palette.ink,
                    }}
                    labelFormatter={(day) => (Number(day) === 0 ? t('inv.v3.today') : t('inv.v3.day', { n: Number(day) }))}
                    formatter={(value, name) => [
                      f.int(Number(value)),
                      name === 'free' ? t('inv.v3.projFree') : t('inv.v3.projWithIncoming'),
                    ]}
                  />
                  <ReferenceLine
                    y={model.reorderPoint}
                    stroke={palette.warn}
                    strokeDasharray="4 4"
                    ifOverflow="extendDomain"
                  />
                  {row.incomingStock > 0 && (
                    <Line
                      type="monotone"
                      dataKey="withIncoming"
                      stroke={palette.info}
                      strokeDasharray="5 4"
                      strokeWidth={1.5}
                      dot={false}
                      isAnimationActive
                    />
                  )}
                  <Line
                    type="monotone"
                    dataKey="free"
                    stroke={palette.ink}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <Legend
              items={[
                { label: t('inv.v3.projFree'), colour: 'var(--color-ink)', shape: 'line' },
                ...(row.incomingStock > 0
                  ? [{ label: t('inv.v3.projWithIncoming'), colour: 'var(--color-info)', shape: 'dash' as const }]
                  : []),
                { label: t('inv.v3.reorderLine', { n: f.int(model.reorderPoint) }), colour: 'var(--color-warn)', shape: 'dash' },
              ]}
            />

            <div className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
              <span className="t-data">
                {t('inv.v3.demand10')} · {f.int(model.demand10)} {row.product.unitOfMeasure}
              </span>
              {forecast.data ? (
                <>
                  <span className="t-data text-[var(--color-dim)]">
                    {t('inv.v3.sourceForecast', {
                      model: forecast.data.modelName,
                      when: f.relative(forecast.data.generatedAt),
                    })}
                  </span>
                  {!forecast.data.warehouseId && <span>{t('inv.v3.forecastScope')}</span>}
                </>
              ) : (
                <span>
                  {model.estimatedRate === 0
                    ? t('inv.v3.noHistory')
                    : t('inv.v3.estimateNote', { n: f.num(model.estimatedRate ?? 0, 1) })}
                </span>
              )}
              {row.incomingStock > 0 && <span>{t('inv.v3.incomingNote')}</span>}
            </div>

            {!forecast.data && can('ai:create') && (
              <div>
                <Button
                  size="sm"
                  icon={TrendingUp}
                  loading={runForecast.isPending}
                  onClick={() => runForecast.mutate()}
                >
                  {t('inv.v3.runForecast')}
                </Button>
                {runForecast.isError && <ErrorNote error={runForecast.error} />}
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
