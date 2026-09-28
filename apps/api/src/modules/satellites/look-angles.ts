/**
 * Where a satellite appears in the sky from a point on the ground.
 *
 * SGP4 (via satellite.js) turns a TLE into an inertial position at an instant; rotating that into
 * the Earth-fixed frame and then into the observer's local horizon gives azimuth, elevation and
 * slant range. This is the same computation a GNSS receiver's almanac does to decide which
 * satellites to search for, which is why it is a fair proxy for "how good will a fix be here".
 */

import {
  degreesToRadians,
  eciToEcf,
  ecfToLookAngles,
  gstime,
  propagate,
  radiansToDegrees,
  twoline2satrec,
} from 'satellite.js';
import type { TleRecord } from './tle';

export interface Observer {
  latitude: number;
  longitude: number;
  /** Metres above the ellipsoid; a truck on a road is close enough to 0. */
  altitudeM?: number;
}

export interface LookAngle {
  elevationDeg: number;
  azimuthDeg: number;
  rangeKm: number;
}

export interface VisibleSatellite extends LookAngle {
  noradId: number;
  name: string;
}

export type FixQuality = 'GOOD' | 'FAIR' | 'POOR';

/** Look angle at `at`, or null when SGP4 cannot propagate the set (decayed orbit, bad elements). */
export function computeLookAngle(tle: Pick<TleRecord, 'line1' | 'line2'>, observer: Observer, at: Date): LookAngle | null {
  let state: ReturnType<typeof propagate> | null;
  try {
    state = propagate(twoline2satrec(tle.line1, tle.line2), at);
  } catch {
    return null;
  }
  // satellite.js signals propagation errors with a null result or a non-object position.
  const position = state?.position;
  if (!position || typeof position !== 'object' || ![position.x, position.y, position.z].every(Number.isFinite)) {
    return null;
  }

  const ecf = eciToEcf(position, gstime(at));
  const angles = ecfToLookAngles(
    {
      latitude: degreesToRadians(observer.latitude),
      longitude: degreesToRadians(observer.longitude),
      height: (observer.altitudeM ?? 0) / 1000,
    },
    ecf,
  );
  const azimuth = (radiansToDegrees(angles.azimuth) + 360) % 360;
  return {
    elevationDeg: round2(radiansToDegrees(angles.elevation)),
    azimuthDeg: round2(azimuth),
    rangeKm: Math.round(angles.rangeSat),
  };
}

/** Satellites at or above the elevation mask, highest first. */
export function findVisible(
  records: TleRecord[],
  observer: Observer,
  at: Date,
  minElevationDeg: number,
): VisibleSatellite[] {
  const visible: VisibleSatellite[] = [];
  for (const record of records) {
    const angle = computeLookAngle(record, observer, at);
    if (angle && angle.elevationDeg >= minElevationDeg) {
      visible.push({ noradId: record.noradId, name: record.name, ...angle });
    }
  }
  return visible.sort((a, b) => b.elevationDeg - a.elevationDeg);
}

/**
 * Fix quality from satellite geometry alone.
 *
 * A position fix needs four satellites (three coordinates plus the receiver's clock error), so
 * fewer than 4 above the mask is POOR: no fix, or one that wanders by tens of metres. With open
 * sky a single constellation typically shows 8–12 satellites above 10°, so 8 or more is GOOD —
 * but only if at least 4 are also above 30°. Low satellites are the first thing lost to
 * buildings, trees, cuttings and a truck cab, and their signals cross the most atmosphere, so a
 * sky that only has low satellites behaves like a much emptier one on a real road. Everything in
 * between is FAIR.
 *
 * This is geometry, not signal: it cannot see a tunnel or jamming. It answers "should the fix be
 * good here right now", which is what explains a jumpy track on the map.
 */
export function assessFixQuality(visible: Pick<LookAngle, 'elevationDeg'>[]): {
  count: number;
  above30Deg: number;
  quality: FixQuality;
} {
  const count = visible.length;
  const above30Deg = visible.filter((satellite) => satellite.elevationDeg >= 30).length;
  let quality: FixQuality = 'FAIR';
  if (count < 4) quality = 'POOR';
  else if (count >= 8 && above30Deg >= 4) quality = 'GOOD';
  return { count, above30Deg, quality };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
