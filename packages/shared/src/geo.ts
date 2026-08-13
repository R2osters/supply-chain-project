/**
 * Spherical geometry helpers.
 *
 * These live in application code rather than only in PostGIS so that the ETA engine and the
 * anomaly detector are unit-testable with no database, and so the web app can compute the same
 * numbers client-side without a round trip. PostGIS still owns spatial *indexing* (GiST on the
 * generated geography columns) — that is what it is good at.
 *
 * Earth is modelled as a sphere of radius 6 371 008.8 m (IUGG mean radius). Error versus the
 * WGS-84 ellipsoid is under 0.3 % for the distances involved here (road legs, geofences), which
 * is far below the noise of GPS sampling and road winding.
 */

export const EARTH_RADIUS_M = 6_371_008.8;

export interface LatLng {
  latitude: number;
  longitude: number;
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

export function isValidLatLng(p: Partial<LatLng> | null | undefined): p is LatLng {
  return (
    !!p &&
    typeof p.latitude === 'number' &&
    typeof p.longitude === 'number' &&
    Number.isFinite(p.latitude) &&
    Number.isFinite(p.longitude) &&
    p.latitude >= -90 &&
    p.latitude <= 90 &&
    p.longitude >= -180 &&
    p.longitude <= 180
  );
}

/** Great-circle distance in metres. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const haversineKm = (a: LatLng, b: LatLng): number => haversineMeters(a, b) / 1000;

/** Initial bearing from `a` to `b`, degrees clockwise from true north, in [0, 360). */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const dLon = toRad(b.longitude - a.longitude);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point reached by travelling `distanceM` from `origin` along `bearingDeg`. */
export function destinationPoint(origin: LatLng, bearingDeg: number, distanceM: number): LatLng {
  const delta = distanceM / EARTH_RADIUS_M;
  const theta = toRad(bearingDeg);
  const lat1 = toRad(origin.latitude);
  const lon1 = toRad(origin.longitude);

  const sinLat2 = Math.sin(lat1) * Math.cos(delta) + Math.cos(lat1) * Math.sin(delta) * Math.cos(theta);
  const lat2 = Math.asin(Math.min(1, Math.max(-1, sinLat2)));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(lat1),
      Math.cos(delta) - Math.sin(lat1) * sinLat2,
    );

  return {
    latitude: toDeg(lat2),
    longitude: ((toDeg(lon2) + 540) % 360) - 180,
  };
}

/**
 * Signed perpendicular distance from `point` to the great circle through `start`→`end`.
 * Positive = right of the path. Used raw only when the projection falls inside the segment;
 * `distanceToSegmentMeters` handles the general case.
 */
export function crossTrackMeters(point: LatLng, start: LatLng, end: LatLng): number {
  const d13 = haversineMeters(start, point) / EARTH_RADIUS_M;
  const theta13 = toRad(bearingDegrees(start, point));
  const theta12 = toRad(bearingDegrees(start, end));
  return Math.asin(Math.sin(d13) * Math.sin(theta13 - theta12)) * EARTH_RADIUS_M;
}

/** Distance travelled along `start`→`end` of the projection of `point`. */
export function alongTrackMeters(point: LatLng, start: LatLng, end: LatLng): number {
  const d13 = haversineMeters(start, point) / EARTH_RADIUS_M;
  const dxt = crossTrackMeters(point, start, end) / EARTH_RADIUS_M;
  const inner = Math.cos(d13) / Math.cos(dxt);
  return Math.acos(Math.min(1, Math.max(-1, inner))) * EARTH_RADIUS_M;
}

/** Shortest distance from `point` to the segment `start`→`end` (clamped at the endpoints). */
export function distanceToSegmentMeters(point: LatLng, start: LatLng, end: LatLng): number {
  const segmentLength = haversineMeters(start, end);
  if (segmentLength < 1e-6) return haversineMeters(point, start);

  const along = alongTrackMeters(point, start, end);
  if (along < 0) return haversineMeters(point, start);
  if (along > segmentLength) return haversineMeters(point, end);
  return Math.abs(crossTrackMeters(point, start, end));
}

/** Shortest distance from `point` to a polyline. Returns Infinity for a polyline with < 1 vertex. */
export function distanceToPolylineMeters(point: LatLng, polyline: LatLng[]): number {
  if (polyline.length === 0) return Number.POSITIVE_INFINITY;
  if (polyline.length === 1) return haversineMeters(point, polyline[0]);

  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const d = distanceToSegmentMeters(point, polyline[i], polyline[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

/** Total length of a polyline in metres. */
export function polylineLengthMeters(polyline: LatLng[]): number {
  let total = 0;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    total += haversineMeters(polyline[i], polyline[i + 1]);
  }
  return total;
}

/**
 * Remaining distance along a polyline from the position nearest to `point` to the polyline end.
 * Snaps `point` onto its closest segment first, so a vehicle a few hundred metres off the road
 * still gets a sane remaining distance.
 */
export function remainingDistanceAlongPolylineMeters(point: LatLng, polyline: LatLng[]): number {
  if (polyline.length < 2) return 0;

  let bestSegment = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const d = distanceToSegmentMeters(point, polyline[i], polyline[i + 1]);
    if (d < bestDistance) {
      bestDistance = d;
      bestSegment = i;
    }
  }

  const segStart = polyline[bestSegment];
  const segEnd = polyline[bestSegment + 1];
  const segLength = haversineMeters(segStart, segEnd);
  const along = Math.min(Math.max(alongTrackMeters(point, segStart, segEnd), 0), segLength);

  let remaining = segLength - along;
  for (let i = bestSegment + 1; i < polyline.length - 1; i += 1) {
    remaining += haversineMeters(polyline[i], polyline[i + 1]);
  }
  return remaining;
}

/**
 * Interpolates a position `fraction` of the way along a polyline (0 = start, 1 = end).
 * Used by the telemetry simulator to move a vehicle realistically along its planned route.
 */
export function interpolateAlongPolyline(polyline: LatLng[], fraction: number): LatLng {
  if (polyline.length === 0) throw new Error('interpolateAlongPolyline: empty polyline');
  if (polyline.length === 1) return polyline[0];

  const clamped = Math.min(Math.max(fraction, 0), 1);
  const target = polylineLengthMeters(polyline) * clamped;

  let travelled = 0;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const segLength = haversineMeters(polyline[i], polyline[i + 1]);
    if (travelled + segLength >= target) {
      const into = target - travelled;
      const bearing = bearingDegrees(polyline[i], polyline[i + 1]);
      return destinationPoint(polyline[i], bearing, into);
    }
    travelled += segLength;
  }
  return polyline[polyline.length - 1];
}

/** Bounding box padded by `padMeters`, for cheap pre-filtering before exact distance work. */
export function boundingBox(points: LatLng[], padMeters = 0): {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
} {
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  const latPad = toDeg(padMeters / EARTH_RADIUS_M);
  const meanLat = toRad(lats.reduce((s, v) => s + v, 0) / Math.max(lats.length, 1));
  const lngPad = latPad / Math.max(Math.cos(meanLat), 1e-6);

  return {
    minLat: Math.min(...lats) - latPad,
    maxLat: Math.max(...lats) + latPad,
    minLng: Math.min(...lngs) - lngPad,
    maxLng: Math.max(...lngs) + lngPad,
  };
}
