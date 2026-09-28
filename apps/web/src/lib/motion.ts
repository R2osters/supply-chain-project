/**
 * Smooth motion from choppy position reports.
 *
 * Trackers and AIS report every 5–30 seconds. Moving a marker straight to each new fix makes a
 * fleet teleport across the map in jumps, and the eye reads jumps as "something is wrong". The
 * technique, adapted from God's Eye View (MIT, `src/data/motionModel.js`):
 *
 *   1. When a fix arrives, glide from wherever the marker is *drawn* now to the new fix, over
 *      roughly one reporting interval. Starting from the drawn position (not the previous fix)
 *      is what prevents a visible snap when a fix arrives mid-glide.
 *   2. After arriving, keep moving along the reported heading at the reported speed (dead
 *      reckoning) for a short, capped time, so a vehicle at 80 km/h does not freeze between
 *      reports. The cap matters: a truck whose tracker died must not drive on forever on screen.
 *
 * Everything here is pure; the map page owns the animation frame loop.
 */

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface MotionTrack {
  from: GeoPoint;
  to: GeoPoint;
  startMs: number;
  durationMs: number;
  speedKmh: number | null;
  headingDegrees: number | null;
  /** Longest time a marker may be extrapolated past its last fix. */
  deadReckonCapMs: number;
}

const MIN_GLIDE_MS = 800;
const MAX_GLIDE_MS = 8_000;
/** Below this the vehicle is parked and GPS jitter would make it crawl around the yard. */
const STATIONARY_KMH = 3;
const EARTH_RADIUS_KM = 6371.0088;

export function easeInOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/** Linear blend that takes the short way across the antimeridian. */
export function lerpPoint(a: GeoPoint, b: GeoPoint, t: number): GeoPoint {
  let deltaLon = b.longitude - a.longitude;
  if (deltaLon > 180) deltaLon -= 360;
  if (deltaLon < -180) deltaLon += 360;
  return {
    latitude: a.latitude + (b.latitude - a.latitude) * t,
    longitude: wrapLongitude(a.longitude + deltaLon * t),
  };
}

/** Moves a point along a heading for a duration, on a sphere. */
export function deadReckon(
  origin: GeoPoint,
  speedKmh: number,
  headingDegrees: number,
  elapsedMs: number,
): GeoPoint {
  const distanceKm = (speedKmh * elapsedMs) / 3_600_000;
  const angular = distanceKm / EARTH_RADIUS_KM;
  const bearing = (headingDegrees * Math.PI) / 180;
  const lat1 = (origin.latitude * Math.PI) / 180;
  const lon1 = (origin.longitude * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { latitude: (lat2 * 180) / Math.PI, longitude: wrapLongitude((lon2 * 180) / Math.PI) };
}

/** Clamps the observed reporting interval into a glide duration that still looks deliberate. */
export function glideDurationMs(reportIntervalMs: number | null): number {
  if (reportIntervalMs === null || !Number.isFinite(reportIntervalMs)) return 2_000;
  return Math.min(MAX_GLIDE_MS, Math.max(MIN_GLIDE_MS, reportIntervalMs));
}

export function startTrack(
  drawnNow: GeoPoint | null,
  fix: GeoPoint & { speedKmh: number | null; headingDegrees: number | null },
  nowMs: number,
  reportIntervalMs: number | null,
): MotionTrack {
  const target = { latitude: fix.latitude, longitude: fix.longitude };
  return {
    from: drawnNow ?? target,
    to: target,
    startMs: nowMs,
    durationMs: drawnNow ? glideDurationMs(reportIntervalMs) : 0,
    speedKmh: fix.speedKmh,
    headingDegrees: fix.headingDegrees,
    deadReckonCapMs: 15_000,
  };
}

export function positionAt(track: MotionTrack, nowMs: number): GeoPoint {
  const elapsed = nowMs - track.startMs;
  if (track.durationMs > 0 && elapsed < track.durationMs) {
    return lerpPoint(track.from, track.to, easeInOutCubic(elapsed / track.durationMs));
  }

  const overrun = Math.min(elapsed - track.durationMs, track.deadReckonCapMs);
  const canCoast =
    track.speedKmh !== null &&
    track.speedKmh > STATIONARY_KMH &&
    track.headingDegrees !== null &&
    Number.isFinite(track.headingDegrees);
  if (!canCoast || overrun <= 0) return track.to;
  return deadReckon(track.to, track.speedKmh as number, track.headingDegrees as number, overrun);
}

/** True while the marker still needs redrawing every frame. */
export function isTrackAnimating(track: MotionTrack, nowMs: number): boolean {
  const coasting = (track.speedKmh ?? 0) > STATIONARY_KMH && track.headingDegrees !== null;
  const horizon = track.durationMs + (coasting ? track.deadReckonCapMs : 0);
  return nowMs - track.startMs < horizon;
}

function wrapLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}
