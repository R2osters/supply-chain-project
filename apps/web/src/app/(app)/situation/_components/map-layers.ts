import type maplibregl from 'maplibre-gl';
import type { Camera, Hazard, HazardKind, HazardTone, RadioStation } from '@/lib/intel';
import { HAZARD_TONE } from '@/lib/intel';
import type { SubPoint } from '@/lib/orbits';
import type { Palette } from '@/lib/theme';
import { apiUrl } from '@/lib/api';

/**
 * The situation map's layers, as GeoJSON sources plus MapLibre style layers.
 *
 * GeoJSON circles rather than one DOM marker per feature: a city view can hold a thousand
 * cameras and radio stations, and a thousand absolutely-positioned DOM nodes repainting on every
 * pan is what makes a map feel sluggish. The GPU draws circles for free.
 *
 * Colours follow the charte: everything nominal is grey, only a hazard's severity earns crit or
 * warn. Paint is literal hex (MapLibre cannot read CSS variables), so `applyIntelPalette` repaints
 * every layer when the theme changes.
 *
 * The converters are pure so the shape of what reaches the map is testable without a browser.
 */

type FeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>>;

export const SOURCE = {
  hazards: 'intel-hazards',
  hazardCones: 'intel-hazard-cones',
  hazardTracks: 'intel-hazard-tracks',
  cameras: 'intel-cameras',
  radio: 'intel-radio',
  satellites: 'intel-satellites',
  satelliteTrack: 'intel-satellite-track',
  traffic: 'intel-traffic',
} as const;

/** The kind icon drawn on top of each hazard disc; shares the hazards source. */
export const HAZARD_ICON_LAYER = 'intel-hazard-icons';

/** Layer ids that answer clicks, in the order a click should prefer them. */
export const CLICKABLE_LAYERS = ['intel-cameras', 'intel-radio', 'intel-satellites', 'intel-hazards'] as const;

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Sprite id for one kind drawn in one tone; see `hazard-icons.ts`. */
export function hazardIconId(kind: HazardKind, tone: HazardTone): string {
  return `hazard-${kind}-${tone}`;
}

export function hazardsToGeoJson(hazards: Hazard[], selectedId: string | null = null): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: hazards.map((hazard) => ({
      type: 'Feature',
      id: hazard.id,
      geometry: { type: 'Point', coordinates: [hazard.longitude, hazard.latitude] },
      properties: {
        id: hazard.id,
        kind: hazard.kind,
        severityScore: hazard.severityScore,
        tone: HAZARD_TONE[hazard.severity],
        icon: hazardIconId(hazard.kind, HAZARD_TONE[hazard.severity]),
        selected: hazard.id === selectedId,
      },
    })),
  };
}

export function conesToGeoJson(hazards: Hazard[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: hazards
      .filter((hazard) => hazard.cone && hazard.cone.length > 0)
      .map((hazard) => ({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: hazard.cone as Array<Array<[number, number]>> },
        properties: { id: hazard.id, tone: HAZARD_TONE[hazard.severity] },
      })),
  };
}

export function tracksToGeoJson(hazards: Hazard[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: hazards
      .filter((hazard) => hazard.track && hazard.track.length > 1)
      .map((hazard) => ({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: (hazard.track ?? []).map((point) => [point.longitude, point.latitude]),
        },
        properties: { id: hazard.id, tone: HAZARD_TONE[hazard.severity] },
      })),
  };
}

export function camerasToGeoJson(cameras: Camera[]): FeatureCollection {
  return pointsToGeoJson(cameras, (camera) => ({ id: camera.id }));
}

export function radioToGeoJson(stations: RadioStation[]): FeatureCollection {
  return pointsToGeoJson(stations, (station) => ({ id: station.id }));
}

export function satellitesToGeoJson(points: SubPoint[], selectedId: number | null): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: points.map((point) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
      properties: { id: String(point.noradId), selected: point.noradId === selectedId },
    })),
  };
}

export function trackToGeoJson(segments: Array<Array<[number, number]>>): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: segments.map((coordinates) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
      properties: {},
    })),
  };
}

function pointsToGeoJson<T extends { latitude: number; longitude: number }>(
  items: T[],
  properties: (item: T) => Record<string, unknown>,
): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: items.map((item) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [item.longitude, item.latitude] },
      properties: properties(item),
    })),
  };
}

/** `['match', ['get', 'tone'], 'crit', …, 'warn', …, muted]` — the severity colour of a feature. */
function toneExpression(palette: Palette): maplibregl.ExpressionSpecification {
  return ['match', ['get', 'tone'], 'crit', palette.crit, 'warn', palette.warn, palette.muted];
}

/**
 * Every paint property that carries a colour, keyed by layer. One table so the first install and
 * a theme switch can never disagree.
 */
function palettePaint(palette: Palette): Record<string, Record<string, unknown>> {
  return {
    [SOURCE.hazardCones]: { 'fill-color': toneExpression(palette) },
    [SOURCE.hazardTracks]: { 'line-color': toneExpression(palette) },
    [SOURCE.hazards]: {
      'circle-color': palette.surface2,
      'circle-stroke-color': ['case', ['get', 'selected'], palette.ink, toneExpression(palette)],
    },
    [SOURCE.satelliteTrack]: { 'line-color': palette.muted },
    [SOURCE.satellites]: {
      'circle-color': ['case', ['get', 'selected'], palette.ink, palette.dim],
      'circle-stroke-color': palette.surface2,
    },
    [SOURCE.radio]: { 'circle-color': palette.surface2, 'circle-stroke-color': palette.muted },
    [SOURCE.cameras]: { 'circle-color': palette.ink, 'circle-stroke-color': palette.surface2 },
  };
}

/** Adds every source and layer once, empty. Visibility and data are set afterwards. */
export function installIntelLayers(map: maplibregl.Map, palette: Palette): void {
  for (const id of Object.values(SOURCE)) {
    if (id === SOURCE.traffic || map.getSource(id)) continue;
    map.addSource(id, { type: 'geojson', data: EMPTY });
  }

  // Traffic sits directly above the basemap and below every point layer, so congestion colours
  // never hide a camera or a hazard.
  if (!map.getSource(SOURCE.traffic)) {
    map.addSource(SOURCE.traffic, {
      type: 'raster',
      tiles: [apiUrl('/traffic/tiles/{z}/{x}/{y}')],
      tileSize: 256,
      minzoom: 3,
      maxzoom: 18,
    });
    map.addLayer({
      id: SOURCE.traffic,
      type: 'raster',
      source: SOURCE.traffic,
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': 0.85 },
    });
  }

  const paint = palettePaint(palette);

  // The cone is context, not a marker: translucent enough that the basemap and the assets under
  // it stay readable.
  map.addLayer({
    id: SOURCE.hazardCones,
    type: 'fill',
    source: SOURCE.hazardCones,
    paint: { ...paint[SOURCE.hazardCones], 'fill-opacity': 0.14 } as maplibregl.FillLayerSpecification['paint'],
  });
  map.addLayer({
    id: SOURCE.hazardTracks,
    type: 'line',
    source: SOURCE.hazardTracks,
    paint: {
      ...paint[SOURCE.hazardTracks],
      'line-width': 1.5,
      'line-dasharray': [2, 2],
    } as maplibregl.LineLayerSpecification['paint'],
  });
  // A light disc ringed in the severity colour, with the kind icon on top: severity reads from
  // the ring, kind from the pictogram, and neither depends on hue alone.
  map.addLayer({
    id: SOURCE.hazards,
    type: 'circle',
    source: SOURCE.hazards,
    paint: {
      ...paint[SOURCE.hazards],
      'circle-radius': ['interpolate', ['linear'], ['get', 'severityScore'], 0, 10, 1, 14],
      'circle-opacity': 0.94,
      'circle-stroke-width': ['case', ['get', 'selected'], 3, 1.75],
    } as maplibregl.CircleLayerSpecification['paint'],
  });
  map.addLayer({
    id: HAZARD_ICON_LAYER,
    type: 'symbol',
    source: SOURCE.hazards,
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': 1,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
  map.addLayer({
    id: SOURCE.satelliteTrack,
    type: 'line',
    source: SOURCE.satelliteTrack,
    paint: { ...paint[SOURCE.satelliteTrack], 'line-width': 1, 'line-opacity': 0.6 } as maplibregl.LineLayerSpecification['paint'],
  });
  map.addLayer({
    id: SOURCE.satellites,
    type: 'circle',
    source: SOURCE.satellites,
    paint: {
      ...paint[SOURCE.satellites],
      'circle-radius': ['case', ['get', 'selected'], 6, 3.5],
      'circle-stroke-width': 1,
    } as maplibregl.CircleLayerSpecification['paint'],
  });
  // Radio as hollow rings and cameras as solid dots: two neutral shapes, told apart without hue.
  map.addLayer({
    id: SOURCE.radio,
    type: 'circle',
    source: SOURCE.radio,
    paint: {
      ...paint[SOURCE.radio],
      'circle-radius': 4.5,
      'circle-stroke-width': 1.75,
    } as maplibregl.CircleLayerSpecification['paint'],
  });
  map.addLayer({
    id: SOURCE.cameras,
    type: 'circle',
    source: SOURCE.cameras,
    paint: {
      ...paint[SOURCE.cameras],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 12, 5.5],
      'circle-stroke-width': 1,
    } as maplibregl.CircleLayerSpecification['paint'],
  });
}

/** Repaints every data layer for a new palette (theme switch) without rebuilding the style. */
export function applyIntelPalette(map: maplibregl.Map, palette: Palette): void {
  for (const [layerId, properties] of Object.entries(palettePaint(palette))) {
    if (!map.getLayer(layerId)) continue;
    for (const [property, value] of Object.entries(properties)) {
      map.setPaintProperty(layerId, property, value);
    }
  }
}

export function setSourceData(map: maplibregl.Map, sourceId: string, data: FeatureCollection): void {
  const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
  source?.setData(data);
}

export function setLayerVisible(map: maplibregl.Map, layerIds: string[], visible: boolean): void {
  for (const id of layerIds) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}
