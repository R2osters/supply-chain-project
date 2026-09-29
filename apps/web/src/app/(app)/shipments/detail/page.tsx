'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Calculator,
  Clock,
  History,
  Map as MapIcon,
  Package,
  ScanSearch,
  Sparkles,
  Timer,
  Truck,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, type ReactNode } from 'react';
import { api, type Explanation } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat, useI18n } from '@/lib/i18n';
import {
  AlertRow,
  Banner,
  Button,
  Chip,
  DemoTag,
  Empty,
  ErrorNote,
  Explain,
  Facts,
  Kpi,
  Loading,
  Meter,
  PageHeader,
  Panel,
  Provenance,
  Legend,
  statusTone,
  toSeverity,
} from '@/components/ui';
import { useToast } from '@/components/toast';
import { EventTimeline, type ShipmentEventRow } from './_components/event-timeline';
import { humanise, useLabel, useStatusLabel } from './_components/labels';
import { TrackMap } from './_components/track-map';

interface TrackingPosition {
  latitude: number;
  longitude: number;
  speedKmh: number | null;
  recordedAt: string;
  isSimulated: boolean;
}

interface TrackingResponse {
  shipment: {
    id: string;
    trackingNumber: string;
    status: string;
    origin: { name: string; latitude: number; longitude: number };
    destination: { name: string; latitude: number; longitude: number };
    plannedDepartureAt: string;
    actualDepartureAt: string | null;
    plannedArrivalAt: string;
    estimatedArrivalAt: string | null;
    actualArrivalAt: string | null;
    travelledDistanceKm: number;
    plannedDistanceKm: number;
    delayProbability: number | null;
    delayRisk: string | null;
    isDemoData: boolean;
  };
  route: { id: string; name: string; polyline: Array<{ latitude: number; longitude: number }> } | null;
  events: ShipmentEventRow[];
  anomalies: Array<{
    id: string;
    type: string;
    severity: string;
    score: number;
    description: string;
    detectedAt: string;
  }>;
  positions: TrackingPosition[];
  positionsTotal: number;
  positionsSampledEvery: number;
  eta: {
    estimatedArrival: string;
    remainingDistanceKm: number;
    effectiveSpeedKmh: number;
    confidenceScore: number;
    arrivalWindow: { earliest: string; latest: string };
    reasons: string[];
    assumptions: string[];
    lateness: { isLate: boolean; minutesLate: number; certainlyLate: boolean };
    basedOnSamples: number;
  } | null;
}

/** The fields of `GET /shipments/:id` this page adds to the tracking view: who and what. */
interface ShipmentRecord {
  vehicleId: string | null;
  vehicle: { id: string; plateNumber: string; label: string | null } | null;
  driver: { firstName: string; lastName: string; phone: string | null } | null;
  carrier: { name: string } | null;
  cargoValue: string | number | null;
  currency: string | null;
  totalWeightKg: string | number | null;
  items?: unknown[];
}

/** A last fix older than this is shown with its age, never as live. */
const STALE_AFTER_MIN = 10;

/**
 * The id travels as `?id=` rather than a `[id]` segment: the desktop build is a static export,
 * which cannot pre-render one page per shipment. useSearchParams needs a Suspense boundary there.
 */
export default function ShipmentDetailPage() {
  return (
    <Suspense fallback={null}>
      <ShipmentDetail />
    </Suspense>
  );
}

function ShipmentDetail() {
  const id = useSearchParams().get('id') ?? '';
  const client = useQueryClient();
  const { can } = useAuth();
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const label = useLabel();
  const statusLabel = useStatusLabel();

  const tracking = useQuery({
    queryKey: ['shipment', id, 'tracking'],
    queryFn: () => api<TrackingResponse>(`/shipments/${id}/tracking`),
    refetchInterval: 20_000,
  });

  // Vehicle, driver, carrier and cargo value are on the shipment record, not the tracking view.
  const record = useQuery({
    queryKey: ['shipment', id, 'record'],
    queryFn: () => api<ShipmentRecord>(`/shipments/${id}`),
    staleTime: 60_000,
  });

  const onFailure = (error: unknown) =>
    toast.show({ tone: 'error', message: error instanceof Error ? error.message : String(error) });

  const recomputeEta = useMutation({
    mutationFn: () => api(`/shipments/${id}/recompute-eta`, { method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['shipment', id] });
      toast.show({ tone: 'success', message: t('ship.detail.toast.eta') });
    },
    onError: onFailure,
  });

  const predictDelay = useMutation({
    mutationFn: () => api(`/ai/predict-delay/${id}`, { method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['shipment', id] });
      toast.show({ tone: 'success', message: t('ship.detail.toast.predicted') });
    },
    onError: onFailure,
  });

  const detectAnomalies = useMutation({
    mutationFn: () =>
      api<{ anomalies: unknown[]; explanation: Explanation }>(`/ai/detect-anomaly/${id}`, {
        method: 'POST',
      }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['shipment', id] });
      toast.show({ tone: 'success', message: t('ship.detail.toast.scanned', { n: result.anomalies.length }) });
    },
    onError: onFailure,
  });

  // Stable coordinate arrays: the map effect keys on them and must not re-run every render.
  const geometry = useMemo(() => {
    const data = tracking.data;
    if (!data) return null;
    const origin: [number, number] = [data.shipment.origin.longitude, data.shipment.origin.latitude];
    const destination: [number, number] = [data.shipment.destination.longitude, data.shipment.destination.latitude];
    const planned =
      data.route?.polyline?.map((point) => [point.longitude, point.latitude] as [number, number]) ?? [origin, destination];
    const actual = data.positions.map((position) => [position.longitude, position.latitude] as [number, number]);
    return { origin, destination, planned, actual };
  }, [tracking.data]);

  if (tracking.isLoading) return <Loading label={t('ship.detail.loading')} rows={8} />;
  if (tracking.isError) return <ErrorNote error={tracking.error} onRetry={() => void tracking.refetch()} />;
  if (!tracking.data || !geometry) {
    return (
      <Empty
        icon={Package}
        title={t('ship.detail.notFound')}
        action={
          <Link href="/shipments" className="btn btn-sm">
            {t('ship.detail.backToList')}
          </Link>
        }
      />
    );
  }

  const { shipment, events, anomalies, eta, positions, positionsTotal, positionsSampledEvery } = tracking.data;
  const progress =
    shipment.plannedDistanceKm > 0 ? Math.min(1, shipment.travelledDistanceKm / shipment.plannedDistanceKm) : 0;
  const lastFix = positions.length > 0 ? positions[positions.length - 1] : null;
  const simulatedTrack = positions.some((position) => position.isSimulated);
  const vehicleId = record.data?.vehicleId ?? record.data?.vehicle?.id ?? null;

  /* ------------------------------------------------------------- actions */

  // The single black action: a missing delay prediction is the most useful thing to fill;
  // otherwise refreshing the ETA is. The other two stay secondary.
  const canAi = can('ai:create');
  const canUpdate = can('shipment:update');
  const primary: 'predict' | 'eta' | null =
    shipment.delayProbability === null && canAi ? 'predict' : canUpdate ? 'eta' : canAi ? 'predict' : null;

  const buttons: Array<{ id: 'eta' | 'predict' | 'scan'; node: ReactNode }> = [];
  if (canUpdate) {
    buttons.push({
      id: 'eta',
      node: (
      <Button
        key="eta"
        variant={primary === 'eta' ? 'primary' : 'secondary'}
        icon={Calculator}
        loading={recomputeEta.isPending}
        onClick={() => recomputeEta.mutate()}
      >
        {recomputeEta.isPending ? t('ship.detail.action.computing') : t('ship.detail.action.recomputeEta')}
      </Button>
      ),
    });
  }
  if (canAi) {
    buttons.push(
      {
        id: 'predict',
        node: (
      <Button
        key="predict"
        variant={primary === 'predict' ? 'primary' : 'secondary'}
        icon={Sparkles}
        loading={predictDelay.isPending}
        onClick={() => predictDelay.mutate()}
      >
        {predictDelay.isPending ? t('ship.detail.action.predicting') : t('ship.detail.action.predictDelay')}
      </Button>
        ),
      },
      {
        id: 'scan',
        node: (
      <Button
        key="scan"
        icon={ScanSearch}
        loading={detectAnomalies.isPending}
        onClick={() => detectAnomalies.mutate()}
      >
        {detectAnomalies.isPending ? t('ship.detail.action.scanning') : t('ship.detail.action.scanAnomalies')}
      </Button>
        ),
      },
    );
  }
  // Primary first, so the black button leads the row.
  buttons.sort((a, b) => Number(b.id === primary) - Number(a.id === primary));
  const actions: ReactNode[] = buttons.map((button) => button.node);
  if (vehicleId) {
    actions.push(
      <Link key="map" href={`/map?vehicle=${encodeURIComponent(vehicleId)}`} className="btn">
        <MapIcon />
        {t('ship.detail.action.showOnMap')}
      </Link>,
    );
  }

  /* ---------------------------------------------------------- provenance */

  const fixProvenance = !lastFix ? null : lastFix.isSimulated ? (
    <Provenance kind="demo" label={t('ship.detail.prov.simulatedGps')} />
  ) : (Date.now() - Date.parse(lastFix.recordedAt)) / 60_000 > STALE_AFTER_MIN ? (
    <Provenance kind="stale" label={t('ship.detail.prov.staleSince', { age: fmt.relative(lastFix.recordedAt) })} />
  ) : (
    <Provenance kind="poll" seconds={20} />
  );
  const gpsSource = lastFix ? t('ship.detail.kpi.gpsSource', { age: fmt.relative(lastFix.recordedAt) }) : undefined;

  const estimateTone = eta?.lateness.certainlyLate ? 'alert' : eta?.lateness.isLate ? 'warn' : 'neutral';
  const riskTone = shipment.delayRisk === 'HIGH' ? 'alert' : shipment.delayRisk === 'MEDIUM' ? 'warn' : 'neutral';

  const driverName = record.data?.driver ? `${record.data.driver.firstName} ${record.data.driver.lastName}` : null;
  const cargoValue = record.data?.cargoValue;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={
          <Link href="/shipments" className="flex items-center gap-1.5 hover:underline">
            <Package className="h-3.5 w-3.5" />
            {t('ship.detail.kicker')}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="t-data text-[28px] font-normal tracking-normal">{shipment.trackingNumber}</span>
            <Chip tone={statusTone(shipment.status)}>{statusLabel(shipment.status)}</Chip>
            {shipment.isDemoData && <DemoTag />}
          </span>
        }
        description={
          <>
            {shipment.origin.name}
            <span className="mx-2 text-[var(--color-dim)]">→</span>
            {shipment.destination.name}
            <span className="mx-2 text-[var(--color-dim)]">·</span>
            <span className="t-data">{fmt.num(shipment.plannedDistanceKm, 0)} km</span>
            {tracking.data.route && (
              <>
                <span className="mx-2 text-[var(--color-dim)]">·</span>
                {tracking.data.route.name}
              </>
            )}
          </>
        }
        meta={fixProvenance}
        actions={actions.length > 0 ? actions : undefined}
      />

      {/* ------------------------------------------------------------ KPIs */}
      <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi
          icon={Truck}
          label={t('ship.detail.kpi.departed')}
          value={fmt.dateTime(shipment.actualDepartureAt ?? shipment.plannedDepartureAt)}
          sub={shipment.actualDepartureAt ? t('ship.detail.kpi.actual') : t('ship.detail.kpi.planned')}
        />
        <Kpi icon={Clock} label={t('ship.detail.kpi.promised')} value={fmt.dateTime(shipment.plannedArrivalAt)} />
        <Kpi
          icon={Timer}
          label={t('ship.detail.kpi.estimated')}
          value={fmt.dateTime(shipment.actualArrivalAt ?? shipment.estimatedArrivalAt)}
          tone={estimateTone}
          sub={
            shipment.actualArrivalAt
              ? t('ship.detail.kpi.arrived')
              : eta?.lateness.isLate
                ? t('ship.detail.kpi.lateBy', { min: fmt.num(eta.lateness.minutesLate, 0) })
                : eta
                  ? t('ship.detail.kpi.onTime')
                  : undefined
          }
          source={gpsSource}
        />
        <Kpi
          icon={TriangleAlert}
          label={t('ship.delayRisk')}
          value={shipment.delayProbability === null ? t('common.notComputed') : fmt.pct(shipment.delayProbability)}
          tone={riskTone}
          sub={shipment.delayRisk ? label(`ship.detail.risk.${shipment.delayRisk}`, humanise(shipment.delayRisk)) : undefined}
          source={t('ship.detail.kpi.modelSource')}
        />
        <Kpi
          icon={MapIcon}
          label={t('ship.detail.kpi.distance')}
          value={fmt.num(shipment.travelledDistanceKm, 0)}
          unit={`/ ${fmt.num(shipment.plannedDistanceKm, 0)} km`}
          sub={<Meter value={progress} tone={shipment.status === 'DELAYED' ? 'alert' : 'signal'} />}
          source={t('ship.detail.kpi.progress', { pct: fmt.pct(progress) })}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          {/* ---------------------------------------------------------- track */}
          <Panel
            icon={MapIcon}
            title={t('ship.detail.track.title')}
            actions={
              <Legend
                items={[
                  { label: t('ship.detail.track.planned'), colour: 'var(--color-info)', shape: 'dash' },
                  { label: t('ship.detail.track.actual'), colour: 'var(--color-ink)', shape: 'line' },
                ]}
              />
            }
            className="overflow-hidden"
          >
            <div className="mt-3">
              <TrackMap
                planned={geometry.planned}
                actual={geometry.actual}
                origin={geometry.origin}
                destination={geometry.destination}
                label={t('ship.detail.track.title')}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 px-5 py-3 text-[12px] text-[var(--color-muted)]">
              <span className="t-data">{t('ship.detail.track.fixes', { n: fmt.int(positionsTotal) })}</span>
              {positionsSampledEvery > 1 && (
                <span>· {t('ship.detail.track.sampled', { n: positionsSampledEvery })}</span>
              )}
              {simulatedTrack && <DemoTag title={t('ship.detail.track.simulated')} />}
            </div>
          </Panel>

          {/* --------------------------------------------------------- events */}
          <Panel icon={History} title={t('ship.detail.events.title')} meta={<span className="t-data text-[11px] text-[var(--color-dim)]">{events.length}</span>}>
            <EventTimeline events={events} />
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          {/* ------------------------------------------------------ ETA engine */}
          <Panel icon={Timer} title={t('ship.detail.eta.title')}>
            {eta ? (
              <div className="flex flex-col gap-4 px-5 pb-5 pt-3">
                <div className="flex flex-col gap-0.5">
                  <span className="t-kpi text-[40px] leading-none text-[var(--color-ink)]">
                    {fmt.time(eta.estimatedArrival)}
                  </span>
                  <span className="text-[13px] text-[var(--color-muted)]">
                    {fmt.date(eta.estimatedArrival)} · {fmt.relative(eta.estimatedArrival)}
                  </span>
                </div>

                <div className="tile flex flex-col gap-3 p-3.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[12.5px] text-[var(--color-muted)]">{t('ship.detail.eta.window')}</span>
                    <span className="t-data text-[13px]">
                      {fmt.time(eta.arrivalWindow.earliest)} — {fmt.time(eta.arrivalWindow.latest)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[12.5px] text-[var(--color-muted)]">{t('common.confidence')}</span>
                      <span className="t-data text-[13px]">{fmt.pct(eta.confidenceScore)}</span>
                    </div>
                    {/* Grey by default: only a weak estimate earns a colour. */}
                    <Meter
                      value={eta.confidenceScore}
                      tone={eta.confidenceScore > 0.6 ? 'signal' : eta.confidenceScore > 0.35 ? 'warn' : 'alert'}
                    />
                  </div>
                </div>

                {eta.lateness.isLate && (
                  <Banner
                    tone={eta.lateness.certainlyLate ? 'alert' : 'warn'}
                    icon={TriangleAlert}
                    title={
                      eta.lateness.certainlyLate
                        ? t('ship.detail.eta.certainlyLate', { min: fmt.num(eta.lateness.minutesLate, 0) })
                        : t('ship.detail.eta.projectedLate', { min: fmt.num(eta.lateness.minutesLate, 0) })
                    }
                  >
                    {eta.lateness.certainlyLate ? t('ship.detail.eta.certainlyLateHint') : t('ship.detail.eta.projectedLateHint')}
                  </Banner>
                )}

                <Facts
                  columns={3}
                  items={[
                    [t('ship.detail.eta.remaining'), <span key="r" className="t-data">{fmt.num(eta.remainingDistanceKm, 0)} km</span>],
                    [t('ship.detail.eta.speed'), <span key="s" className="t-data">{fmt.num(eta.effectiveSpeedKmh, 0)} km/h</span>],
                    [t('ship.detail.eta.samples'), <span key="n" className="t-data">{fmt.int(eta.basedOnSamples)}</span>],
                  ]}
                />

                <Explain reasons={eta.reasons} assumptions={eta.assumptions} />
              </div>
            ) : (
              <Empty icon={Timer} title={t('ship.detail.eta.none')} hint={t('ship.detail.eta.noneHint')} />
            )}
          </Panel>

          {/* ------------------------------------------------------ assignment */}
          <Panel icon={Truck} title={t('ship.detail.assign.title')}>
            {record.isError ? (
              <ErrorNote error={record.error} onRetry={() => void record.refetch()} />
            ) : record.isLoading ? (
              <Loading rows={3} />
            ) : (
              <div className="px-5 pb-5 pt-3">
                <Facts
                  items={[
                    [
                      t('ship.vehicle'),
                      record.data?.vehicle ? (
                        <span key="v" className="t-data">
                          {record.data.vehicle.plateNumber}
                          {record.data.vehicle.label ? ` · ${record.data.vehicle.label}` : ''}
                        </span>
                      ) : (
                        '—'
                      ),
                    ],
                    [t('ship.detail.assign.driver'), driverName ?? '—'],
                    [t('ship.carrier'), record.data?.carrier?.name ?? '—'],
                    [
                      t('ship.detail.assign.cargoValue'),
                      cargoValue !== null && cargoValue !== undefined && Number(cargoValue) > 0 ? (
                        <span key="c" className="t-data">{fmt.money(cargoValue, record.data?.currency ?? 'USD')}</span>
                      ) : (
                        '—'
                      ),
                    ],
                    [
                      t('ship.detail.assign.weight'),
                      record.data?.totalWeightKg !== null && record.data?.totalWeightKg !== undefined ? (
                        <span key="w" className="t-data">{fmt.num(record.data.totalWeightKg, 0)} kg</span>
                      ) : (
                        '—'
                      ),
                    ],
                    [t('ship.detail.assign.lines'), <span key="l" className="t-data">{fmt.int(record.data?.items?.length ?? 0)}</span>],
                  ]}
                />
              </div>
            )}
          </Panel>

          {/* ------------------------------------------------------- anomalies */}
          <Panel
            icon={TriangleAlert}
            title={t('ship.detail.anomalies.title')}
            meta={
              anomalies.length > 0 ? (
                <span key={anomalies.length} className="pill-count pop">
                  {anomalies.length}
                </span>
              ) : null
            }
          >
            {detectAnomalies.data && (
              <div className="fade-in mx-5 mt-3 rounded-[var(--radius-md)] bg-[var(--color-surface-2)] p-3.5">
                <Explain
                  summary={detectAnomalies.data.explanation.summary}
                  reasons={detectAnomalies.data.explanation.reasons}
                  assumptions={detectAnomalies.data.explanation.assumptions}
                />
              </div>
            )}
            {anomalies.length === 0 ? (
              <Empty
                title={t('ship.detail.anomalies.none')}
                hint={t('ship.detail.anomalies.noneHint')}
                action={
                  canAi ? (
                    <Button
                      size="sm"
                      icon={ScanSearch}
                      loading={detectAnomalies.isPending}
                      onClick={() => detectAnomalies.mutate()}
                    >
                      {t('ship.detail.action.scanAnomalies')}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <ul className="stagger m-0 flex list-none flex-col p-0 py-2" aria-live="polite">
                {anomalies.map((anomaly) => (
                  <li key={anomaly.id}>
                    <AlertRow
                      severity={toSeverity(anomaly.severity)}
                      title={label(`ship.detail.anomaly.${anomaly.type}`, humanise(anomaly.type))}
                      context={anomaly.description}
                      source={t('ship.detail.anomalies.score', { score: fmt.num(anomaly.score, 2) })}
                      age={fmt.relative(anomaly.detectedAt)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
