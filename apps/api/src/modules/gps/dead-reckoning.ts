import {
  interpolateAlongPolyline,
  type LatLng,
  polylineLengthMeters,
  remainingDistanceAlongPolylineMeters,
} from '@scip/shared';

/**
 * Where a vehicle probably is when its GPS has gone quiet.
 *
 * A truck in a dead zone, with a flat tracker battery or a driver's phone switched off keeps
 * driving its planned route. So the estimate starts from the last fix (or the depot at departure),
 * projects it onto the planned corridor, and advances along it at the corridor's usual speed for
 * the time elapsed. It never leaves the route and never passes the destination.
 *
 * The answer is a circle, not a point: the vehicle may have stopped, queued or sped up, so the
 * radius grows with the distance the estimate had to guess. The UI draws it dashed and labelled
 * "estimated", and the moment a real fix arrives the estimate disappears.
 */

export interface LastFix {
  position: LatLng;
  at: Date;
}

export interface EstimateInputs {
  /** Planned corridor, origin first. Two points (origin, destination) is a valid straight path. */
  path: LatLng[];
  now: Date;
  /** Actual departure, else planned: the starting clock when there has been no fix at all. */
  departedAt: Date;
  lastFix: LastFix | null;
  /** The vehicle's cruising speed, used when the corridor has no planned duration. */
  nominalSpeedKmh: number;
  /** Planned corridor duration; distance over duration is the realistic average, stops included. */
  plannedDurationMinutes?: number | null;
}

export interface PositionEstimate {
  latitude: number;
  longitude: number;
  /** Radius of the circle the vehicle is believed to be in. */
  radiusKm: number;
  /** Share of the corridor covered, 0 to 1. */
  progress: number;
  /** What the estimate was advanced from. */
  basis: 'last-fix' | 'departure';
  minutesSinceBasis: number;
  /** Speed the estimate assumed, km/h. */
  assumedSpeedKmh: number;
  /** The estimate reached the destination: the vehicle has probably arrived. */
  atDestination: boolean;
}

/** Below this, a quiet tracker is normal jitter between fixes, not a gap worth estimating. */
export const GPS_SILENT_AFTER_MINUTES = 5;
/** Past this, a guess is fiction: the vehicle is shown as lost rather than placed. */
export const MAX_ESTIMATE_HOURS = 12;
/**
 * Without a planned duration, cruising speed overstates progress because trucks stop (fuel,
 * checkpoints, breaks). 85 % matches the ratio between corridor averages and cruising speeds in
 * the demo network, and errs on the side of "not there yet".
 */
const STOP_ALLOWANCE = 0.85;
/** Share of the guessed distance the radius grows by, on top of a floor. */
const RADIUS_GROWTH = 0.35;
const RADIUS_FLOOR_KM = 1;
const MIN_SPEED_KMH = 5;

export function assumedSpeedKmh(inputs: Pick<EstimateInputs, 'path' | 'nominalSpeedKmh' | 'plannedDurationMinutes'>): number {
  const lengthKm = polylineLengthMeters(inputs.path) / 1000;
  if (inputs.plannedDurationMinutes && inputs.plannedDurationMinutes > 0 && lengthKm > 0) {
    return Math.max(MIN_SPEED_KMH, lengthKm / (inputs.plannedDurationMinutes / 60));
  }
  return Math.max(MIN_SPEED_KMH, inputs.nominalSpeedKmh * STOP_ALLOWANCE);
}

/** Returns null when there is nothing sensible to estimate (no path, or silent too long). */
export function estimatePosition(inputs: EstimateInputs): PositionEstimate | null {
  const { path, now, lastFix } = inputs;
  if (path.length < 2) return null;
  const lengthM = polylineLengthMeters(path);
  if (lengthM <= 0) return null;

  const basis: PositionEstimate['basis'] = lastFix ? 'last-fix' : 'departure';
  const since = lastFix ? lastFix.at : inputs.departedAt;
  const elapsedHours = Math.max(0, (now.getTime() - since.getTime()) / 3_600_000);
  if (elapsedHours > MAX_ESTIMATE_HOURS) return null;

  const startAlongM = lastFix ? lengthM - remainingDistanceAlongPolylineMeters(lastFix.position, path) : 0;
  const speed = assumedSpeedKmh(inputs);
  const guessedM = speed * elapsedHours * 1000;
  const alongM = Math.min(lengthM, Math.max(0, startAlongM) + guessedM);
  const point = interpolateAlongPolyline(path, alongM / lengthM);
  // Only the distance actually guessed widens the circle; a vehicle parked at its destination
  // does not become less certain the longer it waits there.
  const guessedKm = (alongM - Math.max(0, startAlongM)) / 1000;

  return {
    latitude: point.latitude,
    longitude: point.longitude,
    radiusKm: round(Math.max(RADIUS_FLOOR_KM, RADIUS_FLOOR_KM + guessedKm * RADIUS_GROWTH), 1),
    progress: round(alongM / lengthM, 3),
    basis,
    minutesSinceBasis: Math.round(elapsedHours * 60),
    assumedSpeedKmh: round(speed, 1),
    atDestination: alongM >= lengthM - 1,
  };
}

/** Accepts the `routes.polyline` JSON column and discards anything that is not a coordinate. */
export function parsePolyline(value: unknown): LatLng[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (p): p is LatLng =>
      typeof p === 'object' &&
      p !== null &&
      Number.isFinite((p as LatLng).latitude) &&
      Number.isFinite((p as LatLng).longitude),
  );
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
