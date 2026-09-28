import { clamp01, round } from './hazard-severity';

/**
 * How bad the weather is for moving goods, on a 0..1 scale, with the reasons.
 *
 * Four independent signals, each mapped to its own 0..1 contribution:
 *
 *   weather code    WMO present-weather: thunderstorm, hail, freezing rain, heavy snow, fog
 *   wind gusts      what overturns high-sided trucks and stops cranes (sustained wind if no gust)
 *   precipitation   current rate: flooding and braking distance
 *   visibility      fog or blowing snow: speed limits and closures
 *
 * Combined as   severity = worst + 0.25 × (sum of the others),  capped at 1.
 *
 * The worst factor dominates because one severe condition is enough to stop a truck; the others
 * add a little because they compound (a thunderstorm in fog is worse than either). A plain
 * average would let three calm factors dilute one dangerous one — the exact case a warning
 * exists for.
 *
 * The thresholds are operational rules of thumb (road closures for high-sided vehicles start
 * around 75 km/h gusts; port cranes typically stop around 70 km/h), not a calibrated model. The
 * reasons list exists so a user can disagree with a specific number instead of a black box.
 */

export interface WeatherSeverityInput {
  weatherCode: number | null;
  windKmh: number | null;
  windGustKmh: number | null;
  precipitationMm: number | null;
  visibilityM: number | null;
}

export interface WeatherSeverity {
  severity: number;
  condition: string;
  reasons: string[];
}

interface Factor {
  score: number;
  reason: string;
}

/** Severity at which an asset's local weather is promoted to a SEVERE_WEATHER hazard. */
export const SEVERE_WEATHER_THRESHOLD = 0.6;

const COMPOUNDING_WEIGHT = 0.25;

export function computeWeatherSeverity(input: WeatherSeverityInput): WeatherSeverity {
  const factors = [
    codeFactor(input.weatherCode),
    windFactor(input.windGustKmh, input.windKmh),
    precipitationFactor(input.precipitationMm),
    visibilityFactor(input.visibilityM),
  ]
    .filter((f): f is Factor => f !== null && f.score > 0)
    .sort((a, b) => b.score - a.score);

  const worst = factors[0]?.score ?? 0;
  const rest = factors.slice(1).reduce((sum, f) => sum + f.score, 0);

  return {
    severity: round(clamp01(worst + COMPOUNDING_WEIGHT * rest), 2),
    condition: describeWeatherCode(input.weatherCode),
    reasons: factors.map((f) => f.reason),
  };
}

function codeFactor(code: number | null): Factor | null {
  if (code === null) return null;
  const label = describeWeatherCode(code);
  const score = WEATHER_CODE_SCORES[code] ?? 0;
  return score > 0 ? { score, reason: `${label} (WMO code ${code})` } : null;
}

/**
 * Per-code contribution. Hail and freezing rain rank above plain heavy rain because they make
 * roads impassable rather than merely slow.
 */
const WEATHER_CODE_SCORES: Record<number, number> = {
  45: 0.3, // fog
  48: 0.35, // depositing rime fog: fog plus ice on the road
  51: 0.05,
  53: 0.1,
  55: 0.15,
  56: 0.35, // freezing drizzle
  57: 0.45,
  61: 0.1,
  63: 0.25,
  65: 0.5, // heavy rain
  66: 0.5, // freezing rain
  67: 0.7,
  71: 0.2,
  73: 0.4,
  75: 0.6, // heavy snow
  77: 0.2,
  80: 0.15,
  81: 0.3,
  82: 0.6, // violent rain showers
  85: 0.35,
  86: 0.6,
  95: 0.7, // thunderstorm
  96: 0.85, // thunderstorm with hail
  99: 0.9,
};

function windFactor(gustKmh: number | null, windKmh: number | null): Factor | null {
  if (gustKmh !== null) {
    const score = gustKmh >= 100 ? 0.9 : gustKmh >= 75 ? 0.7 : gustKmh >= 60 ? 0.5 : gustKmh >= 45 ? 0.25 : 0;
    return { score, reason: `Wind gusts ${Math.round(gustKmh)} km/h` };
  }
  if (windKmh !== null) {
    const score = windKmh >= 75 ? 0.9 : windKmh >= 55 ? 0.7 : windKmh >= 40 ? 0.4 : windKmh >= 30 ? 0.2 : 0;
    return { score, reason: `Sustained wind ${Math.round(windKmh)} km/h` };
  }
  return null;
}

function precipitationFactor(mm: number | null): Factor | null {
  if (mm === null) return null;
  const score = mm >= 10 ? 0.7 : mm >= 5 ? 0.5 : mm >= 2 ? 0.25 : mm >= 0.5 ? 0.05 : 0;
  return { score, reason: `Precipitation ${round(mm, 1)} mm` };
}

function visibilityFactor(metres: number | null): Factor | null {
  if (metres === null) return null;
  const score = metres < 200 ? 0.7 : metres < 500 ? 0.5 : metres < 1000 ? 0.3 : metres < 2000 ? 0.15 : 0;
  const shown = metres >= 1000 ? `${round(metres / 1000, 1)} km` : `${Math.round(metres)} m`;
  return { score, reason: `Visibility ${shown}` };
}

/** Short, plain-English label for a WMO present-weather code as used by Open-Meteo. */
export function describeWeatherCode(code: number | null): string {
  if (code === null || !Number.isFinite(code)) return 'Unknown conditions';
  if (code === 0) return 'Clear sky';
  if (code === 1 || code === 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code === 45 || code === 48) return 'Fog';
  if (code === 56 || code === 57) return 'Freezing drizzle';
  if (code >= 51 && code <= 55) return 'Drizzle';
  if (code === 66 || code === 67) return 'Freezing rain';
  if (code === 65) return 'Heavy rain';
  if (code >= 61 && code <= 63) return 'Rain';
  if (code === 75 || code === 86) return 'Heavy snow';
  if ((code >= 71 && code <= 77) || code === 85) return 'Snow';
  if (code >= 80 && code <= 82) return code === 82 ? 'Violent rain showers' : 'Rain showers';
  if (code === 95) return 'Thunderstorm';
  if (code === 96 || code === 99) return 'Thunderstorm with hail';
  return 'Unknown conditions';
}
