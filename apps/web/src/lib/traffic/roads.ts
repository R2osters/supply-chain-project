/**
 * OpenMapTiles `transportation` features → drivable roads for the traffic simulation.
 *
 * The map loads OpenFreeMap vector tiles and hands their `transportation` features here (via
 * `querySourceFeatures`). Only roads cars drive on are kept; each gets a free-flow speed and a
 * density weight by class, so a motorway carries far more simulated traffic than a side street.
 * Coordinates are always [lon, lat].
 */

export type RoadClass =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'minor'
  | 'service';

export const ROAD_CLASS_SPEED_KMH: Record<RoadClass, number> = {
  motorway: 110,
  trunk: 90,
  primary: 70,
  secondary: 60,
  tertiary: 50,
  minor: 40,
  service: 20,
};

export const ROAD_CLASS_WEIGHT: Record<RoadClass, number> = {
  motorway: 1,
  trunk: 0.8,
  primary: 0.6,
  secondary: 0.45,
  tertiary: 0.3,
  minor: 0.12,
  service: 0.05,
};

/** Car parks and driveways would bury the real network under dots when zoomed out. */
const SERVICE_MIN_ZOOM = 15;
const EARTH_RADIUS_M = 6_371_008.8;

export interface Road {
  /** Stable across tiles and map moves, so the simulation keeps a road's dots. */
  id: string;
  roadClass: RoadClass;
  coordinates: [number, number][];
  /** 1: one-way in drawing order; -1: one-way against it; 0: two-way. */
  oneway: 0 | 1 | -1;
  freeSpeedKmh: number;
  densityWeight: number;
  lengthM: number;
}

/** The shape MapLibre's `querySourceFeatures` returns, without importing maplibre-gl. */
export interface TransportationFeature {
  id?: string | number;
  properties: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown };
}

/** Great-circle length of a polyline in metres. */
export function lengthM(coordinates: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    total += haversineM(coordinates[i - 1], coordinates[i]);
  }
  return total;
}

function haversineM([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function roadClass(value: unknown, zoom: number): RoadClass | null {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(ROAD_CLASS_SPEED_KMH, value)) {
    return null;
  }
  if (value === 'service' && zoom < SERVICE_MIN_ZOOM) return null;
  return value as RoadClass;
}

function oneway(value: unknown): 0 | 1 | -1 {
  const n = Number(value);
  return n === 1 ? 1 : n === -1 ? -1 : 0;
}

function isPoint(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

/** Valid [lon, lat] points with consecutive repeats removed: a zero-length step has no heading. */
function cleanLine(raw: unknown): [number, number][] {
  if (!Array.isArray(raw)) return [];
  const points: [number, number][] = [];
  for (const value of raw) {
    if (!isPoint(value)) continue;
    const point: [number, number] = [value[0], value[1]];
    const previous = points[points.length - 1];
    if (previous && previous[0] === point[0] && previous[1] === point[1]) continue;
    points.push(point);
  }
  return points;
}

function linesOf(geometry: TransportationFeature['geometry']): unknown[] {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates;
  }
  return [];
}

function pointKey([lon, lat]: [number, number]): string {
  return `${lon.toFixed(6)},${lat.toFixed(6)}`;
}

export function roadsFromFeatures(features: TransportationFeature[], zoom: number): Road[] {
  const roads = new Map<string, Road>();
  for (const feature of features) {
    const cls = roadClass(feature.properties?.class, zoom);
    if (!cls) continue;
    for (const raw of linesOf(feature.geometry)) {
      const coordinates = cleanLine(raw);
      if (coordinates.length < 2) continue;
      const id = `${cls}:${pointKey(coordinates[0])}:${pointKey(coordinates[coordinates.length - 1])}:${coordinates.length}`;
      if (roads.has(id)) continue;
      roads.set(id, {
        id,
        roadClass: cls,
        coordinates,
        oneway: oneway(feature.properties?.oneway),
        freeSpeedKmh: ROAD_CLASS_SPEED_KMH[cls],
        densityWeight: ROAD_CLASS_WEIGHT[cls],
        lengthM: lengthM(coordinates),
      });
    }
  }
  return [...roads.values()];
}
