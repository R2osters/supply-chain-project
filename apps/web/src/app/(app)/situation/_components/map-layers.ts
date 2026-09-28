import type maplibregl from 'maplibre-gl';
import type { Camera, Hazard, RadioStation } from '@/lib/intel';
import { HAZARD_COLOUR } from '@/lib/intel';
import type { SubPoint } from '@/lib/orbits';
import { apiUrl } from '@/lib/api';

/**
 * The situation map's layers, as GeoJSON sources plus MapLibre style layers.
 *
 * GeoJSON circles rather than one DOM marker per feature: a city view can hold a thousand
 * cameras and radio stations, and a thousand absolutely-positioned DOM nodes repainting on every
 * pan is what makes a map feel sluggish. The GPU draws circles for free.
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

/** Layer ids that answer clicks, in the order a click should prefer them. */
export const CLICKABLE_LAYERS = ['intel-cameras', 'intel-radio', 'intel-satellites', 'intel-hazards'] as const;

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

export function hazardsToGeoJson(hazards: Hazard[]): FeatureCollection {
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
        colour: HAZARD_COLOUR[hazard.kind],
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
        properties: { id: hazard.id },
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
        properties: { id: hazard.id },
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

/** Adds every source and layer once, empty. Visibility and data are set afterwards. */
export function installIntelLayers(map: maplibregl.Map): void {
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

  map.addLayer({
    id: SOURCE.hazardCones,
    type: 'fill',
    source: SOURCE.hazardCones,
    paint: { 'fill-color': HAZARD_COLOUR.CYCLONE, 'fill-opacity': 0.12 },
  });
  map.addLayer({
    id: SOURCE.hazardTracks,
    type: 'line',
    source: SOURCE.hazardTracks,
    paint: { 'line-color': HAZARD_COLOUR.CYCLONE, 'line-width': 1.5, 'line-dasharray': [2, 2] },
  });
  map.addLayer({
    id: SOURCE.hazards,
    type: 'circle',
    source: SOURCE.hazards,
    paint: {
      'circle-color': ['get', 'colour'],
      'circle-radius': ['interpolate', ['linear'], ['get', 'severityScore'], 0, 4, 1, 11],
      'circle-opacity': 0.8,
      'circle-stroke-color': '#08090a',
      'circle-stroke-width': 1,
    },
  });
  map.addLayer({
    id: SOURCE.satelliteTrack,
    type: 'line',
    source: SOURCE.satelliteTrack,
    paint: { 'line-color': '#e6e9ea', 'line-width': 1, 'line-opacity': 0.45 },
  });
  map.addLayer({
    id: SOURCE.satellites,
    type: 'circle',
    source: SOURCE.satellites,
    paint: {
      'circle-color': ['case', ['get', 'selected'], '#ffb020', '#e6e9ea'],
      'circle-radius': ['case', ['get', 'selected'], 6, 3.5],
      'circle-stroke-color': '#08090a',
      'circle-stroke-width': 1,
    },
  });
  map.addLayer({
    id: SOURCE.radio,
    type: 'circle',
    source: SOURCE.radio,
    paint: {
      'circle-color': '#3fcf8e',
      'circle-radius': 4,
      'circle-stroke-color': '#08090a',
      'circle-stroke-width': 1,
    },
  });
  map.addLayer({
    id: SOURCE.cameras,
    type: 'circle',
    source: SOURCE.cameras,
    paint: {
      'circle-color': '#4ea8ff',
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 12, 6],
      'circle-stroke-color': '#08090a',
      'circle-stroke-width': 1,
    },
  });
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
