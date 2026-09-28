import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
  type SatRec,
} from 'satellite.js';
import type { TleRecord } from './intel';

/**
 * Satellite positions computed in the browser.
 *
 * The API hands out orbital elements (TLEs), not positions. Propagating with SGP4 locally costs
 * microseconds per satellite, so the map can move 30 GPS satellites every second without a
 * single extra request — whereas polling positions from the server would cost one request per
 * viewer per second and still look jerky. CelesTrak asks clients to refetch elements at most
 * every two hours, and elements stay accurate to a few kilometres for days, which is plenty for
 * a map.
 */

export interface OrbitingSatellite {
  noradId: number;
  name: string;
  satrec: SatRec;
}

export interface SubPoint {
  noradId: number;
  name: string;
  latitude: number;
  longitude: number;
  altitudeKm: number;
}

export function buildSatrecs(records: TleRecord[]): OrbitingSatellite[] {
  const built: OrbitingSatellite[] = [];
  for (const record of records) {
    try {
      const satrec = twoline2satrec(record.line1, record.line2);
      if (satrec.error === 0) built.push({ noradId: record.noradId, name: record.name, satrec });
    } catch {
      // A malformed element set is skipped rather than taking the whole layer down.
    }
  }
  return built;
}

export function subPointAt(satellite: OrbitingSatellite, when: Date): SubPoint | null {
  const state = propagate(satellite.satrec, when);
  const position = state?.position;
  if (!position || typeof position === 'boolean') return null;
  const geodetic = eciToGeodetic(position, gstime(when));
  const latitude = degreesLat(geodetic.latitude);
  const longitude = degreesLong(geodetic.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    noradId: satellite.noradId,
    name: satellite.name,
    latitude,
    longitude,
    altitudeKm: geodetic.height,
  };
}

/** Ground track for the next `minutes`, split where it crosses the antimeridian. */
export function groundTrack(
  satellite: OrbitingSatellite,
  from: Date,
  minutes: number,
  stepMinutes = 1,
): Array<Array<[number, number]>> {
  const segments: Array<Array<[number, number]>> = [[]];
  let previousLon: number | null = null;
  for (let minute = 0; minute <= minutes; minute += stepMinutes) {
    const point = subPointAt(satellite, new Date(from.getTime() + minute * 60_000));
    if (!point) continue;
    if (previousLon !== null && Math.abs(point.longitude - previousLon) > 180) segments.push([]);
    segments[segments.length - 1].push([point.longitude, point.latitude]);
    previousLon = point.longitude;
  }
  return segments.filter((segment) => segment.length > 1);
}
