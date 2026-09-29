'use client';

import { useQuery } from '@tanstack/react-query';
import { Cctv, CloudOff, Radio, Satellite, TrafficCone, TriangleAlert, type LucideIcon } from 'lucide-react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getAccessToken, isApiUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  boundsQuery,
  type Bounds,
  type Camera,
  type CamerasResponse,
  type Exposure,
  type ExposureResponse,
  type Hazard,
  type HazardKind,
  type HazardsResponse,
  type RadioResponse,
  type RadioStation,
  type TleResponse,
  type TrafficStatus,
} from '@/lib/intel';
import { useFormat, useI18n, type TranslationKey } from '@/lib/i18n';
import { basemapStyle, useBasemapTheme } from '@/lib/map-style';
import { buildSatrecs, groundTrack, subPointAt, type SubPoint } from '@/lib/orbits';
import { usePalette } from '@/lib/theme';
import { DisabledReason, PageHeader, Provenance } from '@/components/ui';
import { CameraViewer } from '@/components/intel/camera-viewer';
import { ExposurePanel } from './_components/exposure-panel';
import { HazardDetail } from './_components/hazard-detail';
import { installHazardIcons } from './_components/hazard-icons';
import { KIND_ICON, KIND_KEY, rankHazards, sourceFor } from './_components/hazard-kind';
import { IncidentForm } from './_components/incident-form';
import {
  CLICKABLE_LAYERS,
  HAZARD_ICON_LAYER,
  SOURCE,
  applyIntelPalette,
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
import { SignalList } from './_components/signal-list';
import { SourcesPanel } from './_components/sources-panel';

/**
 * Situation room (charte 03 · TRACK · Situation): « Que se passe-t-il autour du réseau ? »
 *
 * Tracking tells an operator where the cargo is; this screen tells them what is happening there.
 * Natural hazards near warehouses and routes, ranked by how much of *our* network they touch;
 * public traffic cameras to see a road with their own eyes, local radio to hear traffic and news,
 * satellites overhead to judge GPS quality, and live congestion. Each layer is independent: one
 * feed being down never blanks the others, and a feed that is down says so.
 */

type LayerId = 'hazards' | 'cameras' | 'radio' | 'satellites' | 'traffic';

const LAYERS: Array<{ id: LayerId; label: TranslationKey; icon: LucideIcon }> = [
  { id: 'hazards', label: 'sit.layer.hazards', icon: TriangleAlert },
  { id: 'cameras', label: 'sit.layer.cameras', icon: Cctv },
  { id: 'radio', label: 'sit.layer.radio', icon: Radio },
  { id: 'satellites', label: 'sit.layer.satellites', icon: Satellite },
  { id: 'traffic', label: 'sit.layer.traffic', icon: TrafficCone },
];

const HAZARD_KINDS: HazardKind[] = ['CYCLONE', 'EARTHQUAKE', 'FIRE', 'SEVERE_WEATHER'];

/** Below these zooms a layer would mean thousands of points nobody can tell apart. */
const MIN_ZOOM = { cameras: 5, radio: 4 } as const;

type Selection =
  | { type: 'camera'; camera: Camera }
  | { type: 'radio'; station: RadioStation }
  | { type: 'hazard'; hazard: Hazard; drafting: boolean }
  | null;

interface MapView {
  bounds: Bounds;
  center: { latitude: number; longitude: number };
  zoom: number;
}

export default function SituationPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const palette = usePalette();
  const paletteRef = useRef(palette);
  paletteRef.current = palette;

  const container = useRef<HTMLDivElement | null>(null);
  const iconHost = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [mapInstance, setMapInstance] = useState<MapLibreMap | null>(null);
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
  const [pendingHazard, setPendingHazard] = useState<string | null>(null);
  const [satelliteGroup, setSatelliteGroup] = useState('gps-ops');
  const [selectedSatellite, setSelectedSatellite] = useState<number | null>(null);
  const [satellitePoints, setSatellitePoints] = useState<SubPoint[]>([]);

  /* ------------------------------------------------------------------ map */

  useEffect(() => {
    if (!container.current || map.current) return;
    const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL;
    const instance = new maplibregl.Map({
      container: container.current,
      style: styleUrl && styleUrl.length > 0 ? styleUrl : basemapStyle(paletteRef.current),
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
      installIntelLayers(instance, paletteRef.current);
      setReady(true);
      setView(readView(instance));
    });
    instance.on('moveend', publishView);

    map.current = instance;
    setMapInstance(instance);
    return () => {
      window.clearTimeout(debounce);
      instance.remove();
      map.current = null;
      setMapInstance(null);
      setReady(false);
    };
  }, []);

  useBasemapTheme(mapInstance, palette);

  // Data layers carry literal colours; repaint them and redraw the kind sprites on a theme switch.
  useEffect(() => {
    if (!ready || !map.current) return;
    applyIntelPalette(map.current, palette);
    if (iconHost.current) void installHazardIcons(map.current, iconHost.current, palette);
  }, [ready, palette]);

  /* ------------------------------------------------------------------ data */

  const hazardBox = view && view.zoom >= 3 ? `?${boundsQuery(view.bounds, 0)}` : '';
  const hazards = useQuery({
    queryKey: ['hazards', hazardBox],
    queryFn: () => api<HazardsResponse>(`/hazards${hazardBox}`),
    enabled: layers.hazards && view !== null,
    refetchInterval: 5 * 60_000,
    placeholderData: (previous) => previous,
  });

  // Global, not bounded to the view: an exposed warehouse off-screen still matters.
  const exposure = useQuery({
    queryKey: ['hazards', 'exposure'],
    queryFn: () => api<ExposureResponse>('/hazards/exposure'),
    refetchInterval: 5 * 60_000,
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
  const hazardList = useMemo(() => hazards.data?.hazards ?? [], [hazards.data]);
  const exposures = useMemo(() => exposure.data?.exposures ?? [], [exposure.data]);
  const ranked = useMemo(
    () => (layers.hazards ? rankHazards(hazardList, exposures) : []),
    [layers.hazards, hazardList, exposures],
  );
  const selectedHazardId = selection?.type === 'hazard' ? selection.hazard.id : null;

  /* ----------------------------------------------------------- map sync */

  useEffect(() => {
    if (!ready || !map.current) return;
    setSourceData(map.current, SOURCE.hazards, hazardsToGeoJson(hazardList, selectedHazardId));
    setSourceData(map.current, SOURCE.hazardCones, conesToGeoJson(hazardList));
    setSourceData(map.current, SOURCE.hazardTracks, tracksToGeoJson(hazardList));
  }, [ready, hazardList, selectedHazardId]);

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
    setLayerVisible(
      instance,
      [SOURCE.hazards, HAZARD_ICON_LAYER, SOURCE.hazardCones, SOURCE.hazardTracks],
      layers.hazards,
    );
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
    hazards: hazardList,
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
          if (hazard) setSelection({ type: 'hazard', hazard, drafting: false });
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

  const flyTo = useCallback((latitude: number, longitude: number, zoom = 10): void => {
    map.current?.flyTo({ center: [longitude, latitude], zoom, duration: 1100 });
  }, []);

  const selectHazard = useCallback(
    (hazard: Hazard): void => {
      setSelection({ type: 'hazard', hazard, drafting: false });
      flyTo(hazard.latitude, hazard.longitude, Math.max(map.current?.getZoom() ?? 6, 6));
    },
    [flyTo],
  );

  // An exposure may point at a hazard outside the current view; fly there, and select it once
  // the bounded hazard query for the new view has it.
  const focusExposure = (item: Exposure): void => {
    flyTo(item.latitude, item.longitude, 8);
    const hazard = hazardList.find((entry) => entry.id === item.hazardId);
    if (hazard) setSelection({ type: 'hazard', hazard, drafting: false });
    else setPendingHazard(item.hazardId);
  };

  useEffect(() => {
    if (!pendingHazard) return;
    const hazard = hazardList.find((entry) => entry.id === pendingHazard);
    if (hazard) {
      setSelection({ type: 'hazard', hazard, drafting: false });
      setPendingHazard(null);
    }
  }, [pendingHazard, hazardList]);

  // J / K walk the ranked signals (charte §10), unless the operator is typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      const key = event.key.toLowerCase();
      if ((key !== 'j' && key !== 'k') || ranked.length === 0) return;
      event.preventDefault();
      const index = ranked.findIndex((entry) => entry.hazard.id === selectedHazardId);
      const next =
        index < 0 ? 0 : key === 'j' ? Math.min(ranked.length - 1, index + 1) : Math.max(0, index - 1);
      selectHazard(ranked[next].hazard);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ranked, selectedHazardId, selectHazard]);

  const toggle = (layer: LayerId): void => setLayers((current) => ({ ...current, [layer]: !current[layer] }));
  const zoom = view?.zoom ?? 0;
  const selectedPoint = satellitePoints.find((point) => point.noradId === selectedSatellite) ?? null;

  /* ------------------------------------------------------------ derived */

  const exposedAssets = new Set(exposures.map((item) => `${item.subjectType}:${item.subjectId}`)).size;
  const title =
    exposure.isLoading && hazards.isLoading
      ? t('sit.v3.title.loading')
      : exposedAssets > 0
        ? exposedAssets === 1
          ? t('sit.v3.title.exposedOne')
          : t('sit.v3.title.exposedMany', { n: exposedAssets })
        : ranked.length > 0
          ? ranked.length === 1
            ? t('sit.v3.title.watchOne')
            : t('sit.v3.title.watchMany', { n: ranked.length })
          : t('sit.v3.title.calm');

  const counts: Record<LayerId, number | null> = {
    hazards: hazards.data ? hazardList.length : null,
    cameras: cameras.data && zoom >= MIN_ZOOM.cameras ? cameras.data.cameras.length : null,
    radio: radio.data && zoom >= MIN_ZOOM.radio ? radio.data.stations.length : null,
    satellites: layers.satellites ? satellitePoints.length : null,
    traffic: null,
  };
  const feedDown: Record<LayerId, boolean> = {
    hazards: hazards.isError || allDown(hazards.data?.sources ?? []),
    cameras: cameras.isError || allDown(cameras.data?.packs ?? []),
    radio: radio.isError || radio.data?.status === 'UNAVAILABLE',
    satellites: tle.isError,
    traffic: traffic.isError || (traffic.data !== undefined && !traffic.data.enabled),
  };

  const exposedFor = (hazard: Hazard): Exposure[] => exposures.filter((item) => item.hazardId === hazard.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={t('sit.v3.kicker')}
        title={title}
        description={t('sit.v3.question')}
        meta={
          <>
            <Provenance kind="poll" label={t('sit.v3.meta.refresh')} />
            <span className="t-data text-[11px] text-[var(--color-muted)]">
              {t('sit.counts', {
                hazards: hazardList.length,
                cameras: cameras.data?.cameras.length ?? 0,
                radio: radio.data?.stations.length ?? 0,
                satellites: satellitePoints.length,
              })}
            </span>
          </>
        }
        actions={
          selection?.type === 'hazard' ? undefined : <DisabledReason>{t('sit.v3.incident.pickFirst')}</DisabledReason>
        }
      />

      <div className="grid gap-4 xl:h-[calc(100dvh-270px)] xl:min-h-[580px] xl:grid-cols-[minmax(0,1fr)_360px]">
        {/* ----------------------------------------------------------- map */}
        <section
          className="panel rise relative h-[62vh] min-h-[420px] overflow-hidden xl:h-auto xl:min-h-0"
          aria-label={t('sit.v3.mapLabel')}
        >
          {/* maplibre-gl.css forces `position: relative` on the map node, so the absolute box is a wrapper. */}
          <div className="absolute inset-0">
            <div ref={container} className="h-full w-full" />
          </div>

          <div className="pointer-events-none absolute left-3 top-3 z-10 flex w-[min(440px,calc(100%-64px))] flex-col gap-2">
            <div className="map-card pointer-events-auto flex flex-col gap-3 p-3">
              <PlaceSearch onPick={(result) => flyTo(result.latitude, result.longitude, 11)} />
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('sit.v3.layers')}>
                {LAYERS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => toggle(id)}
                    aria-pressed={layers[id]}
                    className="pill h-8 px-3"
                    title={feedDown[id] ? t('sit.v3.layerDown') : undefined}
                  >
                    <Icon />
                    {t(label)}
                    {feedDown[id] ? (
                      <CloudOff aria-label={t('sit.v3.layerDown')} />
                    ) : (
                      layers[id] &&
                      counts[id] !== null && (
                        <span key={counts[id]} className="pill-count pop">
                          {fmt.int(counts[id])}
                        </span>
                      )
                    )}
                  </button>
                ))}
              </div>
            </div>
            <LayerHints
              zoom={zoom}
              layers={layers}
              trafficEnabled={traffic.data?.enabled ?? false}
              trafficNote={traffic.data?.note ?? null}
            />
          </div>

          {layers.hazards && <HazardLegend />}

          {/* Rendered once, hidden: the map sprites are drawn from these exact Lucide icons. */}
          <div ref={iconHost} hidden aria-hidden>
            {HAZARD_KINDS.map((kind) => {
              const Icon = KIND_ICON[kind];
              return <Icon key={kind} data-kind={kind} />;
            })}
          </div>
        </section>

        {/* -------------------------------------------------------- column */}
        <aside className="flex min-h-0 flex-col gap-4 xl:overflow-y-auto" aria-label={t('sit.v3.columnLabel')}>
          {selection?.type === 'hazard' && selection.drafting && (
            <div key={`draft:${selection.hazard.id}`} className="slide-in-right">
              <IncidentForm
                hazard={selection.hazard}
                exposed={exposedFor(selection.hazard)}
                onBack={() => setSelection({ ...selection, drafting: false })}
                onCreated={() => setSelection({ ...selection, drafting: false })}
              />
            </div>
          )}
          {selection?.type === 'hazard' && !selection.drafting && (
            <div key={`hazard:${selection.hazard.id}`} className="slide-in-right">
              <HazardDetail
                hazard={selection.hazard}
                exposed={exposedFor(selection.hazard)}
                source={sourceFor(selection.hazard, hazards.data?.sources ?? [])}
                canCreateIncident={can('incident:create')}
                onCreateIncident={() => setSelection({ ...selection, drafting: true })}
                onFocusExposure={(item) => flyTo(item.latitude, item.longitude, 9)}
                onClose={() => setSelection(null)}
              />
            </div>
          )}
          {selection?.type === 'camera' && (
            <div key={`camera:${selection.camera.id}`} className="slide-in-right">
              <CameraViewer camera={selection.camera} onClose={() => setSelection(null)} />
            </div>
          )}
          {selection?.type === 'radio' && (
            <div key={`radio:${selection.station.id}`} className="slide-in-right">
              <RadioPlayer station={selection.station} onClose={() => setSelection(null)} />
            </div>
          )}
          {!selection && (
            <>
              <SignalList
                hazards={hazards}
                ranked={ranked}
                layerOn={layers.hazards}
                onShowLayer={() => setLayers((current) => ({ ...current, hazards: true }))}
                selectedId={selectedHazardId}
                onSelect={selectHazard}
              />
              <ExposurePanel exposure={exposure} onFocus={focusExposure} />
            </>
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
              tle={tle.data}
            />
          )}
          <SourcesPanel hazards={hazards.data} cameras={cameras.data} radio={radio.data} tle={tle.data} traffic={traffic.data} />
        </aside>
      </div>
    </div>
  );
}

/** Severity by ring colour, kind by pictogram — the key to the map's hazard markers. */
function HazardLegend() {
  const { t } = useI18n();
  const tones: Array<[string, TranslationKey]> = [
    ['var(--color-crit)', 'sit.v3.legend.high'],
    ['var(--color-warn)', 'sit.v3.legend.medium'],
    ['var(--color-muted)', 'sit.v3.legend.low'],
  ];
  return (
    <div className="map-card pointer-events-auto absolute bottom-9 left-3 z-10 hidden max-w-[calc(100%-24px)] flex-col gap-1.5 px-3 py-2.5 text-[12px] text-[var(--color-muted)] md:flex">
      <ul className="m-0 flex list-none flex-wrap items-center gap-x-3 gap-y-1 p-0">
        {tones.map(([colour, label]) => (
          <li key={label} className="flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-3 rounded-full bg-[var(--color-surface-2)]"
              style={{ boxShadow: `inset 0 0 0 2px ${colour}` }}
            />
            {t(label)}
          </li>
        ))}
      </ul>
      <ul className="m-0 flex list-none flex-wrap items-center gap-x-3 gap-y-1 p-0">
        {HAZARD_KINDS.map((kind) => {
          const Icon = KIND_ICON[kind];
          return (
            <li key={kind} className="flex items-center gap-1.5">
              <Icon className="h-3.5 w-3.5" />
              {t(KIND_KEY[kind])}
            </li>
          );
        })}
      </ul>
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
    <div className="map-card fade-in pointer-events-auto flex flex-col gap-1 px-3 py-2" aria-live="polite">
      {hints.map((hint) => (
        <p key={hint} className="m-0 text-[12px] leading-snug text-[var(--color-muted)]">
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

/** A layer is "cut" only when every feed behind it is down; one live feed still draws. */
function allDown(feeds: Array<{ status: string }>): boolean {
  return feeds.length > 0 && feeds.every((feed) => feed.status === 'UNAVAILABLE');
}

/** Radio search radius that roughly matches what is on screen. */
function radiusForZoom(zoom: number): number {
  return Math.round(Math.min(1000, Math.max(25, 1200 / 2 ** Math.max(0, zoom - 4))));
}

function wrap(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}
