'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import maplibregl, { type Map as MapLibreMap, type Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api, getAccessToken } from '@/lib/api';
import { Chip, Empty, ErrorNote, Loading, Meter, Panel } from '@/components/ui';
import { useFormat, useI18n } from '@/lib/i18n';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'http://localhost:3001';

/* --------------------------------------------------------------------- types */

interface VesselPositionSummary {
  latitude: number;
  longitude: number;
  speedKnots: number | null;
  courseDegrees: number | null;
  recordedAt: string | null;
  source: string | null;
  ageMinutes: number | null;
}

interface SearchResult {
  id: string;
  name: string;
  formerNames: string[];
  imoNumber: string | null;
  mmsi: string | null;
  callSign: string | null;
  type: string;
  flag: string | null;
  status: string;
  operator: string | null;
  capacityTeu: number | null;
  matchScore: number;
  isOwnFleet: boolean;
  isDemoData: boolean;
  position: VesselPositionSummary | null;
  currentVoyage: {
    id: string;
    voyageNumber: string;
    status: string;
    from: { locode: string; name: string };
    to: { locode: string; name: string };
    estimatedArrivalAt: string | null;
  } | null;
}

interface SearchResponse {
  query: string;
  interpretedAs: string;
  count: number;
  results: SearchResult[];
}

interface FleetVessel {
  vesselId: string;
  name: string;
  imoNumber: string | null;
  mmsi: string | null;
  type: string;
  flag: string | null;
  status: string;
  latitude: number;
  longitude: number;
  speedKnots: number | null;
  courseDegrees: number | null;
  lastPositionAt: string;
  positionSource: string | null;
  isDemoData: boolean;
  isOwnFleet: boolean;
  voyage: {
    id: string;
    voyageNumber: string;
    status: string;
    from: string;
    to: string;
    toLocode: string;
    estimatedArrivalAt: string | null;
    plannedTrack: Array<{ latitude: number; longitude: number }> | null;
    remainingNm: number | null;
  } | null;
}

interface VoyageDetail {
  id: string;
  voyageNumber: string;
  status: string;
  scheduledDepartureAt: string;
  scheduledArrivalAt: string;
  estimatedArrivalAt: string | null;
  distanceNm: number | null;
  plannedTrack: Array<{ latitude: number; longitude: number }> | null;
  vessel: { id: string; name: string; imoNumber: string | null; type: string };
  originPort: { locode: string; name: string; country: string; latitude: number; longitude: number };
  destinationPort: { locode: string; name: string; country: string; latitude: number; longitude: number };
  progressPercent: number;
  remainingNm: number | null;
  coveredNm?: number;
  speedKnots?: number;
  computedEta: string | null;
  scheduleDeltaHours?: number;
  isBehindSchedule?: boolean;
  etaBasis: string;
  shipments: Array<{ id: string; trackingNumber: string; status: string }>;
}

interface TrackResponse {
  positions: Array<{
    latitude: number;
    longitude: number;
    speedKnots: number | null;
    recordedAt: string;
    source: string;
  }>;
  positionsTotal: number;
  sampledEvery: number;
}

interface MaritimeStatus {
  source: string;
  isLive: boolean;
  detail: string;
  fixesRecorded: number;
  fixesForUntrackedVessels: number;
  howToGoLive: string | null;
}

/* --------------------------------------------------------------------- style */

const OCEAN_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    // A deep blue ground so ocean reads as ocean where tiles are sparse mid-Atlantic.
    { id: 'background', type: 'background', paint: { 'background-color': '#070c12' } },
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: { 'raster-opacity': 0.34, 'raster-saturation': -0.7, 'raster-contrast': -0.15 },
    },
  ],
};

/* ---------------------------------------------------------------------- page */

export default function MaritimePage() {
  const { t } = useI18n();
  const fmt = useFormat();

  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Map<string, Marker>>(new Map());
  const socket = useRef<Socket | null>(null);

  const [ready, setReady] = useState(false);
  const [live, setLive] = useState(false);
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Debounced so typing "Gulf Sentinel" is one request, not thirteen.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 280);
    return () => clearTimeout(timer);
  }, [term]);

  const status = useQuery({
    queryKey: ['maritime', 'status'],
    queryFn: () => api<MaritimeStatus>('/maritime/status'),
    refetchInterval: 60_000,
  });

  const fleet = useQuery({
    queryKey: ['maritime', 'fleet'],
    queryFn: () => api<FleetVessel[]>('/maritime/fleet'),
    refetchInterval: 20_000,
  });

  const search = useQuery({
    queryKey: ['maritime', 'search', debounced],
    queryFn: () =>
      api<SearchResponse>(`/maritime/vessels/search?q=${encodeURIComponent(debounced)}&limit=25`),
    enabled: debounced.length >= 2,
    placeholderData: keepPreviousData,
  });

  const selected = useMemo(
    () => (fleet.data ?? []).find((vessel) => vessel.vesselId === selectedId) ?? null,
    [fleet.data, selectedId],
  );

  const voyage = useQuery({
    queryKey: ['maritime', 'voyage', selected?.voyage?.id],
    queryFn: () => api<VoyageDetail>(`/maritime/voyages/${selected!.voyage!.id}`),
    enabled: Boolean(selected?.voyage?.id),
    refetchInterval: 30_000,
  });

  const track = useQuery({
    queryKey: ['maritime', 'track', selectedId],
    queryFn: () => api<TrackResponse>(`/maritime/vessels/${selectedId}/track?maxPoints=400`),
    enabled: Boolean(selectedId),
    refetchInterval: 30_000,
  });

  /* ------------------------------------------------------------------- map */

  useEffect(() => {
    if (!container.current || map.current) return;

    const instance = new maplibregl.Map({
      container: container.current,
      style: OCEAN_STYLE,
      center: [-15, 25],
      zoom: 2.4,
      attributionControl: { compact: true },
    });
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.on('load', () => setReady(true));

    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
      setReady(false);
    };
  }, []);

  // Vessel markers
  useEffect(() => {
    if (!ready || !map.current || !fleet.data) return;
    const instance = map.current;

    for (const vessel of fleet.data) {
      const existing = markers.current.get(vessel.vesselId);
      if (existing) {
        existing.setLngLat([vessel.longitude, vessel.latitude]);
        continue;
      }

      const element = buildVesselMarker(vessel, vessel.vesselId === selectedId);
      element.addEventListener('click', () => setSelectedId(vessel.vesselId));

      markers.current.set(
        vessel.vesselId,
        new maplibregl.Marker({ element })
          .setLngLat([vessel.longitude, vessel.latitude])
          .addTo(instance),
      );
    }

    const alive = new Set(fleet.data.map((vessel) => vessel.vesselId));
    for (const [id, marker] of markers.current) {
      if (!alive.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    }
  }, [ready, fleet.data, selectedId]);

  // Planned and actual tracks for the selected vessel
  useEffect(() => {
    if (!ready || !map.current) return;
    const instance = map.current;

    const planned =
      voyage.data?.plannedTrack ?? selected?.voyage?.plannedTrack ?? null;
    const plannedCoords = planned?.map(
      (point) => [point.longitude, point.latitude] as [number, number],
    );
    const actualCoords = track.data?.positions.map(
      (position) => [position.longitude, position.latitude] as [number, number],
    );

    upsertLine(instance, 'sea-planned', plannedCoords ?? [], {
      'line-color': '#4ea8ff',
      'line-width': 1.4,
      'line-opacity': 0.55,
      'line-dasharray': [3, 3],
    });
    upsertLine(instance, 'sea-actual', actualCoords ?? [], {
      'line-color': '#ffb020',
      'line-width': 2.2,
      'line-opacity': 0.95,
    });

    if (selected && (plannedCoords?.length || actualCoords?.length)) {
      const bounds = new maplibregl.LngLatBounds();
      for (const coordinate of [...(plannedCoords ?? []), ...(actualCoords ?? [])]) {
        bounds.extend(coordinate);
      }
      if (!bounds.isEmpty()) instance.fitBounds(bounds, { padding: 60, duration: 800, maxZoom: 6 });
    }
  }, [ready, selected, voyage.data, track.data]);

  /* ---------------------------------------------------------------- socket */

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;

    const connection = io(`${WS_URL}/tracking`, { auth: { token }, transports: ['websocket'] });
    connection.on('connect', () => setLive(true));
    connection.on('disconnect', () => setLive(false));
    connection.on('vessel:position', (position: { vesselId: string; latitude: number; longitude: number }) => {
      // Move the marker directly: a dozen ships updating every few seconds should not trigger a
      // React render each time.
      markers.current.get(position.vesselId)?.setLngLat([position.longitude, position.latitude]);
    });

    socket.current = connection;
    return () => {
      connection.close();
      socket.current = null;
    };
  }, []);

  const showingSearch = debounced.length >= 2;

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------- header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">{t('sea.title')}</h1>
          <p className="mt-0.5 max-w-3xl text-[0.8125rem] leading-relaxed text-[var(--color-ink-dim)]">
            {t('sea.intro')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`live-dot ${status.data?.isLive ? '' : 'live-dot-stale'}`} />
          <Chip tone={status.data?.isLive ? 'ok' : 'neutral'}>
            {status.data?.isLive ? t('sea.liveAis') : t('sea.simulated')}
          </Chip>
        </div>
      </div>

      {/* ---------------------------------------------------------- search */}
      <Panel>
        <div className="p-3.5">
          <div className="relative">
            <input
              className="field !py-2.5 !pl-9 !text-sm"
              placeholder={t('sea.searchPlaceholder')}
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              autoFocus
            />
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-ink-faint)]"
            >
              <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M11 11 L14.5 14.5" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </div>

          <p className="mt-2 text-[0.6875rem] leading-relaxed text-[var(--color-ink-faint)]">
            {t('sea.searchHint')}
          </p>

          {showingSearch && search.data && (
            <div className="mt-3 border-t border-[var(--color-hairline)] pt-2.5">
              <div className="mb-2 font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
                {t('sea.interpretedAs')}: {search.data.interpretedAs} ·{' '}
                {t('sea.results', { n: search.data.count })}
              </div>

              {search.data.results.length === 0 ? (
                <Empty title={t('sea.noResults')} hint={t('sea.noResultsHint')} />
              ) : (
                <ul className="divide-y divide-[var(--color-hairline)]">
                  {search.data.results.map((result) => (
                    <li key={result.id}>
                      <button
                        onClick={() => {
                          setSelectedId(result.id);
                          if (result.position && map.current) {
                            map.current.flyTo({
                              center: [result.position.longitude, result.position.latitude],
                              zoom: 5,
                              duration: 1100,
                            });
                          }
                        }}
                        className="flex w-full items-center justify-between gap-4 px-1.5 py-2 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--color-signal)_6%,transparent)]"
                      >
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-[0.875rem] font-medium">{result.name}</span>
                            <Chip tone={result.isOwnFleet ? 'signal' : 'neutral'}>
                              {result.isOwnFleet ? t('sea.ownFleet') : t('sea.publicAis')}
                            </Chip>
                            {result.isDemoData && <Chip tone="neutral">{t('common.demoData')}</Chip>}
                          </span>
                          <span className="mt-0.5 block font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
                            {t('sea.imo')} {result.imoNumber ?? '—'} · {t('sea.mmsi')}{' '}
                            {result.mmsi ?? '—'} · {result.type.replace(/_/g, ' ').toLowerCase()}
                            {result.flag ? ` · ${result.flag}` : ''}
                          </span>
                          {result.currentVoyage && (
                            <span className="mt-0.5 block text-[0.6875rem] text-[var(--color-ink-dim)]">
                              {result.currentVoyage.from.name}
                              <span className="mx-1.5 text-[var(--color-ink-faint)]">→</span>
                              {result.currentVoyage.to.name}
                            </span>
                          )}
                        </span>

                        <span className="shrink-0 text-right">
                          {result.position ? (
                            <>
                              <span className="tnum block font-mono text-[0.75rem]">
                                {fmt.num(result.position.speedKnots, 1)} {t('sea.knots')}
                              </span>
                              <span className="block font-mono text-[0.5625rem] text-[var(--color-ink-faint)]">
                                {fmt.relative(result.position.recordedAt)}
                              </span>
                            </>
                          ) : (
                            <span className="font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
                              {t('common.notComputed')}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </Panel>

      {/* ------------------------------------------------------------- body */}
      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <Panel
          title={t('sea.track')}
          meta={
            <span className="flex items-center gap-1.5">
              <span className={`live-dot ${live ? '' : 'live-dot-stale'}`} />
              <span>{live ? 'streaming' : 'polling'}</span>
            </span>
          }
          actions={
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1.5">
                <span className="h-px w-4 bg-[var(--color-info)]" /> {t('sea.plannedTrack')}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-px w-4 bg-[var(--color-signal)]" /> {t('sea.actualTrack')}
              </span>
            </span>
          }
          className="overflow-hidden"
        >
          <div ref={container} className="h-[470px] w-full" />
          {status.data && !status.data.isLive && (
            <div className="border-t border-[var(--color-hairline)] px-3 py-2 text-[0.6875rem] leading-relaxed text-[var(--color-ink-faint)]">
              {t('sea.sourceSimulated')}
            </div>
          )}
        </Panel>

        <div className="space-y-4">
          {selected ? (
            <>
              <Panel
                title={t('sea.voyage')}
                actions={
                  <button
                    onClick={() => setSelectedId(null)}
                    className="hover:text-[var(--color-signal)]"
                  >
                    {t('common.close')}
                  </button>
                }
              >
                <div className="space-y-3 p-3.5">
                  <div>
                    <div className="font-mono text-lg text-[var(--color-signal)]">
                      {selected.name}
                    </div>
                    <div className="font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
                      {t('sea.imo')} {selected.imoNumber ?? '—'} · {t('sea.mmsi')}{' '}
                      {selected.mmsi ?? '—'}
                    </div>
                  </div>

                  <dl className="space-y-1.5 border-t border-[var(--color-hairline)] pt-2.5">
                    <Row label={t('sea.type')} value={selected.type.replace(/_/g, ' ').toLowerCase()} />
                    <Row label={t('sea.flag')} value={selected.flag ?? '—'} />
                    <Row
                      label={t('sea.speed')}
                      value={`${fmt.num(selected.speedKnots, 1)} ${t('sea.knots')}`}
                    />
                    <Row
                      label={t('sea.course')}
                      value={selected.courseDegrees === null ? '—' : `${fmt.num(selected.courseDegrees, 0)}°`}
                    />
                    <Row label={t('sea.lastFix')} value={fmt.relative(selected.lastPositionAt)} />
                    <Row
                      label={t('sea.position')}
                      value={`${selected.latitude.toFixed(3)}, ${selected.longitude.toFixed(3)}`}
                    />
                  </dl>

                  {voyage.data ? (
                    <div className="space-y-2.5 border-t border-[var(--color-hairline)] pt-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[0.75rem]">
                          {voyage.data.voyageNumber}
                        </span>
                        <Chip tone="info">{voyage.data.status}</Chip>
                      </div>

                      <div className="text-[0.8125rem] text-[var(--color-ink-dim)]">
                        {voyage.data.originPort.name}
                        <span className="mx-1.5 text-[var(--color-ink-faint)]">→</span>
                        {voyage.data.destinationPort.name}
                      </div>

                      <div>
                        <div className="mb-1 flex items-baseline justify-between">
                          <span className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
                            {t('sea.progress')}
                          </span>
                          <span className="tnum font-mono text-[0.75rem]">
                            {voyage.data.progressPercent}%
                          </span>
                        </div>
                        <Meter value={voyage.data.progressPercent / 100} tone="signal" />
                      </div>

                      <dl className="space-y-1.5">
                        <Row
                          label={t('sea.remaining')}
                          value={`${fmt.int(voyage.data.remainingNm)} ${t('sea.nauticalMiles')}`}
                        />
                        <Row
                          label={t('sea.scheduled')}
                          value={fmt.dateTime(voyage.data.scheduledArrivalAt)}
                        />
                        <Row label={t('sea.eta')} value={fmt.dateTime(voyage.data.computedEta)} />
                      </dl>

                      {voyage.data.scheduleDeltaHours !== undefined && (
                        <div
                          className={`border px-2.5 py-2 text-[0.75rem] ${
                            voyage.data.isBehindSchedule
                              ? 'border-[var(--color-alert-dim)] bg-[color-mix(in_srgb,var(--color-alert)_8%,transparent)] text-[var(--color-alert)]'
                              : 'border-[var(--color-ok-dim)] bg-[color-mix(in_srgb,var(--color-ok)_7%,transparent)] text-[var(--color-ok)]'
                          }`}
                        >
                          {fmt.num(Math.abs(voyage.data.scheduleDeltaHours), 1)} h{' '}
                          {voyage.data.scheduleDeltaHours > 0
                            ? t('sea.behindSchedule')
                            : t('sea.aheadOfSchedule')}
                        </div>
                      )}

                      <div className="border-t border-[var(--color-hairline)] pt-2">
                        <div className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
                          {t('sea.etaBasis')}
                        </div>
                        <p className="mt-1 text-[0.6875rem] leading-relaxed text-[var(--color-ink-dim)]">
                          {voyage.data.etaBasis}
                        </p>
                      </div>

                      {voyage.data.shipments.length > 0 && (
                        <div className="border-t border-[var(--color-hairline)] pt-2">
                          <div className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
                            {t('ship.title')}
                          </div>
                          <ul className="mt-1 space-y-0.5">
                            {voyage.data.shipments.map((shipment) => (
                              <li
                                key={shipment.id}
                                className="font-mono text-[0.6875rem] text-[var(--color-ink-dim)]"
                              >
                                {shipment.trackingNumber} · {shipment.status}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="border-t border-[var(--color-hairline)] pt-3 text-[0.75rem] text-[var(--color-ink-faint)]">
                      {t('sea.noVoyage')}
                    </p>
                  )}

                  {track.data && (
                    <p className="border-t border-[var(--color-hairline)] pt-2 font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
                      {fmt.int(track.data.positionsTotal)} fixes
                      {track.data.sampledEvery > 1 && ` · 1/${track.data.sampledEvery}`}
                    </p>
                  )}
                </div>
              </Panel>
            </>
          ) : (
            <Panel title={t('sea.fleet')}>
              {fleet.isError ? (
                <ErrorNote error={fleet.error} />
              ) : fleet.isLoading ? (
                <Loading label={t('common.loading')} />
              ) : (fleet.data ?? []).length === 0 ? (
                <Empty title={t('sea.selectVessel')} hint={t('sea.selectVesselHint')} />
              ) : (
                <ul className="max-h-[470px] divide-y divide-[var(--color-hairline)] overflow-y-auto">
                  {(fleet.data ?? []).map((vessel) => (
                    <li key={vessel.vesselId}>
                      <button
                        onClick={() => {
                          setSelectedId(vessel.vesselId);
                          map.current?.flyTo({
                            center: [vessel.longitude, vessel.latitude],
                            zoom: 5,
                            duration: 1000,
                          });
                        }}
                        className="flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left hover:bg-[color-mix(in_srgb,var(--color-signal)_5%,transparent)]"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[0.8125rem]">{vessel.name}</span>
                          <span className="block truncate text-[0.625rem] text-[var(--color-ink-faint)]">
                            {vessel.voyage
                              ? `${vessel.voyage.from} → ${vessel.voyage.to}`
                              : t('sea.noVoyage')}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="tnum block font-mono text-[0.6875rem]">
                            {fmt.num(vessel.speedKnots, 1)} {t('sea.knots')}
                          </span>
                          {vessel.voyage?.remainingNm !== null &&
                            vessel.voyage?.remainingNm !== undefined && (
                              <span className="tnum block font-mono text-[0.5625rem] text-[var(--color-ink-faint)]">
                                {fmt.int(vessel.voyage.remainingNm)} {t('sea.nauticalMiles')}
                              </span>
                            )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          {status.data && (
            <Panel title="AIS">
              <dl className="space-y-1.5 p-3.5">
                <Row label="source" value={status.data.source} />
                <Row label="fixes" value={fmt.int(status.data.fixesRecorded)} />
                {status.data.isLive && (
                  <Row
                    label="untracked"
                    value={fmt.int(status.data.fixesForUntrackedVessels)}
                  />
                )}
              </dl>
              {status.data.howToGoLive && (
                <p className="border-t border-[var(--color-hairline)] px-3.5 py-2.5 text-[0.6875rem] leading-relaxed text-[var(--color-ink-faint)]">
                  {status.data.howToGoLive}
                </p>
              )}
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ helpers */

function buildVesselMarker(vessel: FleetVessel, selected: boolean): HTMLElement {
  const stationary = (vessel.speedKnots ?? 0) < 0.5;
  const colour = selected
    ? 'var(--color-signal)'
    : vessel.isOwnFleet
      ? 'var(--color-ok)'
      : 'var(--color-info)';

  // Built with DOM/SVG calls, never innerHTML: vessel names come from an external AIS feed and
  // are entirely attacker-controlled text.
  const heading = Number.isFinite(vessel.courseDegrees) ? Number(vessel.courseDegrees) : 0;

  const element = document.createElement('div');
  element.style.cursor = 'pointer';
  element.title = vessel.name;

  const frame = document.createElement('div');
  frame.style.cssText = 'position:relative;width:20px;height:20px';

  const rotor = document.createElement('div');
  rotor.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transition:transform .5s ease';
  rotor.style.transform = `rotate(${heading}deg)`;

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 16 16');

  // A hull outline rather than a chevron: at a glance it reads as a ship, not a truck.
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M8 0.5 L11 6 L11 12 L8 14.5 L5 12 L5 6 Z');
  path.setAttribute('fill', colour);
  path.setAttribute('stroke', 'var(--color-void)');
  path.setAttribute('stroke-width', '1');

  svg.append(path);
  rotor.append(svg);
  frame.append(rotor);

  if (!stationary) {
    const halo = document.createElement('div');
    halo.style.cssText = 'position:absolute;inset:-5px;opacity:.3;border-radius:999px';
    halo.style.border = `1px solid ${colour}`;
    frame.append(halo);
  }

  element.append(frame);
  return element;
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
  if (coordinates.length === 0) return;

  map.addSource(id, { type: 'geojson', data: geojson });
  map.addLayer({
    id,
    type: 'line',
    source: id,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: paint as never,
  });
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
        {label}
      </dt>
      <dd className="tnum truncate text-right font-mono text-[0.75rem] text-[var(--color-ink-dim)]">
        {value}
      </dd>
    </div>
  );
}
