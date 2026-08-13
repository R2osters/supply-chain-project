'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, type Explanation } from '@/lib/api';
import {
  Chip,
  Empty,
  ErrorNote,
  Explain,
  Loading,
  Meter,
  Panel,
  fmt,
  riskTone,
  statusTone,
} from '@/components/ui';
import { useAuth } from '@/lib/auth';

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
  events: Array<{
    id: string;
    type: string;
    description: string;
    fromStatus: string | null;
    toStatus: string | null;
    occurredAt: string;
  }>;
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

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0c0e10' } },
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: { 'raster-opacity': 0.4, 'raster-saturation': -0.85 },
    },
  ],
};

export default function ShipmentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const client = useQueryClient();
  const { can } = useAuth();

  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const tracking = useQuery({
    queryKey: ['shipment', id, 'tracking'],
    queryFn: () => api<TrackingResponse>(`/shipments/${id}/tracking`),
    refetchInterval: 20_000,
  });

  const recomputeEta = useMutation({
    mutationFn: () => api(`/shipments/${id}/recompute-eta`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['shipment', id] }),
  });

  const predictDelay = useMutation({
    mutationFn: () => api(`/ai/predict-delay/${id}`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['shipment', id] }),
  });

  const detectAnomalies = useMutation({
    mutationFn: () =>
      api<{ anomalies: unknown[]; explanation: Explanation }>(`/ai/detect-anomaly/${id}`, {
        method: 'POST',
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['shipment', id] }),
  });

  /* ------------------------------------------------------------------ map */

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = new maplibregl.Map({
      container: container.current,
      style: OSM_STYLE,
      center: [-1, 6.4],
      zoom: 6,
      attributionControl: { compact: true },
    });
    instance.on('load', () => setMapReady(true));
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
      setMapReady(false);
    };
  }, []);

  useEffect(() => {
    const data = tracking.data;
    if (!mapReady || !map.current || !data) return;
    const instance = map.current;

    const plannedCoordinates =
      data.route?.polyline?.map((point) => [point.longitude, point.latitude] as [number, number]) ??
      [
        [data.shipment.origin.longitude, data.shipment.origin.latitude],
        [data.shipment.destination.longitude, data.shipment.destination.latitude],
      ];

    const actualCoordinates = data.positions.map(
      (position) => [position.longitude, position.latitude] as [number, number],
    );

    upsertLine(instance, 'planned', plannedCoordinates, {
      'line-color': '#4ea8ff',
      'line-width': 1.5,
      'line-opacity': 0.5,
      'line-dasharray': [2, 2],
    });

    if (actualCoordinates.length > 1) {
      upsertLine(instance, 'actual', actualCoordinates, {
        'line-color': '#ffb020',
        'line-width': 2.4,
        'line-opacity': 0.95,
      });
    }

    const bounds = new maplibregl.LngLatBounds();
    for (const coordinate of [...plannedCoordinates, ...actualCoordinates]) bounds.extend(coordinate);
    if (!bounds.isEmpty()) instance.fitBounds(bounds, { padding: 46, duration: 700, maxZoom: 11 });
  }, [mapReady, tracking.data]);

  if (tracking.isLoading) return <Loading label="Loading shipment" />;
  if (tracking.isError) return <ErrorNote error={tracking.error} />;
  if (!tracking.data) return <Empty title="Shipment not found" />;

  const { shipment, events, anomalies, eta, positions, positionsTotal, positionsSampledEvery } =
    tracking.data;

  const progress =
    shipment.plannedDistanceKm > 0
      ? Math.min(1, shipment.travelledDistanceKm / shipment.plannedDistanceKm)
      : 0;

  return (
    <div className="space-y-4">
      {/* ----------------------------------------------------------- header */}
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-4 p-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="font-mono text-xl text-[var(--color-signal)]">
                {shipment.trackingNumber}
              </h1>
              <Chip tone={statusTone(shipment.status)}>{shipment.status}</Chip>
              {shipment.isDemoData && <Chip tone="neutral">demo</Chip>}
            </div>
            <p className="mt-1.5 text-[0.8125rem] text-[var(--color-ink-dim)]">
              {shipment.origin.name}
              <span className="mx-2 text-[var(--color-ink-faint)]">→</span>
              {shipment.destination.name}
              <span className="mx-2 text-[var(--color-ink-faint)]">·</span>
              <span className="tnum font-mono">{fmt.num(shipment.plannedDistanceKm, 0)} km</span>
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {can('shipment:update') && (
              <button
                className="btn"
                onClick={() => recomputeEta.mutate()}
                disabled={recomputeEta.isPending}
              >
                {recomputeEta.isPending ? 'computing…' : 'recompute ETA'}
              </button>
            )}
            {can('ai:create') && (
              <>
                <button
                  className="btn"
                  onClick={() => predictDelay.mutate()}
                  disabled={predictDelay.isPending}
                >
                  {predictDelay.isPending ? 'predicting…' : 'predict delay'}
                </button>
                <button
                  className="btn"
                  onClick={() => detectAnomalies.mutate()}
                  disabled={detectAnomalies.isPending}
                >
                  {detectAnomalies.isPending ? 'scanning…' : 'scan anomalies'}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="grid gap-px border-t border-[var(--color-hairline)] bg-[var(--color-hairline)] sm:grid-cols-2 lg:grid-cols-5">
          <Cell label="Departed" value={fmt.dateTime(shipment.actualDepartureAt ?? shipment.plannedDepartureAt)} />
          <Cell label="Promised" value={fmt.dateTime(shipment.plannedArrivalAt)} />
          <Cell
            label="Estimated"
            value={fmt.dateTime(shipment.estimatedArrivalAt)}
            tone={eta?.lateness.certainlyLate ? 'alert' : eta?.lateness.isLate ? 'warn' : 'ok'}
          />
          <Cell
            label="Delay risk"
            value={shipment.delayProbability === null ? 'not computed' : fmt.pct(shipment.delayProbability)}
            tone={
              shipment.delayRisk === 'HIGH' ? 'alert' : shipment.delayRisk === 'MEDIUM' ? 'warn' : undefined
            }
          />
          <div className="bg-[var(--color-panel)] px-3.5 py-2.5">
            <div className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
              Distance covered
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="tnum font-mono text-[0.8125rem]">
                {fmt.num(shipment.travelledDistanceKm, 0)} / {fmt.num(shipment.plannedDistanceKm, 0)} km
              </span>
            </div>
            <div className="mt-1.5">
              <Meter value={progress} tone={shipment.status === 'DELAYED' ? 'alert' : 'signal'} />
            </div>
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          <Panel
            title="Track"
            actions={
              <span className="flex items-center gap-3">
                <span className="flex items-center gap-1.5">
                  <span className="h-px w-4 bg-[var(--color-info)]" /> planned
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-px w-4 bg-[var(--color-signal)]" /> actual
                </span>
              </span>
            }
            className="overflow-hidden"
          >
            <div ref={container} className="h-[340px] w-full" />
            <div className="border-t border-[var(--color-hairline)] px-3 py-1.5 font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
              {fmt.int(positionsTotal)} fixes recorded
              {positionsSampledEvery > 1 && ` · drawn every ${positionsSampledEvery}th to keep the map readable`}
              {positions.some((position) => position.isSimulated) && ' · simulated telemetry'}
            </div>
          </Panel>

          <Panel title="Event log">
            {events.length === 0 ? (
              <Empty title="No events yet" />
            ) : (
              <ol className="p-3.5">
                {[...events].reverse().map((event, index) => (
                  <li key={event.id} className="relative flex gap-3 pb-3.5 last:pb-0">
                    {index < events.length - 1 && (
                      <span className="absolute left-[3px] top-3 h-full w-px bg-[var(--color-hairline)]" />
                    )}
                    <span
                      className="relative mt-1.5 h-[7px] w-[7px] shrink-0 rounded-full"
                      style={{
                        background:
                          event.type === 'DELAY_DETECTED' || event.type === 'ANOMALY_DETECTED'
                            ? 'var(--color-alert)'
                            : event.type === 'DELIVERED' || event.type === 'ARRIVED'
                              ? 'var(--color-ok)'
                              : 'var(--color-hairline-bright)',
                      }}
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
                          {event.type.replace(/_/g, ' ')}
                        </span>
                        <span className="tnum font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
                          {fmt.dateTime(event.occurredAt)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[0.8125rem] text-[var(--color-ink-dim)]">
                        {event.description}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="ETA engine">
            {eta ? (
              <div className="space-y-3 p-3.5">
                <div>
                  <div className="tnum font-mono text-2xl text-[var(--color-ink)]">
                    {fmt.time(eta.estimatedArrival)}
                  </div>
                  <div className="text-[0.75rem] text-[var(--color-ink-dim)]">
                    {fmt.date(eta.estimatedArrival)} · {fmt.relative(eta.estimatedArrival)}
                  </div>
                </div>

                <div className="border-y border-[var(--color-hairline)] py-2.5">
                  <div className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
                    80% arrival window
                  </div>
                  <div className="tnum mt-1 font-mono text-[0.8125rem]">
                    {fmt.time(eta.arrivalWindow.earliest)} — {fmt.time(eta.arrivalWindow.latest)}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
                      confidence
                    </span>
                    <div className="flex-1">
                      <Meter
                        value={eta.confidenceScore}
                        tone={eta.confidenceScore > 0.6 ? 'ok' : eta.confidenceScore > 0.35 ? 'warn' : 'alert'}
                      />
                    </div>
                    <span className="tnum font-mono text-[0.6875rem]">
                      {fmt.pct(eta.confidenceScore)}
                    </span>
                  </div>
                </div>

                {eta.lateness.isLate && (
                  <div
                    className={`border px-2.5 py-2 text-[0.75rem] ${
                      eta.lateness.certainlyLate
                        ? 'border-[var(--color-alert-dim)] bg-[color-mix(in_srgb,var(--color-alert)_8%,transparent)] text-[var(--color-alert)]'
                        : 'border-[var(--color-warn-dim)] bg-[color-mix(in_srgb,var(--color-warn)_8%,transparent)] text-[var(--color-warn)]'
                    }`}
                  >
                    {eta.lateness.certainlyLate
                      ? `Certainly late — even the optimistic end of the window misses the promise by ${fmt.num(eta.lateness.minutesLate, 0)} min.`
                      : `Projected ${fmt.num(eta.lateness.minutesLate, 0)} min late, but the window still reaches the promise.`}
                  </div>
                )}

                <Explain reasons={eta.reasons} assumptions={eta.assumptions} />
              </div>
            ) : (
              <Empty
                title="No live ETA"
                hint="This shipment is complete, so there is nothing left to estimate."
              />
            )}
          </Panel>

          <Panel
            title="Anomalies"
            meta={anomalies.length > 0 ? <Chip tone="alert">{anomalies.length}</Chip> : null}
          >
            {detectAnomalies.data && (
              <div className="border-b border-[var(--color-hairline)] p-3.5">
                <Explain
                  summary={detectAnomalies.data.explanation.summary}
                  reasons={detectAnomalies.data.explanation.reasons}
                  assumptions={detectAnomalies.data.explanation.assumptions}
                />
              </div>
            )}
            {anomalies.length === 0 ? (
              <Empty title="None open" hint="Run a scan to check the track against every rule." />
            ) : (
              <ul className="divide-y divide-[var(--color-hairline)]">
                {anomalies.map((anomaly) => (
                  <li key={anomaly.id} className="p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[0.6875rem] uppercase tracking-[0.1em]">
                        {anomaly.type.replace(/_/g, ' ')}
                      </span>
                      <Chip tone={riskTone(anomaly.severity)}>{anomaly.severity}</Chip>
                    </div>
                    <p className="mt-1 text-[0.75rem] text-[var(--color-ink-dim)]">
                      {anomaly.description}
                    </p>
                    <div className="mt-1.5 font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
                      {fmt.dateTime(anomaly.detectedAt)} · severity score {fmt.num(anomaly.score, 2)}
                    </div>
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

function Cell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'alert';
}) {
  const colour = tone
    ? { ok: 'var(--color-ok)', warn: 'var(--color-warn)', alert: 'var(--color-alert)' }[tone]
    : 'var(--color-ink)';

  return (
    <div className="bg-[var(--color-panel)] px-3.5 py-2.5">
      <div className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
        {label}
      </div>
      <div className="tnum mt-1 font-mono text-[0.8125rem]" style={{ color: colour }}>
        {value}
      </div>
    </div>
  );
}

function upsertLine(
  map: MapLibreMap,
  id: string,
  coordinates: Array<[number, number]>,
  paint: Record<string, unknown>,
): void {
  const geojson: GeoJSON.Feature<GeoJSON.LineString> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates },
  };

  const source = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(geojson);
    return;
  }

  map.addSource(id, { type: 'geojson', data: geojson });
  map.addLayer({
    id,
    type: 'line',
    source: id,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: paint as never,
  });
}
