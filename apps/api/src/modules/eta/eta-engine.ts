import {
  haversineKm,
  remainingDistanceAlongPolylineMeters,
  type LatLng,
} from '@scip/shared';

/**
 * Deterministic ETA engine.
 *
 * The brief asks for `ETA = remaining distance / average speed` first, then progressively richer
 * inputs. This is that progression, done in one pass but with every term separable and
 * inspectable, because an ETA nobody can explain is an ETA nobody acts on.
 *
 *     remaining_km          from the planned route polyline when there is one, otherwise
 *                           great-circle distance × a road-winding factor
 *
 *     v_base                a blend of the observed speed on this trip and the prior for this
 *                           vehicle/carrier, weighted by how much observation exists:
 *                                w      = n / (n + k),   k = 5 samples
 *                                v_base = w·v_observed + (1 − w)·v_prior
 *
 *     v_effective           v_base × traffic × weather × night
 *
 *     duration              remaining_km / v_effective  + remaining scheduled stop time
 *
 * The multipliers are *modelling assumptions*, not measurements, and every response says so.
 * They are ordinary congestion/precipitation slowdowns, deliberately conservative; when a real
 * traffic or weather provider is configured its factor replaces the corresponding default.
 *
 * Uncertainty is propagated rather than invented. Duration is inversely proportional to speed, so
 * a relative speed error σ_v/v maps to roughly the same relative duration error, and the arrival
 * window is duration × (1 ± z·cv). The confidence score is the inverse of that spread, damped by
 * how far ahead the prediction reaches — an ETA eight hours out is genuinely less trustworthy
 * than one twenty minutes out, and the number should say so.
 */

export interface EtaInputs {
  /** Where the vehicle is now. Falls back to `origin` before departure. */
  currentLocation?: LatLng | null;
  origin: LatLng;
  destination: LatLng;
  /** Planned corridor. When present, remaining distance follows it instead of the straight line. */
  routePolyline?: LatLng[] | null;
  /** Speed prior for this vehicle type, km/h. */
  nominalSpeedKmh: number;
  /** Mean speed actually observed on this trip so far, km/h. */
  observedAverageSpeedKmh?: number | null;
  /** How many GPS samples that observation is based on. */
  observedSampleCount?: number;
  /** Historical mean and spread of speed for this carrier/corridor, if known. */
  historicalAverageSpeedKmh?: number | null;
  historicalSpeedStdKmh?: number | null;
  /** 0 = free flow, 1 = gridlock. */
  trafficCongestion?: number;
  /** 0 = clear, 1 = severe. */
  weatherSeverity?: number;
  /** Minutes of planned stops not yet taken (rest breaks, customs, intermediate drops). */
  remainingStopMinutes?: number;
  /** Multiplier turning great-circle distance into road distance when no polyline exists. */
  roadWindingFactor?: number;
  /** Reference instant. Injectable so tests are not clock-dependent. */
  now?: Date;
}

export interface EtaResult {
  estimatedArrival: Date;
  estimatedDurationSeconds: number;
  remainingDistanceKm: number;
  effectiveSpeedKmh: number;
  baseSpeedKmh: number;
  confidenceScore: number;
  arrivalWindow: { earliest: Date; latest: Date };
  factors: {
    traffic: number;
    weather: number;
    night: number;
    observationWeight: number;
  };
  assumptions: string[];
  reasons: string[];
}

/** GPS samples needed before the observed speed outweighs the prior. */
export const OBSERVATION_HALF_LIFE_SAMPLES = 5;

/** Slowest speed the engine will predict with. Below this an ETA is meaningless. */
export const MIN_EFFECTIVE_SPEED_KMH = 5;

/** Two-sided coverage of the arrival window. 80 % rather than 95 %: an over-wide window is ignored. */
export const WINDOW_CONFIDENCE_PERCENT = 80;
/** z for that coverage. */
export const WINDOW_Z = 1.2816;

/** Coefficient of variation assumed when nothing better is known. */
export const DEFAULT_SPEED_CV = 0.18;

/** Multiplier at full congestion: gridlock is assumed to halve effective speed, not stop it. */
export const MAX_TRAFFIC_PENALTY = 0.5;

/** Multiplier at the worst modelled weather. */
export const MAX_WEATHER_PENALTY = 0.35;

/** Night driving (22:00–05:00 local) — less traffic but more caution; a mild net gain. */
export const NIGHT_FACTOR = 1.05;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export function computeEta(inputs: EtaInputs): EtaResult {
  const now = inputs.now ?? new Date();
  const roadFactor = inputs.roadWindingFactor ?? 1.25;
  const position = inputs.currentLocation ?? inputs.origin;

  /* ---------------------------------------------------------- distance */

  let remainingKm: number;
  let distanceBasis: string;

  if (inputs.routePolyline && inputs.routePolyline.length >= 2) {
    remainingKm = remainingDistanceAlongPolylineMeters(position, inputs.routePolyline) / 1000;
    distanceBasis = 'remaining length of the planned route polyline';
  } else {
    remainingKm = haversineKm(position, inputs.destination) * roadFactor;
    distanceBasis = `great-circle distance × road-winding factor ${roadFactor}`;
  }
  remainingKm = Math.max(remainingKm, 0);

  /* ------------------------------------------------------------- speed */

  const samples = Math.max(inputs.observedSampleCount ?? 0, 0);
  const observationWeight =
    inputs.observedAverageSpeedKmh && inputs.observedAverageSpeedKmh > 0
      ? samples / (samples + OBSERVATION_HALF_LIFE_SAMPLES)
      : 0;

  const prior =
    inputs.historicalAverageSpeedKmh && inputs.historicalAverageSpeedKmh > 0
      ? inputs.historicalAverageSpeedKmh
      : inputs.nominalSpeedKmh;

  const baseSpeedKmh =
    observationWeight * (inputs.observedAverageSpeedKmh ?? prior) + (1 - observationWeight) * prior;

  const congestion = clamp(inputs.trafficCongestion ?? 0, 0, 1);
  const weather = clamp(inputs.weatherSeverity ?? 0, 0, 1);

  const trafficFactor = 1 - MAX_TRAFFIC_PENALTY * congestion;
  const weatherFactor = 1 - MAX_WEATHER_PENALTY * weather;
  const hour = now.getHours();
  const nightFactor = hour >= 22 || hour < 5 ? NIGHT_FACTOR : 1;

  const effectiveSpeedKmh = Math.max(
    baseSpeedKmh * trafficFactor * weatherFactor * nightFactor,
    MIN_EFFECTIVE_SPEED_KMH,
  );

  /* ---------------------------------------------------------- duration */

  const drivingSeconds = (remainingKm / effectiveSpeedKmh) * 3600;
  const stopSeconds = Math.max(inputs.remainingStopMinutes ?? 0, 0) * 60;
  const estimatedDurationSeconds = Math.round(drivingSeconds + stopSeconds);
  const estimatedArrival = new Date(now.getTime() + estimatedDurationSeconds * 1000);

  /* ------------------------------------------------------- uncertainty */

  // Relative speed uncertainty. A measured historical spread beats the default assumption.
  const relativeSpeedError =
    inputs.historicalSpeedStdKmh && prior > 0
      ? clamp(inputs.historicalSpeedStdKmh / prior, 0.02, 0.6)
      : DEFAULT_SPEED_CV;

  // Observation shrinks uncertainty: the more of this trip we have actually watched, the less
  // the prior's spread matters. It never reaches zero — the road ahead is still unobserved.
  const effectiveError = relativeSpeedError * (1 - 0.5 * observationWeight);

  const spreadSeconds = drivingSeconds * effectiveError * WINDOW_Z;
  const arrivalWindow = {
    earliest: new Date(estimatedArrival.getTime() - spreadSeconds * 1000),
    latest: new Date(estimatedArrival.getTime() + spreadSeconds * 1000),
  };

  // Confidence falls with relative spread and with how far ahead we are predicting. The horizon
  // term halves confidence roughly every 12 hours of remaining travel.
  const horizonHours = drivingSeconds / 3600;
  const horizonPenalty = 1 / (1 + horizonHours / 12);
  const spreadScore = 1 / (1 + effectiveError * WINDOW_Z * 2);
  const confidenceScore = round(clamp(spreadScore * horizonPenalty, 0.01, 0.99), 4);

  /* --------------------------------------------------------- narrative */

  const assumptions = [
    `Distance basis: ${distanceBasis}.`,
    `Speed prior ${prior.toFixed(1)} km/h${
      observationWeight > 0
        ? `, blended with ${(inputs.observedAverageSpeedKmh ?? 0).toFixed(1)} km/h observed over ${samples} GPS sample(s) at weight ${(observationWeight * 100).toFixed(0)}%`
        : ' (no trip observations yet)'
    }.`,
    `Traffic multiplier ${trafficFactor.toFixed(3)} from congestion ${congestion.toFixed(2)}; full gridlock is modelled as a ${(MAX_TRAFFIC_PENALTY * 100).toFixed(0)}% speed loss.`,
    `Weather multiplier ${weatherFactor.toFixed(3)} from severity ${weather.toFixed(2)}.`,
    nightFactor === 1
      ? 'Daytime driving; no night adjustment.'
      : `Night driving multiplier ${NIGHT_FACTOR}.`,
    `Arrival window is an ${WINDOW_CONFIDENCE_PERCENT}% interval (z = ${WINDOW_Z}) built from a relative speed error of ${(effectiveError * 100).toFixed(1)}%.`,
  ];

  const reasons = [
    `${remainingKm.toFixed(1)} km remaining at an effective ${effectiveSpeedKmh.toFixed(1)} km/h.`,
    `Driving time ${(drivingSeconds / 3600).toFixed(2)} h${stopSeconds > 0 ? ` plus ${(stopSeconds / 60).toFixed(0)} min of planned stops` : ''}.`,
    observationWeight > 0.5
      ? 'The estimate is driven mainly by this trip’s observed speed.'
      : 'The estimate leans on the vehicle/carrier speed prior — few or no trip observations yet.',
    `Confidence ${(confidenceScore * 100).toFixed(0)}% — ${horizonHours > 6 ? 'long horizon widens the window' : 'short horizon keeps the window tight'}.`,
  ];

  return {
    estimatedArrival,
    estimatedDurationSeconds,
    remainingDistanceKm: round(remainingKm, 3),
    effectiveSpeedKmh: round(effectiveSpeedKmh, 2),
    baseSpeedKmh: round(baseSpeedKmh, 2),
    confidenceScore,
    arrivalWindow,
    factors: {
      traffic: round(trafficFactor, 4),
      weather: round(weatherFactor, 4),
      night: nightFactor,
      observationWeight: round(observationWeight, 4),
    },
    assumptions,
    reasons,
  };
}

/**
 * Whether a shipment should be considered late, and by how much.
 * Uses the *window*, not just the point estimate: an ETA five minutes past the promise with a
 * two-hour window is not news, while the same five minutes with a ten-minute window is.
 */
export function assessLateness(
  eta: EtaResult,
  plannedArrivalAt: Date,
): { isLate: boolean; minutesLate: number; certainlyLate: boolean } {
  const minutesLate = (eta.estimatedArrival.getTime() - plannedArrivalAt.getTime()) / 60000;
  return {
    isLate: minutesLate > 0,
    minutesLate: round(minutesLate, 1),
    // Even the optimistic end of the window misses the promise.
    certainlyLate: eta.arrivalWindow.earliest.getTime() > plannedArrivalAt.getTime(),
  };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
