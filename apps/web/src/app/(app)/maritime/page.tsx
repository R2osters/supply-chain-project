'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FlaskConical, Radio, Search, Ship } from 'lucide-react';
import maplibregl, { type Map as MapLibreMap, type Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api, getAccessToken } from '@/lib/api';
import { useFormat, useI18n } from '@/lib/i18n';
import { basemapStyle, useBasemapTheme, watchBasemapTiles } from '@/lib/map-style';
import { isTrackAnimating, positionAt, startTrack, type MotionTrack } from '@/lib/motion';
import { usePalette, type Palette } from '@/lib/theme';
import {
  Banner,
  Chip,
  DemoTag,
  Empty,
  ErrorNote,
  Facts,
  Legend,
  Loading,
  PageHeader,
  Panel,
  Provenance,
  SeverityIcon,
} from '@/components/ui';
import { humanise } from '../shipments/detail/_components/labels';
import type {
  FleetVessel,
  MaritimeStatus,
  SearchResponse,
  TrackResponse,
  VoyageDetail,
  VoyageListRow,
} from './_components/types';
import { AisProvenance, VoyagePanel } from './_components/voyage-panel';
import {
  AT_RISK_HOURS,
  VESSEL_COLOUR,
  buildVesselMarker,
  isSimulatedVessel,
  paintVesselMarker,
  rotateVessel,
  vesselState,
} from './_components/vessel-marker';
import { wsUrl } from '@/lib/runtime-config';

const PLANNED = 'sea-planned';
const ACTUAL = 'sea-actual';
const KNOTS_TO_KMH = 1.852;

interface VesselMotion {
  track: MotionTrack;
  lastFixAt: number;
  fixTime: number;
}

/** Next requires a Suspense boundary around `useSearchParams` for the static pass. */
export default function MaritimePage() {
  return (
    <Suspense fallback={<Loading rows={6} />}>
      <Maritime />
    </Suspense>
  );
}

function Maritime() {
  const { t } = useI18n();
  const fmt = useFormat();
  const palette = usePalette();
  const searchParams = useSearchParams();

  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Map<string, Marker>>(new Map());
  const motions = useRef<Map<string, VesselMotion>>(new Map());
  const frame = useRef<number | null>(null);
  const socket = useRef<Socket | null>(null);
  const paletteRef = useRef<Palette>(palette);
  paletteRef.current = palette;

  const [ready, setReady] = useState(false);
  const [live, setLive] = useState(false);
  // The command palette lands here with `?q=`: start the search from it.
  const [term, setTerm] = useState(() => searchParams.get('q') ?? '');
  const [debounced, setDebounced] = useState(() => (searchParams.get('q') ?? '').trim());
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

  // Schedules live on the voyage rows, not on the fleet snapshot: this is what lets the header
  // say how many ships run behind without opening each voyage.
  const voyages = useQuery({
    queryKey: ['maritime', 'voyages', 'schedule'],
    queryFn: () => api<{ data: VoyageListRow[] }>('/maritime/voyages?limit=200'),
    refetchInterval: 60_000,
  });

  const search = useQuery({
    queryKey: ['maritime', 'search', debounced],
    queryFn: () =>
      api<SearchResponse>(`/maritime/vessels/search?q=${encodeURIComponent(debounced)}&limit=25`),
    enabled: debounced.length >= 2,
    placeholderData: keepPreviousData,
  });

  const vessels = useMemo(() => fleet.data ?? [], [fleet.data]);
  const selected = useMemo(
    () => vessels.find((vessel) => vessel.vesselId === selectedId) ?? null,
    [vessels, selectedId],
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

  /** Hours behind schedule per voyage id (positive = late). */
  const deltaByVoyage = useMemo(() => {
    const result = new Map<string, number>();
    for (const row of voyages.data?.data ?? []) {
      if (!row.estimatedArrivalAt) continue;
      result.set(row.id, (Date.parse(row.estimatedArrivalAt) - Date.parse(row.scheduledArrivalAt)) / 3_600_000);
    }
    return result;
  }, [voyages.data]);

  const deltaFor = useCallback(
    (vessel: FleetVessel): number | null => {
      if (!vessel.voyage) return null;
      // The open voyage's live computation beats the stored estimate.
      if (vessel.vesselId === selectedId && voyage.data?.scheduleDeltaHours !== undefined) {
        return voyage.data.scheduleDeltaHours;
      }
      return deltaByVoyage.get(vessel.voyage.id) ?? null;
    },
    [deltaByVoyage, selectedId, voyage.data],
  );

  const lateCount = useMemo(
    () => vessels.filter((vessel) => (deltaFor(vessel) ?? 0) >= AT_RISK_HOURS).length,
    [vessels, deltaFor],
  );

  /* ------------------------------------------------------------------- map */

  useEffect(() => {
    if (!container.current || map.current) return;

    const instance = new maplibregl.Map({
      container: container.current,
      style: basemapStyle(paletteRef.current, { ocean: true }),
      center: [-15, 25],
      zoom: 2.4,
      attributionControl: { compact: true },
    });
    watchBasemapTiles(instance);
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.on('load', () => setReady(true));

    map.current = instance;
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      instance.remove();
      map.current = null;
      markers.current.clear();
      motions.current.clear();
      setReady(false);
    };
  }, []);

  useBasemapTheme(ready ? map.current : null, palette, { ocean: true });

  // Track colours are literal GL paint: repaint on theme change.
  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    if (instance.getLayer(PLANNED)) instance.setPaintProperty(PLANNED, 'line-color', palette.info);
    if (instance.getLayer(ACTUAL)) instance.setPaintProperty(ACTUAL, 'line-color', palette.ink);
  }, [ready, palette]);

  /* ---------------------------------------------------------------- motion */

  // Same glide as the road map (lib/motion.ts): AIS fixes arrive minutes apart, and a ship that
  // jumps reads as a fault.
  const animate = (): void => {
    const now = performance.now();
    let pending = false;
    for (const [vesselId, motion] of motions.current) {
      const marker = markers.current.get(vesselId);
      if (!marker) continue;
      const point = positionAt(motion.track, now);
      marker.setLngLat([point.longitude, point.latitude]);
      if (isTrackAnimating(motion.track, now)) pending = true;
    }
    frame.current = pending ? requestAnimationFrame(animate) : null;
  };

  const applyFix = (
    vesselId: string,
    fix: { latitude: number; longitude: number; speedKnots: number | null; courseDegrees: number | null; recordedAt: string | null },
  ): void => {
    const marker = markers.current.get(vesselId);
    if (!marker) return;
    const fixTime = fix.recordedAt ? Date.parse(fix.recordedAt) : Date.now();
    const previous = motions.current.get(vesselId);
    if (previous && previous.fixTime === fixTime) return;

    const now = performance.now();
    const drawn = marker.getLngLat();
    const interval = previous ? now - previous.lastFixAt : null;
    motions.current.set(vesselId, {
      track: startTrack(
        previous ? { latitude: drawn.lat, longitude: drawn.lng } : null,
        {
          latitude: fix.latitude,
          longitude: fix.longitude,
          speedKmh: fix.speedKnots === null ? null : fix.speedKnots * KNOTS_TO_KMH,
          headingDegrees: fix.courseDegrees,
        },
        now,
        interval,
      ),
      lastFixAt: now,
      fixTime,
    });
    rotateVessel(marker, fix.courseDegrees);
    if (frame.current === null) frame.current = requestAnimationFrame(animate);
  };

  // Vessel markers
  useEffect(() => {
    if (!ready || !map.current || !fleet.data) return;
    const instance = map.current;

    for (const vessel of fleet.data) {
      if (!markers.current.has(vessel.vesselId)) {
        const element = buildVesselMarker(vessel, () => setSelectedId(vessel.vesselId));
        markers.current.set(
          vessel.vesselId,
          new maplibregl.Marker({ element }).setLngLat([vessel.longitude, vessel.latitude]).addTo(instance),
        );
      }
      applyFix(vessel.vesselId, { ...vessel, recordedAt: vessel.lastPositionAt });
    }

    const alive = new Set(fleet.data.map((vessel) => vessel.vesselId));
    for (const [id, marker] of markers.current) {
      if (!alive.has(id)) {
        marker.remove();
        markers.current.delete(id);
        motions.current.delete(id);
      }
    }
    // applyFix only touches refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fleet.data]);

  // State colour and selection ring.
  useEffect(() => {
    if (!ready) return;
    for (const vessel of vessels) {
      const marker = markers.current.get(vessel.vesselId);
      if (!marker) continue;
      paintVesselMarker(marker.getElement(), vessel, vesselState(vessel, deltaFor(vessel)), vessel.vesselId === selectedId);
    }
  }, [ready, vessels, selectedId, deltaFor]);

  // Planned and actual tracks for the selected vessel
  useEffect(() => {
    if (!ready || !map.current) return;
    const instance = map.current;
    const colours = paletteRef.current;

    const planned = voyage.data?.plannedTrack ?? selected?.voyage?.plannedTrack ?? null;
    const plannedCoords = planned?.map((point) => [point.longitude, point.latitude] as [number, number]);
    const actualCoords = track.data?.positions.map(
      (position) => [position.longitude, position.latitude] as [number, number],
    );

    upsertLine(instance, PLANNED, selected ? (plannedCoords ?? []) : [], {
      'line-color': colours.info,
      'line-width': 1.6,
      'line-opacity': 0.9,
      'line-dasharray': [3, 3],
    });
    upsertLine(instance, ACTUAL, selected ? (actualCoords ?? []) : [], {
      'line-color': colours.ink,
      'line-width': 2.2,
      'line-opacity': 0.95,
    });

    if (selected && (plannedCoords?.length || actualCoords?.length)) {
      const bounds = new maplibregl.LngLatBounds();
      for (const coordinate of [...(plannedCoords ?? []), ...(actualCoords ?? [])]) bounds.extend(coordinate);
      if (!bounds.isEmpty()) instance.fitBounds(bounds, { padding: 60, duration: 800, maxZoom: 6 });
    }
  }, [ready, selected, voyage.data, track.data]);

  /* ---------------------------------------------------------------- socket */

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;

    const connection = io(`${wsUrl()}/tracking`, { auth: { token }, transports: ['websocket'] });
    connection.on('connect', () => setLive(true));
    connection.on('disconnect', () => setLive(false));
    connection.on('connect_error', () => setLive(false));
    connection.on(
      'vessel:position',
      (position: {
        vesselId: string;
        latitude: number;
        longitude: number;
        speedKnots?: number | null;
        courseDegrees?: number | null;
        recordedAt?: string | null;
      }) => {
        // Move the marker directly: a dozen ships updating every few seconds should not trigger
        // a React render each time.
        applyFix(position.vesselId, {
          latitude: position.latitude,
          longitude: position.longitude,
          speedKnots: position.speedKnots ?? null,
          courseDegrees: position.courseDegrees ?? null,
          recordedAt: position.recordedAt ?? null,
        });
      },
    );

    socket.current = connection;
    return () => {
      connection.close();
      socket.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flyTo = (latitude: number, longitude: number) =>
    map.current?.flyTo({ center: [longitude, latitude], zoom: 5, duration: 1000 });

  // Esc closes the voyage panel (charte §10). Ignored while typing in the search box.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---------------------------------------------------------------- render */

  const showingSearch = debounced.length >= 2;
  const aisSimulated = status.data ? !status.data.isLive : false;
  const title = fleet.isLoading
    ? t('sea.v3.title.loading')
    : vessels.length === 0
      ? t('sea.v3.title.none')
      : voyages.isError
        ? t('sea.v3.title.tracked', { n: vessels.length })
        : lateCount > 0
          ? t('sea.v3.title.late', { n: lateCount })
          : t('sea.v3.title.onTime', { n: vessels.length });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={
          <span className="flex items-center gap-1.5">
            <Ship className="h-3.5 w-3.5" />
            {t('sea.v3.kicker')}
          </span>
        }
        title={
          <span className="flex items-center gap-2.5">
            {lateCount > 0 && <SeverityIcon severity="warning" size={22} />}
            {title}
          </span>
        }
        description={t('sea.v3.description')}
        meta={
          <>
            {status.data &&
              (status.data.isLive ? (
                <Provenance kind="live" label={t('sea.liveAis')} />
              ) : (
                <Provenance kind="demo" label={t('sea.v3.aisSimulated')} />
              ))}
            {live ? <Provenance kind="live" label={t('sea.v3.streaming')} /> : <Provenance kind="poll" seconds={20} />}
          </>
        }
      />

      {aisSimulated && (
        <Banner tone="demo" icon={FlaskConical} title={t('sea.v3.simulatedTitle')}>
          {t('sea.sourceSimulated')}
        </Banner>
      )}

      {/* ---------------------------------------------------------- search */}
      <Panel icon={Search} title={t('common.search')}>
        <div className="flex flex-col gap-2 px-5 pb-5 pt-2">
          <div className="relative">
            <input
              className="field !pl-9"
              placeholder={t('sea.searchPlaceholder')}
              aria-label={t('sea.searchPlaceholder')}
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              autoFocus
            />
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]"
            />
          </div>
          <p className="m-0 text-[12px] leading-relaxed text-[var(--color-muted)]">{t('sea.searchHint')}</p>

          {showingSearch && search.isError && <ErrorNote error={search.error} onRetry={() => void search.refetch()} />}
          {showingSearch && search.isLoading && <Loading rows={3} />}

          {showingSearch && search.data && (
            <div className="fade-in mt-1 flex flex-col gap-2 border-t border-[var(--color-line)] pt-3">
              <span className="t-label">
                {t('sea.interpretedAs')}: {search.data.interpretedAs} · {t('sea.results', { n: search.data.count })}
              </span>

              {search.data.results.length === 0 ? (
                <Empty icon={Search} title={t('sea.noResults')} hint={t('sea.noResultsHint')} />
              ) : (
                <ul className="stagger m-0 flex list-none flex-col p-0">
                  {search.data.results.map((result) => (
                    <li key={result.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(result.id);
                          if (result.position) flyTo(result.position.latitude, result.position.longitude);
                        }}
                        aria-pressed={selectedId === result.id}
                        className="flex w-full items-center justify-between gap-4 rounded-[var(--radius-md)] px-2.5 py-2.5 text-left transition-colors duration-100 hover:bg-[var(--color-surface-2)] aria-[pressed=true]:bg-[var(--color-surface-2)]"
                      >
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-[14px] font-medium">{result.name}</span>
                            <Chip tone={result.isOwnFleet ? 'signal' : 'neutral'}>
                              {result.isOwnFleet ? t('sea.ownFleet') : t('sea.publicAis')}
                            </Chip>
                            {result.isDemoData && <DemoTag />}
                          </span>
                          <span className="t-data text-[11px] text-[var(--color-muted)]">
                            {t('sea.imo')} {result.imoNumber ?? '—'} · {t('sea.mmsi')} {result.mmsi ?? '—'} ·{' '}
                            {humanise(result.type)}
                            {result.flag ? ` · ${result.flag}` : ''}
                          </span>
                          {result.currentVoyage && (
                            <span className="text-[12px] text-[var(--color-muted)]">
                              {result.currentVoyage.from.name}
                              <span className="mx-1.5 text-[var(--color-dim)]">→</span>
                              {result.currentVoyage.to.name}
                              {result.currentVoyage.estimatedArrivalAt && (
                                <span className="t-data ml-2 text-[11px]">
                                  {t('sea.eta')} {fmt.dateTime(result.currentVoyage.estimatedArrivalAt)}
                                </span>
                              )}
                            </span>
                          )}
                        </span>

                        <span className="flex shrink-0 flex-col items-end gap-1">
                          {result.position ? (
                            <>
                              <span className="t-data text-[12.5px]">
                                {fmt.num(result.position.speedKnots, 1)} {t('sea.knots')}
                              </span>
                              <AisProvenance
                                at={result.position.recordedAt}
                                simulated={result.isDemoData || result.position.source === 'SIMULATOR'}
                                live={live}
                              />
                            </>
                          ) : (
                            <span className="t-data text-[11px] text-[var(--color-dim)]">{t('common.notComputed')}</span>
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
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel
          icon={Ship}
          title={t('sea.track')}
          actions={
            <Legend
              items={[
                { label: t('sea.plannedTrack'), colour: 'var(--color-info)', shape: 'dash' },
                { label: t('sea.actualTrack'), colour: 'var(--color-ink)', shape: 'line' },
              ]}
            />
          }
          className="overflow-hidden"
        >
          <div className="relative">
            <div ref={container} className="h-[520px] w-full bg-[var(--color-map)]" role="region" aria-label={t('sea.track')} />
            <div className="map-card absolute bottom-3 left-3 hidden px-3.5 py-2.5 md:block">
              <Legend
                items={[
                  { label: t('sea.v3.legend.moving'), colour: VESSEL_COLOUR.moving },
                  { label: t('sea.v3.legend.stopped'), colour: VESSEL_COLOUR.stopped },
                  { label: t('sea.v3.legend.atRisk'), colour: VESSEL_COLOUR.atRisk },
                  { label: t('sea.v3.legend.late'), colour: VESSEL_COLOUR.delayed },
                  { label: t('sea.v3.legend.simulated'), colour: 'var(--color-sim)', shape: 'dash' },
                ]}
              />
            </div>
          </div>
        </Panel>

        <div className="flex min-w-0 flex-col gap-6">
          {selected ? (
            <section key={selected.vesselId} className="panel slide-in-right" aria-label={t('sea.voyage')}>
              <VoyagePanel
                vessel={selected}
                voyage={voyage.data}
                voyageLoading={voyage.isLoading && Boolean(selected.voyage)}
                track={track.data}
                live={live}
                onClose={() => setSelectedId(null)}
              />
            </section>
          ) : (
            <Panel icon={Ship} title={t('sea.fleet')} meta={<span className="t-data text-[11px] text-[var(--color-dim)]">{vessels.length}</span>}>
              {fleet.isError ? (
                <ErrorNote error={fleet.error} onRetry={() => void fleet.refetch()} />
              ) : fleet.isLoading ? (
                <Loading label={t('common.loading')} rows={6} />
              ) : vessels.length === 0 ? (
                <Empty icon={Ship} title={t('sea.selectVessel')} hint={t('sea.selectVesselHint')} />
              ) : (
                <ul className="stagger m-0 flex max-h-[520px] list-none flex-col overflow-y-auto p-0 pb-2">
                  {vessels.map((vessel) => {
                    const delta = deltaFor(vessel);
                    const state = vesselState(vessel, delta);
                    return (
                      <li key={vessel.vesselId}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedId(vessel.vesselId);
                            flyTo(vessel.latitude, vessel.longitude);
                          }}
                          className="grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-3 px-5 py-2.5 text-left transition-colors duration-100 hover:bg-[var(--color-surface-2)]"
                        >
                          <span className="mt-0.5">
                            {state === 'delayed' ? (
                              <SeverityIcon severity="critical" size={14} />
                            ) : state === 'atRisk' ? (
                              <SeverityIcon severity="warning" size={14} />
                            ) : (
                              <span
                                className="mt-1 block h-2 w-2 rounded-full"
                                style={{ background: VESSEL_COLOUR[state] }}
                              />
                            )}
                          </span>
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="flex items-center gap-2">
                              <span className="truncate text-[13.5px] font-medium">{vessel.name}</span>
                            </span>
                            <span className="truncate text-[12px] text-[var(--color-muted)]">
                              {vessel.voyage ? `${vessel.voyage.from} → ${vessel.voyage.to}` : t('sea.noVoyage')}
                            </span>
                            <AisProvenance at={vessel.lastPositionAt} simulated={isSimulatedVessel(vessel)} live={live} />
                          </span>
                          <span className="flex shrink-0 flex-col items-end gap-0.5">
                            <span className="t-data text-[12px]">
                              {fmt.num(vessel.speedKnots, 1)} {t('sea.knots')}
                            </span>
                            {vessel.voyage?.remainingNm !== null && vessel.voyage?.remainingNm !== undefined && (
                              <span className="t-data text-[11px] text-[var(--color-dim)]">
                                {fmt.int(vessel.voyage.remainingNm)} {t('sea.nauticalMiles')}
                              </span>
                            )}
                            {vessel.voyage?.estimatedArrivalAt && (
                              <span className="t-data text-[11px] text-[var(--color-muted)]">
                                {t('sea.eta')} {fmt.dateTime(vessel.voyage.estimatedArrivalAt)}
                              </span>
                            )}
                            {delta !== null && Math.abs(delta) >= 1 && (
                              <span
                                className="t-data text-[11px]"
                                style={{ color: delta >= AT_RISK_HOURS ? VESSEL_COLOUR[state] : 'var(--color-muted)' }}
                              >
                                {delta > 0 ? '+' : '−'}
                                {fmt.num(Math.abs(delta), 0)} h
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          )}

          <Panel
            icon={Radio}
            title={t('sea.v3.aisSource')}
            meta={
              status.data ? (
                status.data.isLive ? (
                  <Provenance kind="live" label={t('sea.liveAis')} />
                ) : (
                  <Provenance kind="demo" label={t('sea.v3.aisSimulated')} />
                )
              ) : null
            }
          >
            {status.isError ? (
              <ErrorNote error={status.error} onRetry={() => void status.refetch()} />
            ) : !status.data ? (
              <Loading rows={3} />
            ) : (
              <div className="flex flex-col gap-3 px-5 pb-5 pt-2">
                <Facts
                  items={[
                    [t('sea.v3.source'), <span key="s" className="t-data">{status.data.source}</span>],
                    [t('sea.v3.fixesRecorded'), <span key="f" className="t-data">{fmt.int(status.data.fixesRecorded)}</span>],
                    ...(status.data.isLive
                      ? ([
                          [
                            t('sea.v3.untracked'),
                            <span key="u" className="t-data">{fmt.int(status.data.fixesForUntrackedVessels)}</span>,
                          ],
                        ] as Array<[string, ReactNode]>)
                      : []),
                  ]}
                />
                {status.data.detail && (
                  <p className="m-0 text-[12px] leading-relaxed text-[var(--color-muted)]">{status.data.detail}</p>
                )}
                {status.data.howToGoLive && (
                  <p className="m-0 text-[12px] leading-relaxed text-[var(--color-dim)]">{status.data.howToGoLive}</p>
                )}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ helpers */

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
