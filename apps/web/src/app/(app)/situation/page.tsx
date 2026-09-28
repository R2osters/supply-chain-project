'use client';

import { useQuery } from '@tanstack/react-query';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, getAccessToken, isApiUrl } from '@/lib/api';
import {
  boundsQuery,
  type Bounds,
  type Camera,
  type CamerasResponse,
  type Hazard,
  type HazardsResponse,
  type RadioResponse,
  type RadioStation,
  type TleResponse,
  type TrafficStatus,
} from '@/lib/intel';
import { useI18n, type TranslationKey } from '@/lib/i18n';
import { buildSatrecs, groundTrack, subPointAt, type SubPoint } from '@/lib/orbits';
import { Panel } from '@/components/ui';
import { CameraViewer } from '@/components/intel/camera-viewer';
import { ExposurePanel } from './_components/exposure-panel';
import { HazardDetail } from './_components/hazard-detail';
import {
  CLICKABLE_LAYERS,
  SOURCE,
  camerasToGeoJson,
  conesToGeoJson,
  hazardsToGeoJson,
  installIntelLayers,
  radioToGeoJson,
  satellitesToGeoJson,
  setLayerVisible,
  setSourceData,
  trackToGeoJson,
  tracksToGeoJson,
} from './_components/map-layers';
import { PlaceSearch } from './_components/place-search';
import { RadioPlayer } from './_components/radio-player';
import { SatellitePanel } from './_components/satellite-panel';
import { SourcesPanel } from './_components/sources-panel';

/**
 * Situation room: the world around the network.
 *
 * Tracking tells an operator where the cargo is; this screen tells them what is happening there.
 * Natural hazards near warehouses and routes, public traffic cameras to see a road with their
 * own eyes, local radio to hear traffic and news, satellites overhead to judge GPS quality, and
 * live congestion. Each layer is independent: one feed being down never blanks the others.
 */

const OSM_STYLE: maplibregl.StyleSpecification = {
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
    { id: 'background', type: 'background', paint: { 'background-color': '#0c0e10' } },
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: { 'raster-opacity': 0.42, 'raster-saturation': -0.85, 'raster-contrast': -0.1 },
    },
  ],
};

type LayerId = 'hazards' | 'cameras' | 'radio' | 'satellites' | 'traffic';

const LAYER_LABEL: Record<LayerId, TranslationKey> = {
  hazards: 'sit.layer.hazards',
  cameras: 'sit.layer.cameras',
  radio: 'sit.layer.radio',
  satellites: 'sit.layer.satellites',
  traffic: 'sit.layer.traffic',
};

/** Below these zooms a layer would mean thousands of points nobody can tell apart. */
const MIN_ZOOM = { cameras: 5, radio: 4 } as const;

type Selection =
  | { type: 'camera'; camera: Camera }
  | { type: 'radio'; station: RadioStation }
  | { type: 'hazard'; hazard: Hazard }
  | null;

interface MapView {
  bounds: Bounds;
  center: { latitude: number; longitude: number };
  zoom: number;
}

export default function SituationPage() {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<MapView | null>(null);
  const [layers, setLayers] = useState<Record<LayerId, boolean>>({
    hazards: true,
    cameras: true,
    radio: false,
    satellites: false,
    traffic: false,
  });
  const [selection, setSelection] = useState<Selection>(null);
  const [satelliteGroup, setSatelliteGroup] = useState('gps-ops');
  const [selectedSatellite, setSelectedSatellite] = useState<number | null>(null);
  const [satellitePoints, setSatellitePoints] = useState<SubPoint[]>([]);

  /* ------------------------------------------------------------------ map */

  useEffect(() => {
    if (!container.current || map.current) return;
    const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL;
    const instance = new maplibregl.Map({
      container: container.current,
      style: styleUrl && styleUrl.length > 0 ? styleUrl : OSM_STYLE,
      center: [-1.0, 6.6],
      zoom: 5.2,
      attributionControl: { compact: true },
      // Traffic tiles come from our API and need the bearer token. Only our own URLs get it —
      // the basemap host must never see a credential.
      transformRequest: (url) => {
        const token = getAccessToken();
        return isApiUrl(url) && token ? { url, headers: { Authorization: `Bearer ${token}` } } : { url };
      },
    });
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    let debounce: number | undefined;
    const publishView = (): void => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => setView(readView(instance)), 350);
    };

    instance.on('load', () => {
      installIntelLayers(instance);
      setReady(true);
      setView(readView(instance));
    });
    instance.on('moveend', publishView);

    map.current = instance;
    return () => {
      window.clearTimeout(debounce);
      instance.remove();
      map.current = null;
      setReady(false);
    };
  }, []);

  /* ------------------------------------------------------------------ data */

  const hazardBox = view && view.zoom >= 3 ? `?${boundsQuery(view.bounds, 0)}` : '';
  const hazards = useQuery({
    queryKey: ['hazards', hazardBox],
    queryFn: () => api<HazardsResponse>(`/hazards${hazardBox}`),
    enabled: layers.hazards && view !== null,
    refetchInterval: 5 * 60_000,
    placeholderData: (previous) => previous,
  });

  const cameraBox = view ? boundsQuery(view.bounds, 1) : '';
  const cameras = useQuery({
    queryKey: ['cameras', cameraBox],
    queryFn: () => api<CamerasResponse>(`/cameras?${cameraBox}&limit=1500`),
    enabled: layers.cameras && view !== null && view.zoom >= MIN_ZOOM.cameras,
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
  });

  const radioCentre = view
    ? { lat: view.center.latitude.toFixed(1), lon: view.center.longitude.toFixed(1), km: radiusForZoom(view.zoom) }
    : null;
  const radio = useQuery({
    queryKey: ['radio', radioCentre],
    queryFn: () =>
      api<RadioResponse>(
        `/radio/stations?lat=${radioCentre?.lat}&lon=${radioCentre?.lon}&radiusKm=${radioCentre?.km}&limit=120`,
      ),
    enabled: layers.radio && radioCentre !== null && (view?.zoom ?? 0) >= MIN_ZOOM.radio,
    staleTime: 30 * 60_000,
    placeholderData: (previous) => previous,
  });

  const tle = useQuery({
    queryKey: ['satellites', 'tle', satelliteGroup],
    queryFn: () => api<TleResponse>(`/satellites/tle?group=${satelliteGroup}`),
    enabled: layers.satellites,
    // Elements are good for days; CelesTrak asks for at most one download every two hours.
    staleTime: 2 * 60 * 60_000,
  });

  const traffic = useQuery({
    queryKey: ['traffic', 'status'],
    queryFn: () => api<TrafficStatus>('/traffic/status'),
    refetchInterval: 5 * 60_000,
  });

  const satrecs = useMemo(() => buildSatrecs(tle.data?.satellites ?? []), [tle.data]);

  /* ----------------------------------------------------------- map sync */

  useEffect(() => {
    if (!ready || !map.current) return;
    const list = hazards.data?.hazards ?? [];
    setSourceData(map.current, SOURCE.hazards, hazardsToGeoJson(list));
    setSourceData(map.current, SOURCE.hazardCones, conesToGeoJson(list));
    setSourceData(map.current, SOURCE.hazardTracks, tracksToGeoJson(list));
  }, [ready, hazards.data]);

  useEffect(() => {
    if (!ready || !map.current) return;
    setSourceData(map.current, SOURCE.cameras, camerasToGeoJson(cameras.data?.cameras ?? []));
  }, [ready, cameras.data]);

  useEffect(() => {
    if (!ready || !map.current) return;
    setSourceData(map.current, SOURCE.radio, radioToGeoJson(radio.data?.stations ?? []));
  }, [ready, radio.data]);

  useEffect(() => {
    if (!ready || !map.current) return;
    const instance = map.current;
    setLayerVisible(instance, [SOURCE.hazards, SOURCE.hazardCones, SOURCE.hazardTracks], layers.hazards);
    setLayerVisible(instance, [SOURCE.cameras], layers.cameras);
    setLayerVisible(instance, [SOURCE.radio], layers.radio);
    setLayerVisible(instance, [SOURCE.satellites, SOURCE.satelliteTrack], layers.satellites);
    setLayerVisible(instance, [SOURCE.traffic], layers.traffic && Boolean(traffic.data?.enabled));
  }, [ready, layers, traffic.data?.enabled]);

  // Satellites move ~7 km/s; one redraw a second is smooth at any zoom a person uses here, and
  // costs a few hundred microseconds of SGP4 for a GNSS constellation.
  useEffect(() => {
    if (!ready || !map.current || !layers.satellites || satrecs.length === 0) return;
    const instance = map.current;
    const tick = (): void => {
      const now = new Date();
      const points = satrecs.map((sat) => subPointAt(sat, now)).filter((p): p is SubPoint => p !== null);
      setSatellitePoints(points);
      setSourceData(instance, SOURCE.satellites, satellitesToGeoJson(points, selectedSatellite));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [ready, layers.satellites, satrecs, selectedSatellite]);

  useEffect(() => {
    if (!ready || !map.current) return;
    const satellite = satrecs.find((sat) => sat.noradId === selectedSatellite);
    const segments = satellite && layers.satellites ? groundTrack(satellite, new Date(), 100) : [];
    setSourceData(map.current, SOURCE.satelliteTrack, trackToGeoJson(segments));
  }, [ready, satrecs, selectedSatellite, layers.satellites]);

  /* ------------------------------------------------------------- clicks */

  // Handlers are registered once; they read the latest data through this ref instead of being
  // re-bound on every refetch.
  const latest = useRef({ hazards: [] as Hazard[], cameras: [] as Camera[], radio: [] as RadioStation[] });
  latest.current = {
    hazards: hazards.data?.hazards ?? [],
    cameras: cameras.data?.cameras ?? [],
    radio: radio.data?.stations ?? [],
  };

  useEffect(() => {
    if (!ready || !map.current) return;
    const instance = map.current;

    const onClick = (event: maplibregl.MapMouseEvent): void => {
      const layerIds = CLICKABLE_LAYERS.filter((id) => instance.getLayer(id));
      const feature = instance.queryRenderedFeatures(event.point, { layers: [...layerIds] })[0];
      if (!feature) return;
      const id = String(feature.properties?.id ?? '');
      switch (feature.layer.id) {
        case SOURCE.cameras: {
          const camera = latest.current.cameras.find((item) => item.id === id);
          if (camera) setSelection({ type: 'camera', camera });
          break;
        }
        case SOURCE.radio: {
          const station = latest.current.radio.find((item) => item.id === id);
          if (station) setSelection({ type: 'radio', station });
          break;
        }
        case SOURCE.hazards: {
          const hazard = latest.current.hazards.find((item) => item.id === id);
          if (hazard) setSelection({ type: 'hazard', hazard });
          break;
        }
        case SOURCE.satellites:
          setSelectedSatellite(Number(id));
          break;
      }
    };
    const onEnter = (): void => {
      instance.getCanvas().style.cursor = 'pointer';
    };
    const onLeave = (): void => {
      instance.getCanvas().style.cursor = '';
    };

    instance.on('click', onClick);
    for (const id of CLICKABLE_LAYERS) {
      instance.on('mouseenter', id, onEnter);
      instance.on('mouseleave', id, onLeave);
    }
    return () => {
      instance.off('click', onClick);
      for (const id of CLICKABLE_LAYERS) {
        instance.off('mouseenter', id, onEnter);
        instance.off('mouseleave', id, onLeave);
      }
    };
  }, [ready]);

  const flyTo = (latitude: number, longitude: number, zoom = 10): void => {
    map.current?.flyTo({ center: [longitude, latitude], zoom, duration: 1100 });
  };

  const toggle = (layer: LayerId): void => setLayers((current) => ({ ...current, [layer]: !current[layer] }));
  const zoom = view?.zoom ?? 0;
  const selectedPoint = satellitePoints.find((point) => point.noradId === selectedSatellite) ?? null;

  return (
    <div className="grid h-[calc(100vh-105px)] gap-4 xl:grid-cols-[1fr_340px]">
      <Panel
        title={t('sit.title')}
        meta={<span className="tnum">{countsLabel(t, hazards.data, cameras.data, radio.data, satellitePoints.length)}</span>}
        className="relative overflow-hidden"
      >
        <div ref={container} className="h-[calc(100%-33px)] min-h-[420px] w-full" />

        <div className="pointer-events-none absolute left-3 top-[45px] z-10 flex flex-col gap-2">
          <div className="pointer-events-auto">
            <PlaceSearch onPick={(result) => flyTo(result.latitude, result.longitude, 11)} />
          </div>
          <div className="pointer-events-auto flex flex-wrap gap-1">
            {(Object.keys(LAYER_LABEL) as LayerId[]).map((layer) => (
              <button
                key={layer}
                onClick={() => toggle(layer)}
                aria-pressed={layers[layer]}
                className={`border px-2 py-1 font-mono text-[0.5625rem] uppercase tracking-[0.14em] backdrop-blur transition-colors ${
                  layers[layer]
                    ? 'border-[var(--color-signal)] bg-[color-mix(in_srgb,var(--color-signal)_14%,transparent)] text-[var(--color-signal)]'
                    : 'border-[var(--color-hairline-bright)] bg-[color-mix(in_srgb,var(--color-void)_80%,transparent)] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]'
                }`}
              >
                {t(LAYER_LABEL[layer])}
              </button>
            ))}
          </div>
          <LayerHints
            zoom={zoom}
            layers={layers}
            trafficEnabled={traffic.data?.enabled ?? false}
            trafficNote={traffic.data?.note ?? null}
          />
        </div>
      </Panel>

      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
        {selection?.type === 'camera' && (
          <CameraViewer camera={selection.camera} onClose={() => setSelection(null)} />
        )}
        {selection?.type === 'radio' && (
          <RadioPlayer station={selection.station} onClose={() => setSelection(null)} />
        )}
        {selection?.type === 'hazard' && (
          <HazardDetail hazard={selection.hazard} onClose={() => setSelection(null)} />
        )}
        {!selection && (
          <ExposurePanel onFocus={(item) => flyTo(item.latitude, item.longitude, 8)} />
        )}
        {layers.satellites && view && (
          <SatellitePanel
            group={satelliteGroup}
            onGroupChange={(group) => {
              setSatelliteGroup(group);
              setSelectedSatellite(null);
            }}
            observer={view.center}
            selected={selectedPoint}
            tracked={satellitePoints.length}
          />
        )}
        <SourcesPanel hazards={hazards.data} cameras={cameras.data} radio={radio.data} tle={tle.data} traffic={traffic.data} />
      </div>
    </div>
  );
}

function LayerHints({
  zoom,
  layers,
  trafficEnabled,
  trafficNote,
}: {
  zoom: number;
  layers: Record<LayerId, boolean>;
  trafficEnabled: boolean;
  trafficNote: string | null;
}) {
  const { t } = useI18n();
  const hints: string[] = [];
  if (layers.cameras && zoom < MIN_ZOOM.cameras) hints.push(t('sit.hint.zoomCameras'));
  if (layers.radio && zoom < MIN_ZOOM.radio) hints.push(t('sit.hint.zoomRadio'));
  if (layers.traffic && !trafficEnabled) hints.push(trafficNote ?? t('sit.hint.trafficOff'));
  if (hints.length === 0) return null;
  return (
    <div className="pointer-events-auto max-w-[280px] space-y-0.5 border border-[var(--color-hairline)] bg-[color-mix(in_srgb,var(--color-void)_88%,transparent)] px-2.5 py-1.5">
      {hints.map((hint) => (
        <p key={hint} className="font-mono text-[0.5625rem] leading-snug text-[var(--color-ink-faint)]">
          {hint}
        </p>
      ))}
    </div>
  );
}

function readView(instance: MapLibreMap): MapView {
  const bounds = instance.getBounds();
  const center = instance.getCenter();
  return {
    bounds: {
      minLat: bounds.getSouth(),
      minLon: Math.max(-180, bounds.getWest()),
      maxLat: bounds.getNorth(),
      maxLon: Math.min(180, bounds.getEast()),
    },
    center: { latitude: center.lat, longitude: wrap(center.lng) },
    zoom: instance.getZoom(),
  };
}

/** Radio search radius that roughly matches what is on screen. */
function radiusForZoom(zoom: number): number {
  return Math.round(Math.min(1000, Math.max(25, 1200 / 2 ** Math.max(0, zoom - 4))));
}

function wrap(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function countsLabel(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  hazards: HazardsResponse | undefined,
  cameras: CamerasResponse | undefined,
  radio: RadioResponse | undefined,
  satellites: number,
): string {
  return t('sit.counts', {
    hazards: hazards?.hazards.length ?? 0,
    cameras: cameras?.cameras.length ?? 0,
    radio: radio?.stations.length ?? 0,
    satellites,
  });
}
