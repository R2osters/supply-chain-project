'use client';

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import { basemapStyle, useBasemapTheme } from '@/lib/map-style';
import { usePalette } from '@/lib/theme';

export interface MapRoute {
  vehicleId: string;
  vehicleName: string;
  /** Ordered [lon, lat] from the depot, through the stops, back to the depot. */
  path: Array<[number, number]>;
  /** Stops in visiting order (depot excluded), with their position in the sequence. */
  stops: Array<{ id: string; name: string; order: number; coord: [number, number] }>;
}

const SOURCE = 'routes';
const LAYER_OTHER = 'routes-other';
const LAYER_SELECTED = 'routes-selected';

/**
 * The solved routes on the SCIP basemap. The solver returns no road geometry, so each route is
 * drawn as straight segments between stops in visiting order — honest about what is known: the
 * order, not the roads. The selected route is ink, the others muted.
 */
export function RouteMap({
  depot,
  routes,
  selected,
  onSelect,
  labels,
}: {
  depot: { name: string; coord: [number, number] } | null;
  routes: MapRoute[];
  selected: string | null;
  onSelect: (vehicleId: string) => void;
  labels: { depot: string };
}) {
  const palette = usePalette();
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const markers = useRef<maplibregl.Marker[]>([]);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Build the map once; the basemap follows the theme through useBasemapTheme.
  useEffect(() => {
    if (!container.current) return;
    const instance = new maplibregl.Map({
      container: container.current,
      style: basemapStyle(palette),
      center: [-1.0, 7.9],
      zoom: 6,
      attributionControl: { compact: true },
    });
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.on('load', () => {
      instance.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      instance.addLayer({
        id: LAYER_OTHER,
        type: 'line',
        source: SOURCE,
        filter: ['==', ['get', 'selected'], false],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': palette.muted, 'line-width': 2, 'line-opacity': 0.7 },
      });
      instance.addLayer({
        id: LAYER_SELECTED,
        type: 'line',
        source: SOURCE,
        filter: ['==', ['get', 'selected'], true],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': palette.ink, 'line-width': 3.5 },
      });
      for (const layer of [LAYER_OTHER, LAYER_SELECTED]) {
        instance.on('click', layer, (event) => {
          const id = event.features?.[0]?.properties?.vehicleId;
          if (typeof id === 'string') onSelectRef.current(id);
        });
        instance.on('mouseenter', layer, () => (instance.getCanvas().style.cursor = 'pointer'));
        instance.on('mouseleave', layer, () => (instance.getCanvas().style.cursor = ''));
      }
      setReady(true);
    });
    setMap(instance);
    return () => {
      markers.current.forEach((marker) => marker.remove());
      markers.current = [];
      instance.remove();
      setMap(null);
      setReady(false);
    };
    // The palette at creation only seeds the style; later changes are repainted below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useBasemapTheme(map, palette);

  // Data layers carry literal colours, so they are repainted on a theme switch.
  useEffect(() => {
    if (!map || !ready) return;
    map.setPaintProperty(LAYER_OTHER, 'line-color', palette.muted);
    map.setPaintProperty(LAYER_SELECTED, 'line-color', palette.ink);
  }, [map, ready, palette]);

  // Lines: one per vehicle.
  useEffect(() => {
    if (!map || !ready) return;
    const source = map.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined;
    source?.setData({
      type: 'FeatureCollection',
      features: routes
        .filter((route) => route.path.length > 1)
        .map((route) => ({
          type: 'Feature' as const,
          properties: { vehicleId: route.vehicleId, selected: route.vehicleId === selected },
          geometry: { type: 'LineString' as const, coordinates: route.path },
        })),
    });
  }, [map, ready, routes, selected]);

  // Markers: DOM elements styled with CSS variables, so they follow the theme on their own.
  useEffect(() => {
    if (!map) return;
    markers.current.forEach((marker) => marker.remove());
    markers.current = [];

    if (depot) {
      const element = document.createElement('div');
      element.title = `${labels.depot} · ${depot.name}`;
      element.setAttribute('aria-label', element.title);
      element.style.cssText =
        'width:18px;height:18px;border-radius:4px;background:var(--color-ink);border:2px solid var(--color-surface-2);box-shadow:var(--shadow-sm)';
      markers.current.push(new maplibregl.Marker({ element }).setLngLat(depot.coord).addTo(map));
    }

    // Draw unselected routes first so the selected route's numbers sit on top.
    const ordered = [...routes].sort(
      (a, b) => Number(a.vehicleId === selected) - Number(b.vehicleId === selected),
    );
    for (const route of ordered) {
      const active = route.vehicleId === selected;
      for (const stop of route.stops) {
        const element = document.createElement('button');
        element.type = 'button';
        element.textContent = String(stop.order);
        element.title = `${route.vehicleName} · ${stop.order}. ${stop.name}`;
        element.setAttribute('aria-label', element.title);
        element.style.cssText = [
          'width:22px;height:22px;border-radius:999px;display:flex;align-items:center;justify-content:center',
          "font:600 11px/1 var(--font-mono);cursor:pointer;box-shadow:var(--shadow-sm)",
          active
            ? 'background:var(--color-accent);color:var(--color-accent-tx);border:2px solid var(--color-surface-2)'
            : 'background:var(--color-surface-2);color:var(--color-muted);border:1px solid var(--color-line)',
        ].join(';');
        element.addEventListener('click', (event) => {
          event.stopPropagation();
          onSelectRef.current(route.vehicleId);
        });
        markers.current.push(new maplibregl.Marker({ element }).setLngLat(stop.coord).addTo(map));
      }
    }
  }, [map, depot, routes, selected, labels.depot]);

  // Frame the whole plan when a new result arrives (not on every selection change).
  useEffect(() => {
    if (!map) return;
    const bounds = new maplibregl.LngLatBounds();
    let any = false;
    if (depot) {
      bounds.extend(depot.coord);
      any = true;
    }
    for (const route of routes) {
      for (const coord of route.path) {
        bounds.extend(coord);
        any = true;
      }
    }
    if (any) map.fitBounds(bounds, { padding: 48, maxZoom: 12, duration: 600 });
  }, [map, depot, routes]);

  return <div ref={container} className="h-full w-full" />;
}
