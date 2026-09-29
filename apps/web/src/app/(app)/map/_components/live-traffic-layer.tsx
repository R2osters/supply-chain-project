'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plane, Ship, X } from 'lucide-react';
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent, MapMouseEvent } from 'maplibre-gl';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat, useI18n } from '@/lib/i18n';
import type { Palette } from '@/lib/theme';
import { Button, Chip, Facts } from '@/components/ui';
import {
  EMPTY_COLLECTION,
  LIVE_SOURCE,
  aircraftSourceLabel,
  aircraftTitle,
  aircraftToGeoJson,
  bboxFromBounds,
  bboxQuery,
  extrapolateAircraft,
  formatAltitude,
  formatBearing,
  formatKnots,
  formatVerticalRate,
  installLiveIcons,
  installLiveLayers,
  vesselBearing,
  vesselSourceLabel,
  vesselTitle,
  vesselsToGeoJson,
  type Aircraft,
  type AircraftResponse,
  type Vessel,
  type VesselsResponse,
} from './live-traffic';

/** Poll cadence: the API caches ~10-15 s upstream, polling faster would only re-read its cache. */
const AIRCRAFT_POLL_MS = 15_000;
const VESSEL_POLL_MS = 20_000;
/** Wait for the map to settle before asking for a new box: a pan is many moves. */
const MOVE_DEBOUNCE_MS = 800;
/** How often the glide between two aircraft fixes is redrawn. */
const GLIDE_TICK_MS = 1_000;

type Kind = 'aircraft' | 'vessel';

interface Target {
  kind: Kind;
  id: string;
}

interface Hover extends Target {
  x: number;
  y: number;
  /** Size of the map, so the card can flip to stay inside it. */
  width: number;
  height: number;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * Aircraft and AIS vessels over the fleet map: fetches for the visible box, draws both layers,
 * handles hover and click. The page owns the map; this hook owns everything drawn on it for the
 * two layers and cleans its listeners and timers when the page leaves.
 */
export function useLiveTraffic(map: MapLibreMap | null, ready: boolean, palette: Palette, beforeLayerId?: string) {
  const reducedMotion = usePrefersReducedMotion();
  const [showAircraft, setShowAircraft] = useState(true);
  const [showVessels, setShowVessels] = useState(true);
  const [bboxKey, setBboxKey] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [pinned, setPinned] = useState<(Target & { snapshot: Aircraft | Vessel }) | null>(null);
  const [installed, setInstalled] = useState(false);

  /* ------------------------------------------------------------ install */

  useEffect(() => {
    if (!ready || !map) return;
    installLiveIcons(map, palette);
    installLiveLayers(map, beforeLayerId);
    setInstalled(true);
    return () => setInstalled(false);
    // Palette changes are handled below by repainting the sprites, not by reinstalling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, map, beforeLayerId]);

  useEffect(() => {
    if (installed && map) installLiveIcons(map, palette);
  }, [installed, map, palette]);

  /* --------------------------------------------------------------- bbox */

  useEffect(() => {
    if (!installed || !map) return;
    const read = () => setBboxKey(bboxQuery(bboxFromBounds(map.getBounds())));
    read();
    let timer: number | null = null;
    const onMoveEnd = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(read, MOVE_DEBOUNCE_MS);
    };
    map.on('moveend', onMoveEnd);
    return () => {
      map.off('moveend', onMoveEnd);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [installed, map]);

  /* -------------------------------------------------------------- fetch */

  // TanStack pauses `refetchInterval` while the tab is hidden (refetchIntervalInBackground: false).
  const aircraft = useQuery({
    queryKey: ['aircraft', bboxKey],
    queryFn: ({ signal }) => api<AircraftResponse>(`/aircraft?${bboxKey}`, { signal }),
    enabled: showAircraft && bboxKey !== null,
    refetchInterval: AIRCRAFT_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });

  const vessels = useQuery({
    queryKey: ['maritime', 'live', bboxKey],
    queryFn: ({ signal }) => api<VesselsResponse>(`/maritime/live?${bboxKey}`, { signal }),
    enabled: showVessels && bboxKey !== null,
    refetchInterval: VESSEL_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });

  /* --------------------------------------------------------- visibility */

  useEffect(() => {
    if (!installed || !map) return;
    if (map.getLayer(LIVE_SOURCE.aircraft)) {
      map.setLayoutProperty(LIVE_SOURCE.aircraft, 'visibility', showAircraft ? 'visible' : 'none');
    }
    if (map.getLayer(LIVE_SOURCE.vessels)) {
      map.setLayoutProperty(LIVE_SOURCE.vessels, 'visibility', showVessels ? 'visible' : 'none');
    }
    // A card for a layer that was just switched off would point at nothing.
    setHover((current) =>
      current && ((current.kind === 'aircraft' && !showAircraft) || (current.kind === 'vessel' && !showVessels)) ? null : current,
    );
    setPinned((current) =>
      current && ((current.kind === 'aircraft' && !showAircraft) || (current.kind === 'vessel' && !showVessels)) ? null : current,
    );
  }, [installed, map, showAircraft, showVessels]);

  /* --------------------------------------------------------------- data */

  const selectedAircraft = pinned?.kind === 'aircraft' ? pinned.id : null;
  const selectedVessel = pinned?.kind === 'vessel' ? pinned.id : null;

  // When each response arrived, keyed by its identity: placeholder data kept across a pan must
  // keep gliding from where it was, not restart from its fix.
  const received = useRef<{ data: AircraftResponse | undefined; at: number }>({ data: undefined, at: 0 });
  if (received.current.data !== aircraft.data) received.current = { data: aircraft.data, at: Date.now() };

  // Aircraft glide between polls by dead reckoning, redrawn once a second; with reduced motion
  // they jump from fix to fix instead.
  useEffect(() => {
    if (!installed || !map) return;
    const source = map.getSource(LIVE_SOURCE.aircraft) as GeoJSONSource | undefined;
    if (!source) return;
    const planes = showAircraft ? (aircraft.data?.aircraft ?? []) : [];
    const receivedAt = received.current.at;
    const draw = () => {
      const elapsed = reducedMotion ? 0 : (Date.now() - receivedAt) / 1000;
      source.setData(aircraftToGeoJson(extrapolateAircraft(planes, elapsed), selectedAircraft));
    };
    draw();
    if (reducedMotion || planes.length === 0) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') draw();
    }, GLIDE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [installed, map, showAircraft, aircraft.data, selectedAircraft, reducedMotion]);

  useEffect(() => {
    if (!installed || !map) return;
    const source = map.getSource(LIVE_SOURCE.vessels) as GeoJSONSource | undefined;
    source?.setData(showVessels && vessels.data ? vesselsToGeoJson(vessels.data.vessels, selectedVessel) : EMPTY_COLLECTION);
  }, [installed, map, showVessels, vessels.data, selectedVessel]);

  /* -------------------------------------------------------- interaction */

  const findItem = useCallback(
    (pick: Target): Aircraft | Vessel | null =>
      pick.kind === 'aircraft'
        ? (aircraft.data?.aircraft.find((plane) => plane.id === pick.id) ?? null)
        : (vessels.data?.vessels.find((vessel) => vessel.mmsi === pick.id) ?? null),
    [aircraft.data, vessels.data],
  );
  const findRef = useRef(findItem);
  findRef.current = findItem;

  useEffect(() => {
    if (!installed || !map) return;
    const kindOf = (layer: string): Kind => (layer === LIVE_SOURCE.aircraft ? 'aircraft' : 'vessel');

    const onMove = (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature) return;
      map.getCanvas().style.cursor = 'pointer';
      setHover({
        kind: kindOf(feature.layer.id),
        id: String(feature.properties?.id),
        x: event.point.x,
        y: event.point.y,
        width: map.getContainer().clientWidth,
        height: map.getContainer().clientHeight,
      });
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = '';
      setHover(null);
    };
    const onClick = (event: MapMouseEvent) => {
      const layers = [LIVE_SOURCE.aircraft, LIVE_SOURCE.vessels].filter(
        (id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none',
      );
      const feature = layers.length > 0 ? map.queryRenderedFeatures(event.point, { layers })[0] : undefined;
      if (!feature) {
        setPinned(null);
        return;
      }
      const pick: Target = { kind: kindOf(feature.layer.id), id: String(feature.properties?.id) };
      const snapshot = findRef.current(pick);
      if (snapshot) setPinned({ ...pick, snapshot });
    };

    for (const layer of [LIVE_SOURCE.aircraft, LIVE_SOURCE.vessels]) {
      map.on('mousemove', layer, onMove);
      map.on('mouseleave', layer, onLeave);
    }
    map.on('click', onClick);
    return () => {
      for (const layer of [LIVE_SOURCE.aircraft, LIVE_SOURCE.vessels]) {
        map.off('mousemove', layer, onMove);
        map.off('mouseleave', layer, onLeave);
      }
      map.off('click', onClick);
    };
  }, [installed, map]);

  useEffect(() => {
    if (!pinned) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPinned(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned]);

  // The pinned card follows fresh data; if the target left the view it keeps its last fix.
  const pinnedItem = pinned ? (findItem(pinned) ?? pinned.snapshot) : null;
  const hoverItem = hover && !(pinned && pinned.kind === hover.kind && pinned.id === hover.id) ? findItem(hover) : null;

  return {
    showAircraft,
    setShowAircraft,
    showVessels,
    setShowVessels,
    aircraft,
    vessels,
    pinned: pinned && pinnedItem ? { kind: pinned.kind, item: pinnedItem } : null,
    closePinned: () => setPinned(null),
    hover: hover && hoverItem ? { kind: hover.kind, item: hoverItem, x: hover.x, y: hover.y, width: hover.width, height: hover.height } : null,
  };
}

export type LiveTraffic = ReturnType<typeof useLiveTraffic>;

/* ------------------------------------------------------------------ controls */

/** The two layer pills, in the same row as the traffic toggle. */
export function LiveTrafficToggles({ live }: { live: LiveTraffic }) {
  const { t } = useI18n();
  const aircraftCount = live.aircraft.data?.aircraft.length ?? 0;
  const vesselCount = live.vessels.data?.vessels.length ?? 0;
  return (
    <>
      <button
        type="button"
        className="pill h-8"
        aria-pressed={live.showAircraft}
        onClick={() => live.setShowAircraft((value) => !value)}
      >
        <Plane />
        {t('live.layer.aircraft')}
        {live.showAircraft && live.aircraft.data && <span className="pill-count">{aircraftCount}</span>}
      </button>
      <button
        type="button"
        className="pill h-8"
        aria-pressed={live.showVessels}
        onClick={() => live.setShowVessels((value) => !value)}
      >
        <Ship />
        {t('live.layer.vessels')}
        {live.showVessels && live.vessels.data?.isLive && <span className="pill-count">{vesselCount}</span>}
      </button>
    </>
  );
}

/**
 * One quiet line per active layer: where the data comes from (attribution is a licence condition
 * for OpenSky and adsb.lol), how fresh it is, and why the ships are missing when there is no key.
 */
export function LiveTrafficStatus({ live }: { live: LiveTraffic }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const air = live.aircraft;
  const sea = live.vessels;

  const lines: React.ReactNode[] = [];

  if (live.showAircraft) {
    if (air.isError && !air.data) {
      lines.push(<span key="air-error">{t('live.aircraft.unavailable')}</span>);
    } else if (air.data) {
      const label = aircraftSourceLabel(air.data);
      lines.push(
        <span key="air">
          <Plane className="mr-1 inline h-3 w-3 align-[-2px]" aria-hidden />
          {air.data.source === 'none' ? t('live.aircraft.noSource') : label}
          {air.data.source === 'opensky' && !air.data.authenticated && ` · ${t('live.aircraft.anonymous')}`}
          {` · ${fmt.time(air.data.fetchedAt)}`}
          {(air.data.stale || air.isError) && (
            <span className="text-[var(--color-warn)]"> · {t('live.stale')}</span>
          )}
        </span>,
      );
    }
  }

  if (live.showVessels && sea.data) {
    if (!sea.data.isLive) {
      lines.push(
        <span key="sea-off">
          <Ship className="mr-1 inline h-3 w-3 align-[-2px]" aria-hidden />
          {can('company:update') ? (
            <Link href="/settings" className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-ink)]">
              {t('live.vessels.addKey')}
            </Link>
          ) : (
            t('live.vessels.addKey')
          )}
        </span>,
      );
    } else {
      lines.push(
        <span key="sea">
          <Ship className="mr-1 inline h-3 w-3 align-[-2px]" aria-hidden />
          {vesselSourceLabel(sea.data.source)}
          {` · ${fmt.time(sea.data.fetchedAt)}`}
          {sea.isError && <span className="text-[var(--color-warn)]"> · {t('live.stale')}</span>}
        </span>,
      );
    }
  } else if (live.showVessels && sea.isError) {
    lines.push(<span key="sea-error">{t('live.vessels.unavailable')}</span>);
  }

  if (lines.length === 0) return null;
  return (
    <div className="t-data flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--color-dim)]" aria-live="polite">
      {lines}
    </div>
  );
}

/* ---------------------------------------------------------------------- cards */

function AircraftCard({ plane, source }: { plane: Aircraft; source?: string }) {
  const { t, intlLocale } = useI18n();
  const altitude = formatAltitude(plane.altitudeM, plane.onGround, intlLocale);
  const climb = formatVerticalRate(plane.verticalRateMs, intlLocale);
  const subtitle = [plane.registration, plane.id.toUpperCase(), plane.originCountry].filter(Boolean).join(' · ');
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-0.5 pr-6">
        <span className="flex items-center gap-2">
          <Plane className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
          <b className="t-data truncate text-[14px] font-semibold">{aircraftTitle(plane)}</b>
          {plane.type && <Chip>{plane.type}</Chip>}
        </span>
        <span className="t-data truncate text-[11.5px] text-[var(--color-muted)]">{subtitle}</span>
      </div>
      <Facts
        items={[
          [t('live.card.altitude'), altitude ?? t('live.card.onGround')],
          [t('live.card.speed'), formatKnots(plane.speedKts, intlLocale)],
          [t('live.card.track'), formatBearing(plane.trackDeg)],
          [t('live.card.vertical'), climb ?? t('live.card.level')],
        ]}
      />
      {source && <span className="t-data text-[10.5px] text-[var(--color-dim)]">{source}</span>}
    </div>
  );
}

function VesselCard({ vessel, source }: { vessel: Vessel; source?: string }) {
  const { t, intlLocale } = useI18n();
  const fmt = useFormat();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-0.5 pr-6">
        <span className="flex items-center gap-2">
          <Ship className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
          <b className="truncate text-[14px] font-semibold">{vesselTitle(vessel)}</b>
          {vessel.tracked && <Chip tone="signal">{t('live.card.tracked')}</Chip>}
        </span>
        <span className="t-data truncate text-[11.5px] text-[var(--color-muted)]">
          MMSI {vessel.mmsi}
          {vessel.navStatus ? ` · ${vessel.navStatus}` : ''}
        </span>
      </div>
      <Facts
        items={[
          [t('live.card.speed'), formatKnots(vessel.speedKnots, intlLocale)],
          [t('live.card.course'), formatBearing(vesselBearing(vessel))],
          [t('live.card.destination'), vessel.destination?.trim() || '—'],
          [t('live.card.seen'), fmt.relative(vessel.lastSeenAt)],
        ]}
      />
      {source && <span className="t-data text-[10.5px] text-[var(--color-dim)]">{source}</span>}
    </div>
  );
}

/** Hover card near the cursor, and the pinned card (click) docked above the legend. */
export function LiveTrafficCards({ live }: { live: LiveTraffic }) {
  const { t } = useI18n();
  const airSource = live.aircraft.data ? aircraftSourceLabel(live.aircraft.data) : undefined;
  const seaSource = live.vessels.data ? vesselSourceLabel(live.vessels.data.source) : undefined;

  const body = (entry: { kind: Kind; item: Aircraft | Vessel }) =>
    entry.kind === 'aircraft' ? (
      <AircraftCard plane={entry.item as Aircraft} source={airSource} />
    ) : (
      <VesselCard vessel={entry.item as Vessel} source={seaSource} />
    );

  const hoverStyle = useMemo(() => {
    if (!live.hover) return undefined;
    // Beside the cursor, flipped left past the middle so it never slides under the right panel.
    const { x, y, width, height } = live.hover;
    return {
      left: x > width / 2 ? Math.max(8, x - 16 - 260) : x + 16,
      ...(y > height * 0.6 ? { bottom: height - y + 16 } : { top: y + 16 }),
    };
  }, [live.hover]);

  return (
    <>
      {live.hover && (
        <div
          className="map-card pointer-events-none absolute z-[5] w-[260px] p-3.5"
          style={hoverStyle}
          role="tooltip"
        >
          {body(live.hover)}
        </div>
      )}
      {live.pinned && (
        <div
          className="map-card rise absolute bottom-[calc(55%+12px)] left-3 z-[5] w-[min(300px,calc(100%-24px))] p-3.5 lg:bottom-[104px]"
          role="dialog"
          aria-label={live.pinned.kind === 'aircraft' ? t('live.layer.aircraft') : t('live.layer.vessels')}
        >
          <span className="absolute right-2 top-2">
            <Button variant="ghost" size="sm" icon={X} onClick={live.closePinned} aria-label={t('common.close')} />
          </span>
          {body(live.pinned)}
        </div>
      )}
    </>
  );
}
