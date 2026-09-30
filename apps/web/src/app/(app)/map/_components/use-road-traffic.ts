'use client';

/**
 * Road traffic on the live map, wired onto MapLibre:
 *
 * - roads come from OpenFreeMap vector tiles (keyless, worldwide); an invisible line layer makes
 *   MapLibre load them, and `querySourceFeatures` reads them back after each move;
 * - measurements come from the API: keyless open data (`/traffic/open-flow`) and, with the user's
 *   key, TomTom vector flow tiles (`/traffic/flow-tiles`), drawn as green/orange/red lines;
 * - the simulation (lib/traffic) runs on the roads in view and a WebGL layer draws its dots.
 *
 * Matching and dot planning run after a move settles and when new measurements arrive, never per
 * frame: per frame only the dots advance.
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiUrl } from '@/lib/api';
import type { Palette } from '@/lib/theme';
import { matchFlow, type FlowLine, type FlowSource } from '@/lib/traffic/flow-match';
import { roadsFromFeatures, type TransportationFeature } from '@/lib/traffic/roads';
import { TrafficSimulation } from '@/lib/traffic/simulation';
import {
  DOTS_MIN_ZOOM,
  LINES_MIN_ZOOM,
  flowLinesFromOpenFlow,
  flowLinesFromTomTom,
  inView,
  measuredSourcesOf,
  openFlowBboxKey,
  roadsInView,
  type OpenFlowCollection,
  type TileFeature,
  type View,
} from './road-traffic';
import { createRoadTrafficLayer, trafficColours, type DotColours, type RoadTrafficLayer } from './road-traffic-layer';

export const ROAD_TRAFFIC = {
  roads: 'road-traffic-roads',
  probe: 'road-traffic-roads-probe',
  open: 'road-traffic-open',
  openLines: 'road-traffic-open-lines',
  openClosed: 'road-traffic-open-closed',
  tomtom: 'road-traffic-tomtom',
  tomtomLines: 'road-traffic-tomtom-lines',
  tomtomClosed: 'road-traffic-tomtom-closed',
  dots: 'road-traffic-dots',
} as const;

/** OpenFreeMap: OpenMapTiles schema, © OpenMapTiles, data © OpenStreetMap contributors (ODbL). */
const ROADS_TILEJSON = 'https://tiles.openfreemap.org/planet';
const DRIVABLE = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'];
const TOMTOM_LAYER = 'Traffic flow';
const REBUILD_DEBOUNCE_MS = 500;
const OPEN_FLOW_POLL_MS = 60_000;

export interface RoadTrafficOptions {
  enabled: boolean;
  /** A TomTom key is configured on the API. */
  tomtom: boolean;
  /** The lowest layer the traffic must stay under: the fleet's first GL layer. */
  beforeLayerId?: string;
}

export interface RoadTrafficState {
  zoom: number;
  /** The road tiles failed to load (offline, OpenFreeMap unreachable). */
  roadsFailed: boolean;
  /** Sources with a measure among the roads in view. */
  measuredSources: FlowSource[];
  dots: number;
}

const viewOf = (map: MapLibreMap): View => {
  const bounds = map.getBounds();
  return { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() };
};

/** Colour by level with the spec's thresholds: < 0.55 jam, < 0.85 slow, else free. */
function levelColour(palette: Palette, property: string) {
  return [
    'case',
    ['<', ['to-number', ['get', property], 1], 0.55],
    palette.crit,
    ['<', ['to-number', ['get', property], 1], 0.85],
    palette.warn,
    palette.ok,
  ] as unknown as string;
}

const CLOSED_TOMTOM: ExpressionSpecification = ['any', ['==', ['get', 'road_closure'], true], ['==', ['get', 'road_closure'], 'true']];
const LINE_WIDTH = ['interpolate', ['linear'], ['zoom'], LINES_MIN_ZOOM, 1.2, 16, 4] as unknown as number;

export function useRoadTraffic(
  map: MapLibreMap | null,
  ready: boolean,
  palette: Palette,
  { enabled, tomtom, beforeLayerId }: RoadTrafficOptions,
): RoadTrafficState {
  const simulation = useMemo(() => new TrafficSimulation(), []);
  const colours = useRef<DotColours>(trafficColours(palette));
  colours.current = trafficColours(palette);
  const layer = useRef<RoadTrafficLayer | null>(null);
  const openLines = useRef<FlowLine[]>([]);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const [installed, setInstalled] = useState(false);
  const [view, setView] = useState<{ key: string | null; zoom: number }>({ key: null, zoom: 0 });
  const [state, setState] = useState<RoadTrafficState>({ zoom: 0, roadsFailed: false, measuredSources: [], dots: 0 });

  /* ------------------------------------------------------------ install */

  useEffect(() => {
    if (!ready || !map) return;
    const before = beforeLayerId && map.getLayer(beforeLayerId) ? beforeLayerId : undefined;

    if (!map.getSource(ROAD_TRAFFIC.roads)) map.addSource(ROAD_TRAFFIC.roads, { type: 'vector', url: ROADS_TILEJSON });
    if (!map.getLayer(ROAD_TRAFFIC.probe)) {
      // Invisible: only here so MapLibre loads the road tiles that querySourceFeatures reads.
      map.addLayer(
        {
          id: ROAD_TRAFFIC.probe,
          type: 'line',
          source: ROAD_TRAFFIC.roads,
          'source-layer': 'transportation',
          minzoom: DOTS_MIN_ZOOM,
          filter: ['in', ['get', 'class'], ['literal', DRIVABLE]],
          paint: { 'line-opacity': 0 },
        },
        before,
      );
    }
    if (!map.getSource(ROAD_TRAFFIC.open)) {
      map.addSource(ROAD_TRAFFIC.open, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getLayer(ROAD_TRAFFIC.openLines)) {
      map.addLayer(
        {
          id: ROAD_TRAFFIC.openLines,
          type: 'line',
          source: ROAD_TRAFFIC.open,
          minzoom: LINES_MIN_ZOOM,
          filter: ['all', ['!=', ['get', 'closed'], true], ['!=', ['get', 'level'], null]],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': levelColour(palette, 'level'), 'line-width': LINE_WIDTH, 'line-opacity': 0.55 },
        },
        before,
      );
      map.addLayer(
        {
          id: ROAD_TRAFFIC.openClosed,
          type: 'line',
          source: ROAD_TRAFFIC.open,
          minzoom: LINES_MIN_ZOOM,
          filter: ['==', ['get', 'closed'], true],
          paint: { 'line-color': palette.crit, 'line-width': LINE_WIDTH, 'line-opacity': 0.8, 'line-dasharray': [2, 2] },
        },
        before,
      );
    }
    if (!map.getLayer(ROAD_TRAFFIC.dots)) {
      const dots = createRoadTrafficLayer(ROAD_TRAFFIC.dots, simulation, () => colours.current);
      layer.current = dots;
      map.addLayer(dots, before);
    }
    setInstalled(true);
    return () => setInstalled(false);
    // Palette changes repaint the lines below instead of reinstalling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, map, beforeLayerId, simulation]);

  // TomTom flow tiles only when a key is set: without one every tile would be a 404.
  useEffect(() => {
    if (!installed || !map) return;
    const before = map.getLayer(ROAD_TRAFFIC.dots) ? ROAD_TRAFFIC.dots : undefined;
    if (tomtom && !map.getSource(ROAD_TRAFFIC.tomtom)) {
      // maxzoom 12: one z12 tile covers a district; closer views reuse it instead of spending budget.
      map.addSource(ROAD_TRAFFIC.tomtom, { type: 'vector', tiles: [apiUrl('/traffic/flow-tiles/{z}/{x}/{y}')], maxzoom: 12 });
      map.addLayer(
        {
          id: ROAD_TRAFFIC.tomtomLines,
          type: 'line',
          source: ROAD_TRAFFIC.tomtom,
          'source-layer': TOMTOM_LAYER,
          minzoom: LINES_MIN_ZOOM,
          // A feature without a level is not a measure: to-number(null) would paint it red.
          filter: ['all', ['has', 'traffic_level'], ['!', CLOSED_TOMTOM]],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': levelColour(palette, 'traffic_level'), 'line-width': LINE_WIDTH, 'line-opacity': 0.5 },
        },
        before,
      );
      map.addLayer(
        {
          id: ROAD_TRAFFIC.tomtomClosed,
          type: 'line',
          source: ROAD_TRAFFIC.tomtom,
          'source-layer': TOMTOM_LAYER,
          minzoom: LINES_MIN_ZOOM,
          filter: CLOSED_TOMTOM,
          paint: { 'line-color': palette.crit, 'line-width': LINE_WIDTH, 'line-opacity': 0.8, 'line-dasharray': [2, 2] },
        },
        before,
      );
    } else if (!tomtom && map.getSource(ROAD_TRAFFIC.tomtom)) {
      for (const id of [ROAD_TRAFFIC.tomtomLines, ROAD_TRAFFIC.tomtomClosed]) if (map.getLayer(id)) map.removeLayer(id);
      map.removeSource(ROAD_TRAFFIC.tomtom);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installed, map, tomtom]);

  /* --------------------------------------------------------- visibility */

  useEffect(() => {
    if (!installed || !map) return;
    const visibility = enabled ? 'visible' : 'none';
    for (const id of [ROAD_TRAFFIC.probe, ROAD_TRAFFIC.openLines, ROAD_TRAFFIC.openClosed, ROAD_TRAFFIC.tomtomLines, ROAD_TRAFFIC.tomtomClosed]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    }
  }, [installed, map, enabled, tomtom]);

  // GL layers hold literal colours: repaint them when the theme changes.
  useEffect(() => {
    if (!installed || !map) return;
    const paint = (id: string, property: string, value: unknown) => {
      if (map.getLayer(id)) map.setPaintProperty(id, property, value);
    };
    paint(ROAD_TRAFFIC.openLines, 'line-color', levelColour(palette, 'level'));
    paint(ROAD_TRAFFIC.openClosed, 'line-color', palette.crit);
    paint(ROAD_TRAFFIC.tomtomLines, 'line-color', levelColour(palette, 'traffic_level'));
    paint(ROAD_TRAFFIC.tomtomClosed, 'line-color', palette.crit);
  }, [installed, map, palette, tomtom]);

  /* ----------------------------------------------------------- rebuild */

  const rebuild = useCallback(() => {
    if (!map || !layer.current) return;
    const zoom = map.getZoom();
    if (!enabledRef.current || zoom < DOTS_MIN_ZOOM) {
      simulation.setRoads([], new Map(), zoom);
      layer.current.setActive(false);
      setState((current) => ({ ...current, zoom, measuredSources: [], dots: 0 }));
      return;
    }
    const view = viewOf(map);
    const features = map.querySourceFeatures(ROAD_TRAFFIC.roads, {
      sourceLayer: 'transportation',
      filter: ['in', ['get', 'class'], ['literal', DRIVABLE]],
    });
    const roads = roadsInView(roadsFromFeatures(features as unknown as TransportationFeature[], zoom), view);
    const tomtomLines = map.getSource(ROAD_TRAFFIC.tomtom)
      ? flowLinesFromTomTom(map.querySourceFeatures(ROAD_TRAFFIC.tomtom, { sourceLayer: TOMTOM_LAYER }) as unknown as TileFeature[])
      : [];
    const lines = inView([...openLines.current, ...tomtomLines], view);
    const flows = matchFlow(roads, lines);
    simulation.setRoads(roads, flows, zoom);
    layer.current.setActive(true);

    const matched = new Set<FlowSource>();
    for (const flow of flows.values()) {
      if (flow.forward) matched.add(flow.forward.source);
      if (flow.backward) matched.add(flow.backward.source);
    }
    setState((current) => ({
      ...current,
      zoom,
      measuredSources: measuredSourcesOf(lines.filter((line) => matched.has(line.source))),
      dots: simulation.dotCount,
    }));
  }, [map, simulation]);

  useEffect(() => {
    if (!installed || !map) return;
    let timer: number | null = null;
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const zoom = map.getZoom();
        const key = zoom >= LINES_MIN_ZOOM ? openFlowBboxKey(viewOf(map)) : null;
        // Same box and zoom: keep the state object, so the page does not re-render for nothing.
        setView((current) => (current.key === key && current.zoom === zoom ? current : { key, zoom }));
        rebuild();
      }, REBUILD_DEBOUNCE_MS);
    };
    // Road or flow tiles arriving after the move settled (slow network) must still get dots.
    const onData = (event: { sourceId?: string; isSourceLoaded?: boolean }) => {
      if (event.isSourceLoaded && (event.sourceId === ROAD_TRAFFIC.roads || event.sourceId === ROAD_TRAFFIC.tomtom)) {
        setState((current) => (current.roadsFailed && event.sourceId === ROAD_TRAFFIC.roads ? { ...current, roadsFailed: false } : current));
        schedule();
      }
    };
    const onError = (event: { sourceId?: string }) => {
      if (event.sourceId === ROAD_TRAFFIC.roads) setState((current) => ({ ...current, roadsFailed: true }));
    };
    schedule();
    map.on('moveend', schedule);
    map.on('sourcedata', onData);
    map.on('error', onError);
    return () => {
      map.off('moveend', schedule);
      map.off('sourcedata', onData);
      map.off('error', onError);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [installed, map, rebuild]);

  // Switching the layer on or off takes effect at once, not at the next move.
  useEffect(() => {
    if (installed) rebuild();
  }, [installed, enabled, rebuild]);

  /* ------------------------------------------------------- measurements */

  // TanStack pauses `refetchInterval` while the tab is hidden.
  const openFlow = useQuery({
    queryKey: ['traffic', 'open-flow', view.key],
    queryFn: ({ signal }) => api<OpenFlowCollection>(`/traffic/open-flow?bbox=${view.key}`, { signal }),
    enabled: enabled && view.key !== null,
    refetchInterval: OPEN_FLOW_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });

  useEffect(() => {
    if (!installed || !map) return;
    const data = enabled && view.key !== null ? openFlow.data : undefined;
    (map.getSource(ROAD_TRAFFIC.open) as GeoJSONSource | undefined)?.setData(
      (data ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection,
    );
    openLines.current = flowLinesFromOpenFlow(data);
    rebuild();
  }, [installed, map, enabled, view.key, openFlow.data, rebuild]);

  return state;
}
