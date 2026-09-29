'use client';

import { useQuery } from '@tanstack/react-query';
import { Layers, Map as MapIcon, WifiLow } from 'lucide-react';
import maplibregl, { type Map as MapLibreMap, type Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api, apiUrl, getAccessToken, isApiUrl, type FleetVehicle } from '@/lib/api';
import {
  ESTIMATE_AREA,
  ESTIMATE_LINK,
  ESTIMATE_OUTLINE,
  ESTIMATE_POINT,
  ESTIMATE_SOURCE,
  describeEstimate,
  estimatesGeoJson,
} from './_components/estimates';
import type { TrafficStatus } from '@/lib/intel';
import { useFormat, useI18n, type TranslationKey } from '@/lib/i18n';
import { basemapStyle, useBasemapTheme, watchBasemapTiles } from '@/lib/map-style';
import { isTrackAnimating, positionAt, startTrack, type MotionTrack } from '@/lib/motion';
import { usePalette, type Palette } from '@/lib/theme';
import { Banner, DemoTag, Empty, ErrorNote, Legend, Loading, Provenance, SeverityIcon } from '@/components/ui';
import { LiveTrafficCards, LiveTrafficStatus, LiveTrafficToggles, useLiveTraffic } from './_components/live-traffic-layer';
import { ReplayControls, type HistoryFix } from './_components/replay';
import { FixProvenance, VehicleDetail } from './_components/vehicle-detail';
import {
  FLEET_FILTERS,
  STATE_COLOUR,
  buildVehicleMarker,
  buildWarehouseMarker,
  matchesFilter,
  paintVehicleMarker,
  rotateMarker,
  vehicleState,
  type FleetFilter,
} from './_components/vehicle-marker';
import { wsUrl } from '@/lib/runtime-config';


interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  latitude: number;
  longitude: number;
}

interface LivePosition {
  vehicleId: string;
  shipmentId: string | null;
  latitude: number;
  longitude: number;
  speedKmh: number | null;
  headingDegrees: number | null;
  recordedAt: string;
  isSimulated?: boolean;
}

interface VehicleMotion {
  track: MotionTrack;
  lastFixAt: number;
  /** Epoch ms of the fix itself; a repeated poll of the same fix must not restart the glide. */
  fixTime: number;
}

const TRAFFIC_LAYER = 'live-traffic';
const REPLAY_TRACK = 'replay-track';
const REPLAY_POINT = 'replay-point';

const FILTER_LABEL: Record<FleetFilter, TranslationKey> = {
  all: 'map.v3.filter.all',
  moving: 'map.v3.filter.moving',
  atRisk: 'map.v3.filter.atRisk',
  delayed: 'map.v3.filter.delayed',
  stopped: 'map.v3.filter.stopped',
  demo: 'map.v3.filter.demo',
};

/** Next requires a Suspense boundary around `useSearchParams` for the static pass. */
export default function LiveMapPage() {
  return (
    <Suspense fallback={<Loading rows={6} />}>
      <LiveMap />
    </Suspense>
  );
}

function LiveMap() {
  const { t } = useI18n();
  const fmt = useFormat();
  const palette = usePalette();
  const searchParams = useSearchParams();
  const requestedVehicle = searchParams.get('vehicle');

  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Map<string, Marker>>(new Map());
  const motions = useRef<Map<string, VehicleMotion>>(new Map());
  const frame = useRef<number | null>(null);
  const socket = useRef<Socket | null>(null);
  const paletteRef = useRef<Palette>(palette);
  paletteRef.current = palette;
  const flewToRequested = useRef(false);

  const [ready, setReady] = useState(false);
  const [live, setLive] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(requestedVehicle);
  const [filter, setFilter] = useState<FleetFilter>('all');
  const [lastTick, setLastTick] = useState<Date | null>(null);
  const [showTraffic, setShowTraffic] = useState(false);

  const [replayOn, setReplayOn] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  const traffic = useQuery({
    queryKey: ['traffic', 'status'],
    queryFn: () => api<TrafficStatus>('/traffic/status'),
    refetchInterval: 5 * 60_000,
  });

  const fleet = useQuery({
    queryKey: ['telemetry', 'fleet'],
    queryFn: () => api<FleetVehicle[]>('/telemetry/fleet'),
    // The socket carries live movement; this poll is the safety net if it drops.
    refetchInterval: 30_000,
  });

  const warehouses = useQuery({
    queryKey: ['warehouses', 'all'],
    queryFn: () => api<{ data: WarehouseRow[] }>('/warehouses?limit=100'),
  });

  const vehicles = useMemo(() => fleet.data ?? [], [fleet.data]);
  const selected = useMemo(
    () => vehicles.find((vehicle) => vehicle.vehicleId === selectedId) ?? null,
    [vehicles, selectedId],
  );
  const visibleVehicles = useMemo(
    () => vehicles.filter((vehicle) => matchesFilter(vehicle, filter)),
    [vehicles, filter],
  );
  const counts = useMemo(() => {
    const result = {} as Record<FleetFilter, number>;
    for (const key of FLEET_FILTERS) result[key] = vehicles.filter((vehicle) => matchesFilter(vehicle, key)).length;
    return result;
  }, [vehicles]);

  /* ---------------------------------------------------------------- replay */

  // Today from local midnight: the operator's "day", not UTC's.
  const dayStart = useMemo(() => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date.toISOString();
  }, []);

  const history = useQuery({
    queryKey: ['telemetry', 'history', selectedId, dayStart],
    queryFn: () =>
      api<HistoryFix[]>(
        `/telemetry/vehicles/${encodeURIComponent(selectedId ?? '')}/history?from=${encodeURIComponent(dayStart)}&limit=5000`,
      ),
    enabled: replayOn && selectedId !== null,
    staleTime: 60_000,
  });

  // The endpoint returns newest first; a replay runs forward in time.
  const fixes = useMemo(
    () => [...(history.data ?? [])].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt)),
    [history.data],
  );

  // A different vehicle ends the replay: its track would otherwise be drawn for the wrong truck.
  useEffect(() => {
    setReplayOn(false);
    setPlaying(false);
    setReplayIndex(0);
  }, [selectedId]);

  useEffect(() => {
    if (!playing || fixes.length < 2) return;
    // ~20 s for a full day whatever the density: long enough to follow, short enough to use.
    const step = Math.max(1, Math.floor(fixes.length / 160));
    const timer = window.setInterval(() => {
      setReplayIndex((index) => {
        const next = index + step;
        if (next >= fixes.length - 1) {
          setPlaying(false);
          return fixes.length - 1;
        }
        return next;
      });
    }, 125);
    return () => window.clearInterval(timer);
  }, [playing, fixes.length]);

  /* ------------------------------------------------------------------- map */

  useEffect(() => {
    if (!container.current || map.current) return;

    const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL;
    const instance = new maplibregl.Map({
      container: container.current,
      style: styleUrl && styleUrl.length > 0 ? styleUrl : basemapStyle(paletteRef.current),
      center: [-1.0, 6.6], // central Ghana: the whole demo network fits in one view
      zoom: 6.4,
      attributionControl: { compact: true },
      // Traffic tiles come from our API and need the bearer token; the basemap host must not.
      transformRequest: (url) => {
        const token = getAccessToken();
        return isApiUrl(url) && token ? { url, headers: { Authorization: `Bearer ${token}` } } : { url };
      },
    });
    watchBasemapTiles(instance);

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    instance.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    instance.on('load', () => {
      instance.addSource(TRAFFIC_LAYER, {
        type: 'raster',
        tiles: [apiUrl('/traffic/tiles/{z}/{x}/{y}')],
        tileSize: 256,
        minzoom: 3,
        maxzoom: 18,
      });
      instance.addLayer({
        id: TRAFFIC_LAYER,
        type: 'raster',
        source: TRAFFIC_LAYER,
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.85 },
      });

      const colours = paletteRef.current;
      // Where silent vehicles probably are (dead reckoning along the planned route): dashed,
      // translucent and hollow, so a guess never passes for a GPS fix.
      instance.addSource(ESTIMATE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      instance.addLayer({
        id: ESTIMATE_AREA,
        type: 'fill',
        source: ESTIMATE_SOURCE,
        filter: ['==', ['get', 'part'], 'area'],
        paint: { 'fill-color': colours.ink, 'fill-opacity': ['case', ['get', 'selected'], 0.12, 0.06] },
      });
      instance.addLayer({
        id: ESTIMATE_OUTLINE,
        type: 'line',
        source: ESTIMATE_SOURCE,
        filter: ['==', ['get', 'part'], 'area'],
        paint: { 'line-color': colours.muted, 'line-width': 1.2, 'line-dasharray': [2, 2] },
      });
      instance.addLayer({
        id: ESTIMATE_LINK,
        type: 'line',
        source: ESTIMATE_SOURCE,
        filter: ['==', ['get', 'part'], 'link'],
        paint: { 'line-color': colours.muted, 'line-width': 1.4, 'line-dasharray': [1, 2] },
      });
      instance.addLayer({
        id: ESTIMATE_POINT,
        type: 'circle',
        source: ESTIMATE_SOURCE,
        filter: ['==', ['get', 'part'], 'point'],
        paint: {
          'circle-radius': 5,
          'circle-color': colours.surface2,
          'circle-stroke-color': colours.ink,
          'circle-stroke-width': 1.5,
        },
      });

      instance.addSource(REPLAY_TRACK, { type: 'geojson', data: emptyLine() });
      instance.addLayer({
        id: REPLAY_TRACK,
        type: 'line',
        source: REPLAY_TRACK,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': colours.ink, 'line-width': 2.4, 'line-opacity': 0.9 },
      });
      instance.addSource(REPLAY_POINT, { type: 'geojson', data: emptyPoints() });
      instance.addLayer({
        id: REPLAY_POINT,
        type: 'circle',
        source: REPLAY_POINT,
        paint: {
          'circle-radius': 7,
          'circle-color': colours.accent,
          'circle-stroke-color': colours.surface2,
          'circle-stroke-width': 2,
        },
      });
      setReady(true);
    });

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

  useBasemapTheme(ready ? map.current : null, palette);

  // Aircraft and AIS vessels, drawn under the replay track so a replayed day stays on top.
  const liveTraffic = useLiveTraffic(ready ? map.current : null, ready, palette, REPLAY_TRACK);

  // GL layers hold literal colours: repaint them when the theme changes.
  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    if (instance.getLayer(REPLAY_TRACK)) instance.setPaintProperty(REPLAY_TRACK, 'line-color', palette.ink);
    if (instance.getLayer(REPLAY_POINT)) {
      instance.setPaintProperty(REPLAY_POINT, 'circle-color', palette.accent);
      instance.setPaintProperty(REPLAY_POINT, 'circle-stroke-color', palette.surface2);
    }
  }, [ready, palette]);

  useEffect(() => {
    if (!ready || !map.current?.getLayer(TRAFFIC_LAYER)) return;
    const visible = showTraffic && Boolean(traffic.data?.enabled);
    map.current.setLayoutProperty(TRAFFIC_LAYER, 'visibility', visible ? 'visible' : 'none');
  }, [ready, showTraffic, traffic.data?.enabled]);

  // Replay track + cursor.
  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    const track = instance.getSource(REPLAY_TRACK) as maplibregl.GeoJSONSource | undefined;
    const point = instance.getSource(REPLAY_POINT) as maplibregl.GeoJSONSource | undefined;
    if (!replayOn || fixes.length < 2) {
      track?.setData(emptyLine());
      point?.setData(emptyPoints());
      return;
    }
    track?.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: fixes.map((fix) => [fix.longitude, fix.latitude]) },
    });
    const current = fixes[Math.min(replayIndex, fixes.length - 1)];
    point?.setData({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [current.longitude, current.latitude] } },
      ],
    });
  }, [ready, replayOn, fixes, replayIndex]);

  // Frame the whole day once when its track arrives.
  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance || !replayOn || fixes.length < 2) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const fix of fixes) bounds.extend([fix.longitude, fix.latitude]);
    instance.fitBounds(bounds, { padding: { top: 120, bottom: 60, left: 60, right: 420 }, duration: 800, maxZoom: 12 });
  }, [ready, replayOn, fixes]);

  /* ---------------------------------------------------------------- motion */

  /**
   * One animation loop for the whole fleet, running only while some marker is still gliding or
   * coasting. It stops by itself once everything has settled, so an idle map costs nothing.
   */
  const animate = (): void => {
    const now = performance.now();
    let pending = false;
    for (const [vehicleId, motion] of motions.current) {
      const marker = markers.current.get(vehicleId);
      if (!marker) continue;
      const point = positionAt(motion.track, now);
      marker.setLngLat([point.longitude, point.latitude]);
      if (isTrackAnimating(motion.track, now)) pending = true;
    }
    frame.current = pending ? requestAnimationFrame(animate) : null;
  };

  const applyFix = (
    vehicleId: string,
    fix: { latitude: number; longitude: number; speedKmh: number | null; headingDegrees: number | null; recordedAt: string },
  ): void => {
    const marker = markers.current.get(vehicleId);
    if (!marker) return;
    const fixTime = Date.parse(fix.recordedAt);
    const previous = motions.current.get(vehicleId);
    if (previous && previous.fixTime === fixTime) return;

    const now = performance.now();
    const drawn = marker.getLngLat();
    const interval = previous ? now - previous.lastFixAt : null;
    motions.current.set(vehicleId, {
      track: startTrack(previous ? { latitude: drawn.lat, longitude: drawn.lng } : null, fix, now, interval),
      lastFixAt: now,
      fixTime,
    });
    rotateMarker(marker, fix.headingDegrees);
    if (frame.current === null) frame.current = requestAnimationFrame(animate);
  };

  const flyTo = useCallback((vehicle: FleetVehicle) => {
    map.current?.flyTo({ center: [vehicle.longitude, vehicle.latitude], zoom: 9, duration: 900 });
  }, []);

  const select = useCallback(
    (vehicle: FleetVehicle) => {
      setSelectedId(vehicle.vehicleId);
      flyTo(vehicle);
    },
    [flyTo],
  );

  /* ------------------------------------------------------------ warehouses */

  useEffect(() => {
    if (!ready || !map.current || !warehouses.data) return;
    const instance = map.current;
    const added: Marker[] = [];
    for (const warehouse of warehouses.data.data) {
      added.push(
        new maplibregl.Marker({ element: buildWarehouseMarker(warehouse.code) })
          .setLngLat([warehouse.longitude, warehouse.latitude])
          .addTo(instance),
      );
    }
    return () => added.forEach((marker) => marker.remove());
  }, [ready, warehouses.data]);

  /* ----------------------------------------------------------------- fleet */

  useEffect(() => {
    if (!ready || !map.current || !fleet.data) return;
    const instance = map.current;

    for (const vehicle of fleet.data) {
      if (!markers.current.has(vehicle.vehicleId)) {
        const element = buildVehicleMarker(vehicle, () => setSelectedId(vehicle.vehicleId));
        const marker = new maplibregl.Marker({ element })
          .setLngLat([vehicle.longitude, vehicle.latitude])
          .addTo(instance);
        markers.current.set(vehicle.vehicleId, marker);
      }
      applyFix(vehicle.vehicleId, { ...vehicle, recordedAt: vehicle.lastPositionAt ?? new Date().toISOString() });
    }

    // Drop markers for vehicles that stopped reporting, or the map slowly fills with ghosts.
    const alive = new Set(fleet.data.map((vehicle) => vehicle.vehicleId));
    for (const [id, marker] of markers.current) {
      if (!alive.has(id)) {
        marker.remove();
        markers.current.delete(id);
        motions.current.delete(id);
      }
    }
    // applyFix only touches refs; listing it would re-run this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fleet.data]);

  // Estimated positions of silent vehicles, redrawn with each fleet poll and on selection.
  useEffect(() => {
    if (!ready || !map.current) return;
    const source = map.current.getSource(ESTIMATE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    source?.setData(estimatesGeoJson(fleet.data ?? [], selectedId));
  }, [ready, fleet.data, selectedId]);

  // State colour, selection ring and filter visibility — cheap for a fleet of dozens.
  useEffect(() => {
    if (!ready) return;
    for (const vehicle of vehicles) {
      const marker = markers.current.get(vehicle.vehicleId);
      if (!marker) continue;
      paintVehicleMarker(marker.getElement(), vehicle, {
        selected: vehicle.vehicleId === selectedId,
        visible: matchesFilter(vehicle, filter) || vehicle.vehicleId === selectedId,
      });
    }
  }, [ready, vehicles, selectedId, filter]);

  // `/map?vehicle=<id>` (from a shipment page): open that vehicle and fly to it once.
  useEffect(() => {
    if (!ready || flewToRequested.current || !requestedVehicle || !fleet.data) return;
    flewToRequested.current = true;
    const vehicle = fleet.data.find((item) => item.vehicleId === requestedVehicle);
    if (vehicle) flyTo(vehicle);
  }, [ready, requestedVehicle, fleet.data, flyTo]);

  /* ----------------------------------------------------------- live socket */

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;

    const connection = io(`${wsUrl()}/tracking`, {
      auth: { token },
      transports: ['websocket'],
    });

    connection.on('connect', () => setLive(true));
    connection.on('disconnect', () => setLive(false));
    connection.on('connect_error', () => setLive(false));

    connection.on('position', (position: LivePosition) => {
      setLastTick(new Date());
      // Moving the existing marker rather than re-rendering the layer avoids a full React pass
      // on every one of a dozen vehicles every few seconds; the glide makes the move smooth.
      applyFix(position.vehicleId, position);
    });

    socket.current = connection;
    return () => {
      connection.close();
      socket.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -------------------------------------------------------------- keyboard */

  // J / K walk the visible fleet, Esc closes the detail (charte §10). Ignored while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'escape' && selectedId) {
        setSelectedId(null);
        return;
      }
      if ((key !== 'j' && key !== 'k') || visibleVehicles.length === 0) return;
      event.preventDefault();
      const current = visibleVehicles.findIndex((vehicle) => vehicle.vehicleId === selectedId);
      const next =
        current === -1
          ? key === 'j'
            ? 0
            : visibleVehicles.length - 1
          : (current + (key === 'j' ? 1 : -1) + visibleVehicles.length) % visibleVehicles.length;
      select(visibleVehicles[next]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visibleVehicles, selectedId, select]);

  /* ---------------------------------------------------------------- render */

  const deviating = counts.atRisk + counts.delayed;
  const title =
    deviating === 0
      ? t('map.v3.title.none')
      : t('map.v3.title.some', { n: deviating, d: counts.delayed });
  const trafficEnabled = Boolean(traffic.data?.enabled);

  return (
    <div
      className="relative h-[calc(100vh-152px)] min-h-[520px] overflow-hidden rounded-[var(--radius-lg)] bg-[var(--color-map)] lg:[&_.maplibregl-ctrl-bottom-right]:mr-[380px]"
    >
      <div ref={container} className="absolute inset-0" aria-label={t('map.v3.mapLabel')} role="region" />

      {/* ------------------------------------------------ situation + filters */}
      <div className="map-card rise absolute left-3 right-3 top-3 flex flex-col gap-3 p-3.5 lg:right-auto lg:max-w-[calc(100%-400px)]">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="t-label flex items-center gap-1.5">
              <MapIcon className="h-3.5 w-3.5" />
              {t('map.v3.kicker')}
            </span>
            <h1 className="t-h3 m-0 flex items-center gap-2" aria-live="polite">
              {counts.delayed > 0 ? (
                <SeverityIcon severity="critical" />
              ) : deviating > 0 ? (
                <SeverityIcon severity="warning" />
              ) : null}
              {fleet.isLoading ? t('map.v3.title.loading') : title}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {live ? (
              <Provenance kind="live" label={t('map.v3.streaming')} />
            ) : (
              <Provenance kind="poll" seconds={30} />
            )}
            <span className="t-data text-[11px] text-[var(--color-dim)]">
              {t('map.v3.reporting', { n: vehicles.length })}
              {lastTick && ` · ${fmt.time(lastTick)}`}
            </span>
            <button
              type="button"
              className="pill h-8"
              onClick={() => setShowTraffic((value) => !value)}
              aria-pressed={showTraffic && trafficEnabled}
              disabled={!trafficEnabled}
              title={trafficEnabled ? undefined : (traffic.data?.note ?? t('sit.hint.trafficOff'))}
              style={trafficEnabled ? undefined : { opacity: 0.5, cursor: 'not-allowed' }}
            >
              <Layers />
              {t('map.layer.traffic')}
            </button>
            <LiveTrafficToggles live={liveTraffic} />
          </div>
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label={t('map.v3.filters')}>
          {FLEET_FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              className={`pill h-8 ${key === 'demo' && filter !== 'demo' ? 'pill-demo' : ''}`}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {(key === 'atRisk' || key === 'delayed') && counts[key] > 0 && filter !== key && (
                <SeverityIcon severity={key === 'delayed' ? 'critical' : 'warning'} size={14} />
              )}
              {t(FILTER_LABEL[key])}
              <span key={counts[key]} className="pill-count pop">
                {counts[key]}
              </span>
            </button>
          ))}
        </div>

        <LiveTrafficStatus live={liveTraffic} />

        {fleet.isError && fleet.data && (
          <Banner tone="warn" icon={WifiLow} title={t('map.v3.weakNetwork', { time: fmt.time(new Date(fleet.dataUpdatedAt)) })}>
            {t('map.v3.weakNetworkHint')}
          </Banner>
        )}
      </div>

      {/* ------------------------------------------------------ right panel */}
      <aside
        className="map-card absolute inset-x-3 bottom-3 flex max-h-[55%] flex-col overflow-hidden lg:inset-x-auto lg:bottom-3 lg:right-3 lg:top-3 lg:max-h-none lg:w-[360px]"
        aria-label={selected ? t('map.v3.vehicle') : t('map.v3.fleet')}
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          {selected ? (
            <div key={selected.vehicleId} className="slide-in-right">
              <VehicleDetail
                vehicle={selected}
                live={live}
                onClose={() => setSelectedId(null)}
                replay={
                  <ReplayControls
                    active={replayOn}
                    onStart={() => {
                      setReplayOn(true);
                      setReplayIndex(0);
                    }}
                    onStop={() => {
                      setReplayOn(false);
                      setPlaying(false);
                    }}
                    fixes={fixes}
                    index={replayIndex}
                    onIndex={(index) => {
                      setPlaying(false);
                      setReplayIndex(index);
                    }}
                    playing={playing}
                    onTogglePlay={() => {
                      if (!playing && replayIndex >= fixes.length - 1) setReplayIndex(0);
                      setPlaying((value) => !value);
                    }}
                    loading={history.isLoading}
                    error={history.isError ? history.error : null}
                    onRetry={() => void history.refetch()}
                  />
                }
              />
            </div>
          ) : selectedId && fleet.data ? (
            <div className="slide-in-right">
              <Empty
                title={t('map.v3.notReporting')}
                hint={t('map.v3.notReportingHint')}
                action={
                  <button type="button" className="btn btn-sm" onClick={() => setSelectedId(null)}>
                    {t('map.v3.backToFleet')}
                  </button>
                }
              />
            </div>
          ) : (
            <FleetList
              vehicles={visibleVehicles}
              loading={fleet.isLoading}
              error={fleet.isError && !fleet.data ? fleet.error : null}
              onRetry={() => void fleet.refetch()}
              onSelect={select}
              live={live}
              filtered={filter !== 'all'}
              onClearFilter={() => setFilter('all')}
            />
          )}
        </div>
      </aside>

      {/* ----------------------------------------------------------- legend */}
      <div className="map-card fade-in absolute bottom-3 left-3 hidden max-w-[calc(100%-420px)] px-3.5 py-2.5 lg:block">
        <Legend
          items={[
            { label: t('map.v3.legend.moving'), colour: STATE_COLOUR.moving },
            { label: t('map.v3.legend.stopped'), colour: STATE_COLOUR.stopped },
            { label: t('map.v3.legend.atRisk'), colour: STATE_COLOUR.atRisk },
            { label: t('map.v3.legend.delayed'), colour: STATE_COLOUR.delayed },
            { label: t('map.v3.legend.demo'), colour: 'var(--color-sim)', shape: 'dash' },
            { label: t('map.v3.legend.replay'), colour: 'var(--color-ink)', shape: 'line' },
            { label: t('map.v3.legend.warehouse'), colour: 'var(--color-muted)' },
            ...(liveTraffic.showAircraft ? [{ label: t('live.legend.aircraft'), colour: 'var(--color-ink)' }] : []),
            ...(liveTraffic.showVessels ? [{ label: t('live.legend.vessel'), colour: 'var(--color-ink)' }] : []),
          ]}
        />
      </div>

      <LiveTrafficCards live={liveTraffic} />
    </div>
  );
}

/* ------------------------------------------------------------------ fleet list */

function FleetList({
  vehicles,
  loading,
  error,
  onRetry,
  onSelect,
  live,
  filtered,
  onClearFilter,
}: {
  vehicles: FleetVehicle[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onSelect: (vehicle: FleetVehicle) => void;
  live: boolean;
  filtered: boolean;
  onClearFilter: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();

  return (
    <div className="flex flex-col">
      <header className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
        <span className="t-h4">{t('map.v3.fleet')}</span>
        <span className="flex items-center gap-1.5 text-[11px] text-[var(--color-dim)]">
          <span className="kbd">J</span>
          <span className="kbd">K</span>
        </span>
      </header>
      {error ? (
        <ErrorNote error={error} onRetry={onRetry} />
      ) : loading ? (
        <Loading rows={6} />
      ) : vehicles.length === 0 ? (
        filtered ? (
          <Empty
            title={t('map.v3.filterEmpty')}
            hint={t('map.v3.filterEmptyHint')}
            action={
              <button type="button" className="btn btn-sm" onClick={onClearFilter}>
                {t('map.v3.filter.all')}
              </button>
            }
          />
        ) : (
          <Empty title={t('map.v3.nothingReporting')} hint={t('map.v3.nothingReportingHint')} />
        )
      ) : (
        <ul className="stagger m-0 flex list-none flex-col p-0 pb-2">
          {vehicles.map((vehicle) => {
            const state = vehicleState(vehicle);
            return (
              <li key={vehicle.vehicleId}>
                <button
                  type="button"
                  onClick={() => onSelect(vehicle)}
                  className="grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-3 px-4 py-2.5 text-left transition-colors duration-100 hover:bg-[var(--color-surface)]"
                >
                  <span className="mt-0.5">
                    {state === 'delayed' ? (
                      <SeverityIcon severity="critical" size={14} />
                    ) : state === 'atRisk' ? (
                      <SeverityIcon severity="warning" size={14} />
                    ) : (
                      <span
                        className="mt-1 block h-2 w-2 rounded-full"
                        style={{ background: state === 'moving' ? 'var(--color-ink)' : 'var(--color-muted)' }}
                      />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="t-data truncate text-[13px] text-[var(--color-ink)]">{vehicle.plateNumber}</span>
                      {vehicle.isDemoData && <DemoTag title={t('map.v3.simulatedNote')} />}
                    </span>
                    <span className="truncate text-[12px] text-[var(--color-muted)]">
                      {vehicle.destinationName ?? t('map.v3.idle')}
                    </span>
                    <FixProvenance at={vehicle.lastPositionAt} live={live} />
                    {vehicle.estimated && (
                      <span className="text-[11.5px] text-[var(--color-muted)]">
                        {t('map.est.short', { radius: describeEstimate(vehicle.estimated).radius })}
                      </span>
                    )}
                  </span>
                  <span className="t-data shrink-0 text-[12px] text-[var(--color-muted)]">
                    {fmt.num(vehicle.speedKmh, 0)} km/h
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------- helpers */

function emptyLine(): GeoJSON.Feature<GeoJSON.LineString> {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } };
}

function emptyPoints(): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return { type: 'FeatureCollection', features: [] };
}
