'use client';

import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import { basemapStyle, useBasemapTheme, watchBasemapTiles } from '@/lib/map-style';
import { usePalette, type Palette } from '@/lib/theme';

type Coordinate = [number, number];

const PLANNED = 'planned';
const ACTUAL = 'actual';
const ENDPOINTS = 'endpoints';

/**
 * Planned (info blue, dashed) against actual (ink, solid) for one shipment, on the shared
 * basemap. GL paint is literal colour, so every layer is repainted when the theme changes.
 */
export function TrackMap({
  planned,
  actual,
  origin,
  destination,
  label,
}: {
  planned: Coordinate[];
  actual: Coordinate[];
  origin: Coordinate;
  destination: Coordinate;
  label: string;
}) {
  const palette = usePalette();
  const paletteRef = useRef<Palette>(palette);
  paletteRef.current = palette;
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const framed = useRef(false);

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = new maplibregl.Map({
      container: container.current,
      style: basemapStyle(paletteRef.current),
      center: [-1, 6.4],
      zoom: 6,
      attributionControl: { compact: true },
    });
    watchBasemapTiles(instance);
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.on('load', () => setReady(true));
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
      framed.current = false;
      setReady(false);
    };
  }, []);

  useBasemapTheme(ready ? map.current : null, palette);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    const colours = paletteRef.current;

    upsertLine(instance, PLANNED, planned, {
      'line-color': colours.info,
      'line-width': 1.8,
      'line-opacity': 0.9,
      'line-dasharray': [2, 2],
    });
    upsertLine(instance, ACTUAL, actual.length > 1 ? actual : [], {
      'line-color': colours.ink,
      'line-width': 2.6,
      'line-opacity': 0.95,
    });

    const endpoints: GeoJSON.FeatureCollection<GeoJSON.Point> = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { kind: 'origin' }, geometry: { type: 'Point', coordinates: origin } },
        { type: 'Feature', properties: { kind: 'destination' }, geometry: { type: 'Point', coordinates: destination } },
        ...(actual.length > 0
          ? [
              {
                type: 'Feature' as const,
                properties: { kind: 'current' },
                geometry: { type: 'Point' as const, coordinates: actual[actual.length - 1] },
              },
            ]
          : []),
      ],
    };
    const source = instance.getSource(ENDPOINTS) as maplibregl.GeoJSONSource | undefined;
    if (source) source.setData(endpoints);
    else {
      instance.addSource(ENDPOINTS, { type: 'geojson', data: endpoints });
      instance.addLayer({
        id: ENDPOINTS,
        type: 'circle',
        source: ENDPOINTS,
        paint: endpointPaint(colours) as never,
      });
    }

    // Frame once; a 20 s refetch must not yank the view away from where the user panned.
    if (!framed.current) {
      const bounds = new maplibregl.LngLatBounds();
      for (const coordinate of [...planned, ...actual, origin, destination]) bounds.extend(coordinate);
      if (!bounds.isEmpty()) instance.fitBounds(bounds, { padding: 46, duration: 700, maxZoom: 11 });
      framed.current = true;
    }
  }, [ready, planned, actual, origin, destination]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    if (instance.getLayer(PLANNED)) instance.setPaintProperty(PLANNED, 'line-color', palette.info);
    if (instance.getLayer(ACTUAL)) instance.setPaintProperty(ACTUAL, 'line-color', palette.ink);
    if (instance.getLayer(ENDPOINTS)) {
      for (const [key, value] of Object.entries(endpointPaint(palette))) {
        instance.setPaintProperty(ENDPOINTS, key, value);
      }
    }
  }, [ready, palette]);

  return <div ref={container} role="region" aria-label={label} className="h-[360px] w-full bg-[var(--color-map)]" />;
}

/** Origin hollow, destination ink, last fix accent. */
function endpointPaint(colours: Palette) {
  return {
    'circle-radius': ['match', ['get', 'kind'], 'current', 6, 5],
    'circle-color': ['match', ['get', 'kind'], 'origin', colours.surface2, 'current', colours.accent, colours.ink],
    'circle-stroke-color': ['match', ['get', 'kind'], 'origin', colours.ink, colours.surface2],
    'circle-stroke-width': 2,
  };
}

function upsertLine(map: MapLibreMap, id: string, coordinates: Coordinate[], paint: Record<string, unknown>): void {
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
