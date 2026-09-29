'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Boxes,
  CircleGauge,
  FlaskConical,
  Gavel,
  Map as MapIcon,
  Package,
  PackageCheck,
  Radar,
  Sparkles,
  Truck,
  TriangleAlert,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type FleetVehicle,
  type Overview,
  type Paginated,
  type Recommendation,
} from '@/lib/api';
import {
  Banner,
  DecisionLoop,
  Empty,
  ErrorNote,
  Kpi,
  Legend,
  Loading,
  PageHeader,
  Panel,
  Provenance,
  Skeleton,
  toSeverity,
} from '@/components/ui';
import { useToast } from '@/components/toast';
import { useAuth } from '@/lib/auth';
import { useFormat, useI18n } from '@/lib/i18n';
import { AlertQueue, type NotificationPage } from './_components/alert-queue';
import {
  DeliveryPerformancePanel,
  ShipmentFlowChart,
  SupplierReliabilityPanel,
  type DayRow,
  type DeliveryPerformance,
  type SupplierRow,
} from './_components/charts';
import { CorridorMap, vehicleState, type WarehousePoint } from './_components/corridor-map';
import { DecisionCard, byUrgency } from './_components/decision-card';

interface AcceptResult {
  message: string;
  executed: { type: string; id: string; description: string } | null;
  recommendation: Recommendation;
}

/** Fleet poll interval. The live map holds the socket; Control only needs the picture every 30 s. */
const FLEET_POLL_S = 30;
/** A fix older than this is shown as stale rather than as a polled live source. */
const STALE_FIX_MS = 60 * 60_000;

/** Browser connectivity, plus when it was lost so the frozen view can say "as of 14:28". */
function useOnline(): { online: boolean; since: Date | null } {
  const [online, setOnline] = useState(true);
  const [since, setSince] = useState<Date | null>(null);
  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      setSince(navigator.onLine ? null : new Date());
    };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return { online, since };
}

/**
 * Control — charte screen 01: « Qu'est-ce qui demande une décision maintenant ? ».
 *
 * The page is organised around the decision loop rather than around the data: open
 * recommendations first (with the one black action), the corridor they concern, the alerts that
 * produced them, then the history charts. Nothing here is sent without an explicit accept.
 */
export default function DashboardPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const client = useQueryClient();
  const { online, since: offlineSince } = useOnline();

  /* ---------------------------------------------------------------- data */

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
    queryKey: ['recommendations', 'control', 'OPEN'],
    queryFn: () => api<Paginated<Recommendation>>('/recommendations?status=OPEN&limit=20'),
    refetchInterval: 60_000,
  });

  // Same keys as the live map, so switching screens reuses the cache instead of refetching.
  const fleet = useQuery({
    queryKey: ['telemetry', 'fleet'],
    queryFn: () => api<FleetVehicle[]>('/telemetry/fleet'),
    refetchInterval: FLEET_POLL_S * 1000,
  });

  const warehouses = useQuery({
    queryKey: ['warehouses', 'all'],
    queryFn: () => api<{ data: WarehousePoint[] }>('/warehouses?limit=100'),
  });

  const alerts = useQuery({
    queryKey: ['notifications', 'control', 'unread'],
    queryFn: () => api<NotificationPage>('/notifications?limit=15&unreadOnly=true'),
    refetchInterval: 30_000,
  });

  const aiStatus = useQuery({
    queryKey: ['ai', 'status'],
    queryFn: () => api<{ reachable: boolean; detail: string }>('/ai/status'),
    refetchInterval: 60_000,
  });

  const data = overview.data;
  const decisions = useMemo(() => [...(advice.data?.data ?? [])].sort(byUrgency), [advice.data]);
  const openCount = advice.data?.meta.total ?? data?.openRecommendations ?? decisions.length;
  const criticalCount = decisions.filter((item) => toSeverity(item.priority) === 'critical').length;

  /* ----------------------------------------------------------- selection */

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [explained, setExplained] = useState<Set<string>>(new Set());
  const [lastDecision, setLastDecision] = useState<string | null>(null);

  // Keep a valid selection: the top decision by default, the next one once the selected is gone.
  const selected = decisions.find((item) => item.id === selectedId) ?? decisions[0] ?? null;

  const toggleWhy = useCallback((id: string) => {
    setExplained((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /* -------------------------------------------------------------- accept */

  const canApprove = can('recommendation:approve');
  const blockedReason = !canApprove
    ? t('dash.v3.readOnly')
    : !online
      ? t('dash.v3.offlineAction')
      : null;

  // The exact call the Advice screen makes: accepting executes the payload server-side.
  const accept = useMutation({
    mutationFn: (id: string) =>
      api<AcceptResult>(`/recommendations/${id}/accept`, { method: 'POST', body: { note: undefined } }),
    onSuccess: (result) => {
      setLastDecision(result.recommendation.title);
      void client.invalidateQueries({ queryKey: ['recommendations'] });
      void client.invalidateQueries({ queryKey: ['purchase-orders'] });
      void client.invalidateQueries({ queryKey: ['analytics', 'overview'] });
      // No endpoint reverses an accepted recommendation, so the toast offers the PO, not Undo.
      if (result.executed?.type === 'PURCHASE_ORDER') {
        toast.show({
          tone: 'success',
          message: t('dash.v3.poCreated'),
          action: { label: t('dash.v3.openPo'), onClick: () => router.push('/purchase-orders') },
        });
      } else {
        toast.show({ tone: 'success', message: result.executed ? t('dash.v3.executed') : t('dash.v3.accepted') });
      }
    },
    onError: (error) => {
      toast.show({
        tone: 'error',
        message: t('dash.v3.acceptFailed', { error: error instanceof Error ? error.message : String(error) }),
      });
    },
  });

  const acceptSelected = useCallback(() => {
    if (!selected || blockedReason || accept.isPending) return;
    accept.mutate(selected.id);
  }, [selected, blockedReason, accept]);

  /* ------------------------------------------------------------ keyboard */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable;
      if (typing || event.metaKey || event.ctrlKey || event.altKey || decisions.length === 0) return;
      const key = event.key.toLowerCase();
      const index = selected ? decisions.findIndex((item) => item.id === selected.id) : -1;

      if (key === 'j' || key === 'k') {
        event.preventDefault();
        const next = decisions[Math.min(decisions.length - 1, Math.max(0, index + (key === 'j' ? 1 : -1)))];
        if (!next) return;
        setSelectedId(next.id);
        document.getElementById(`decision-${next.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else if (key === 'a') {
        event.preventDefault();
        acceptSelected();
      } else if (key === 'w' && selected) {
        event.preventDefault();
        toggleWhy(selected.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decisions, selected, acceptSelected, toggleWhy]);

  /* ---------------------------------------------------------- situation */

  const vehicles = fleet.data;
  const latestFix = useMemo(
    () => (vehicles ?? []).reduce<number>((max, vehicle) => Math.max(max, Date.parse(vehicle.lastPositionAt) || 0), 0),
    [vehicles],
  );
  const fixIsStale = latestFix > 0 && Date.now() - latestFix > STALE_FIX_MS;
  const exceptions = (vehicles ?? []).filter((vehicle) => vehicleState(vehicle) !== 'nominal').length;
  const moving = (vehicles ?? []).filter((vehicle) => (vehicle.speedKmh ?? 0) > 3).length;
  const hasDemoVehicles = (vehicles ?? []).some((vehicle) => vehicle.isDemoData);
  const unreadAlerts = alerts.data?.unreadCount ?? 0;
  const detected = (data?.shipments.atRisk ?? 0) + (data?.shipments.withOpenAnomaly ?? 0) + unreadAlerts;

  // The loop's lit step is read from state, not decoration: open advice waits on a human (3),
  // a decision just taken closes the loop (4), detected exceptions without advice sit with
  // OPTIMISE (2), and a quiet network is TRACK watching (1).
  const loopStep =
    openCount > 0 ? 2 : lastDecision ? 3 : detected > 0 ? 1 : 0;

  const title = advice.isLoading
    ? t('dash.v3.titleLoading')
    : openCount === 0
      ? t('dash.v3.titleNone')
      : `${openCount === 1 ? t('dash.v3.titleOne') : t('dash.v3.titleMany', { n: openCount })}${
          criticalCount === 0
            ? ''
            : criticalCount === 1
              ? t('dash.v3.titleCritOne')
              : t('dash.v3.titleCritMany', { n: criticalCount })
        }`;

  const overviewSource = overview.dataUpdatedAt
    ? t('dash.v3.src.overview', { time: fmt.time(new Date(overview.dataUpdatedAt)) })
    : undefined;

  /* -------------------------------------------------------------- render */

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={t('dash.v3.kicker')}
        title={title}
        description={t('dash.v3.description')}
        meta={
          <>
            {!online ? (
              <Provenance kind="offline" label={t('dash.v3.offlineFrozen', { time: fmt.time(offlineSince ?? new Date()) })} />
            ) : fixIsStale ? (
              <Provenance kind="stale" label={t('dash.v3.gpsStale', { age: fmt.relative(new Date(latestFix)) })} />
            ) : (
              <Provenance kind="poll" seconds={FLEET_POLL_S} label={t('dash.v3.gpsPoll', { s: FLEET_POLL_S })} />
            )}
            {aiStatus.data && (
              <Provenance
                kind={aiStatus.data.reachable ? 'live' : 'offline'}
                label={aiStatus.data.reachable ? t('dash.v3.aiOnline') : t('dash.v3.aiOffline')}
                title={aiStatus.data.detail}
              />
            )}
            {data && data.demoData.shipments > 0 && <Provenance kind="demo" />}
            <span className="hidden items-center gap-1.5 text-[12px] text-[var(--color-dim)] lg:flex">
              <kbd className="kbd">J</kbd>
              <kbd className="kbd">K</kbd>
              <kbd className="kbd">A</kbd>
              <kbd className="kbd">W</kbd>
              {t('dash.v3.shortcuts')}
            </span>
          </>
        }
        actions={
          <>
            <Link href="/map" className="btn">
              <MapIcon />
              {t('dash.v3.openLiveMap')}
            </Link>
            <Link href="/recommendations" className="btn btn-ghost">
              <Sparkles />
              {t('dash.v3.allAdvice')}
            </Link>
          </>
        }
      />

      {/* ---------------------------------------------------------------- KPIs */}
      {overview.isError ? (
        <div className="panel">
          <ErrorNote error={overview.error} onRetry={() => void overview.refetch()} />
        </div>
      ) : overview.isLoading ? (
        <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-busy>
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="panel flex flex-col gap-3 p-4">
              <Skeleton className="h-3 w-2/3" style={{ animationDelay: `${index * 60}ms` }} />
              <Skeleton className="h-7 w-1/2" style={{ animationDelay: `${index * 60}ms` }} />
              <Skeleton className="h-3 w-3/4" style={{ animationDelay: `${index * 60}ms` }} />
            </div>
          ))}
        </section>
      ) : (
        <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Kpi
            icon={Package}
            label={t('kpi.activeShipments')}
            value={data ? fmt.int(data.shipments.active) : '—'}
            sub={
              data && data.shipments.delayed > 0
                ? t('kpi.runningLate', { n: data.shipments.delayed })
                : t('kpi.noneLate')
            }
            tone={data && data.shipments.delayed > 0 ? 'warn' : 'neutral'}
            source={overviewSource}
            href="/shipments"
            delay={0}
          />
          <Kpi
            icon={TriangleAlert}
            label={t('kpi.atRisk')}
            value={data ? fmt.int(data.shipments.atRisk) : '—'}
            sub={t('kpi.delayThreshold')}
            tone={data && data.shipments.atRisk > 0 ? 'warn' : 'neutral'}
            source={overviewSource}
            href="/shipments"
            delay={40}
          />
          <Kpi
            icon={PackageCheck}
            label={t('kpi.deliveredToday')}
            value={data ? fmt.int(data.shipments.deliveredToday) : '—'}
            sub={
              performance.data?.onTimeRate !== null && performance.data?.onTimeRate !== undefined
                ? t('kpi.onTime90d', { pct: fmt.pct(performance.data.onTimeRate) })
                : t('kpi.noHistory')
            }
            source={overviewSource}
            href="/deliveries"
            delay={80}
          />
          <Kpi
            icon={Wallet}
            label={t('kpi.inventoryValue')}
            value={data ? fmt.int(data.inventory.value) : '—'}
            unit="GHS"
            sub={t('kpi.skus', { n: data ? fmt.int(data.inventory.distinctSkus) : '—' })}
            source={overviewSource}
            href="/inventory"
            delay={120}
          />
          <Kpi
            icon={Boxes}
            label={t('kpi.stockExceptions')}
            value={data ? fmt.int(data.inventory.lowStockProducts + data.inventory.outOfStockProducts) : '—'}
            sub={
              data
                ? t('kpi.outAndLow', {
                    out: data.inventory.outOfStockProducts,
                    low: data.inventory.lowStockProducts,
                  })
                : undefined
            }
            tone={
              data && data.inventory.outOfStockProducts > 0
                ? 'alert'
                : data && data.inventory.lowStockProducts > 0
                  ? 'warn'
                  : 'neutral'
            }
            source={overviewSource}
            href="/inventory"
            delay={160}
          />
          <Kpi
            icon={Truck}
            label={t('kpi.fleetReporting')}
            value={data ? `${data.fleet.reportingWithinTheHour}/${data.fleet.total}` : '—'}
            sub={t('kpi.inTransit', { n: data ? fmt.int(data.fleet.inTransit) : '—' })}
            source={
              latestFix > 0 ? t('dash.v3.src.gps', { age: fmt.relative(new Date(latestFix)) }) : overviewSource
            }
            href="/map"
            delay={200}
          />
        </section>
      )}

      {data?.demoData.note && (
        <Banner tone="demo" icon={FlaskConical} title={t('dash.v3.demoTitle')}>
          {data.demoData.note}
        </Banner>
      )}

      {/* ------------------------------------------------------ decision loop */}
      <section aria-label={t('dash.v3.loop.title')} className="rise overflow-x-auto" style={{ animationDelay: '120ms' }}>
        <div className="min-w-[560px]">
          <DecisionLoop
            active={loopStep}
            steps={[
              {
                icon: Radar,
                label: t('dash.v3.loop.detect'),
                detail: t('dash.v3.loop.detectDetail', { n: fmt.int(detected) }),
              },
              {
                icon: CircleGauge,
                label: t('dash.v3.loop.optimise'),
                detail: aiStatus.data?.reachable === false ? t('dash.v3.aiOffline') : t('dash.v3.loop.optimiseDetail'),
              },
              {
                icon: Sparkles,
                label: t('dash.v3.loop.recommend'),
                detail: t('dash.v3.loop.recommendDetail', { n: fmt.int(openCount) }),
              },
              {
                icon: Gavel,
                label: t('dash.v3.loop.decide'),
                detail: lastDecision ?? t('dash.v3.loop.decideDetail'),
              },
            ]}
          />
        </div>
      </section>

      {/* ------------------------------------------ decisions · corridor · alerts */}
      <div className="grid gap-4 sm:grid-cols-2 min-[1440px]:grid-cols-[minmax(0,1.05fr)_minmax(0,1.3fr)_minmax(0,0.95fr)]">
        <Panel
          icon={Gavel}
          title={t('dash.v3.decisions')}
          meta={
            openCount > 0 ? (
              <span key={openCount} className="pill-count pop">
                {fmt.int(openCount)}
              </span>
            ) : null
          }
          loading={advice.isFetching && !advice.data}
          className="flex min-h-0 flex-col sm:row-span-2 min-[1440px]:row-span-1"
        >
          {advice.isError ? (
            <ErrorNote error={advice.error} onRetry={() => void advice.refetch()} />
          ) : advice.isLoading ? (
            <Loading rows={6} />
          ) : decisions.length === 0 ? (
            <Empty
              title={t('dash.v3.decisionsEmpty')}
              hint={t('dash.v3.decisionsEmptyHint')}
              action={
                <Link href="/recommendations" className="btn btn-sm">
                  <Sparkles />
                  {t('dash.v3.allAdvice')}
                </Link>
              }
            />
          ) : (
            <ul
              aria-label={t('dash.v3.decisions')}
              className="stagger m-0 flex max-h-[640px] list-none flex-col gap-2 overflow-y-auto p-3"
            >
              {decisions.map((recommendation) => (
                <DecisionCard
                  key={recommendation.id}
                  recommendation={recommendation}
                  selected={recommendation.id === selected?.id}
                  explained={explained.has(recommendation.id)}
                  onSelect={() => setSelectedId(recommendation.id)}
                  onToggleWhy={() => toggleWhy(recommendation.id)}
                  onAccept={() => accept.mutate(recommendation.id)}
                  accepting={accept.isPending && accept.variables === recommendation.id}
                  blockedReason={blockedReason}
                />
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          icon={MapIcon}
          title={t('dash.v3.corridor')}
          meta={
            vehicles ? (
              <span className="t-data text-[11px] text-[var(--color-dim)]">
                {t('dash.v3.mapCount', { moving: fmt.int(moving), total: fmt.int(vehicles.length) })}
              </span>
            ) : null
          }
          actions={
            <Link href="/map" className="hover:text-[var(--color-ink)] hover:underline">
              {t('dash.v3.openLiveMap')}
            </Link>
          }
          className="flex flex-col"
        >
          <div className="flex flex-1 flex-col gap-3 px-3 pb-3 pt-2">
            {fleet.isError ? (
              <ErrorNote error={fleet.error} onRetry={() => void fleet.refetch()} />
            ) : (
              <div className="relative h-[360px] min-[1440px]:h-[440px]">
                <CorridorMap vehicles={vehicles} warehouses={warehouses.data?.data} />
                {vehicles && vehicles.length === 0 && (
                  <div className="map-card absolute inset-x-4 bottom-4">
                    <Empty title={t('dash.v3.mapEmpty')} hint={t('dash.v3.mapEmptyHint')} icon={Truck} />
                  </div>
                )}
                {exceptions > 0 && (
                  <div className="map-card slide-up absolute left-3 top-3 flex items-center gap-2 px-3 py-2 text-[12px]">
                    <TriangleAlert className="h-3.5 w-3.5 text-[var(--color-warn)]" />
                    {t('dash.v3.mapExceptions', { n: fmt.int(exceptions) })}
                  </div>
                )}
              </div>
            )}
            <Legend
              items={[
                { label: t('dash.v3.legend.nominal'), colour: 'var(--color-ink)' },
                { label: t('dash.v3.legend.risk'), colour: 'var(--color-warn)' },
                { label: t('dash.v3.legend.late'), colour: 'var(--color-crit)' },
                ...(hasDemoVehicles
                  ? [{ label: t('dash.v3.legend.demo'), colour: 'var(--color-sim)', shape: 'dash' as const }]
                  : []),
                { label: t('dash.v3.legend.warehouse'), colour: 'var(--color-muted)', shape: 'line' as const },
              ]}
            />
          </div>
        </Panel>

        <div className="sm:col-start-2 min-[1440px]:col-start-3 min-[1440px]:row-start-1">
          <AlertQueue query={alerts} />
        </div>
      </div>

      {/* ---------------------------------------------------------- history */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <ShipmentFlowChart query={perDay} />
        <DeliveryPerformancePanel query={performance} />
        <SupplierReliabilityPanel query={suppliers} />
      </div>
    </div>
  );
}
