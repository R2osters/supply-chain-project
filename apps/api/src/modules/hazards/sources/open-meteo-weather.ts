import { UpstreamError, fetchJsonCapped } from '../../../common/http';
import { levelFromScore, round, toFiniteOrNull } from '../hazard-severity';
import type { Hazard } from '../hazard.types';
import type { WeatherSeverity } from '../weather-severity';

/**
 * Open-Meteo current conditions at a point.
 *
 * Requests are snapped to a 0.1° grid (~11 km) before they go out. Weather does not change
 * meaningfully across 11 km, and snapping means every truck on the same stretch of highway
 * shares one cached observation instead of each costing a request.
 *
 * Open-Meteo timestamps are zone-less ("2026-08-17T00:15") but UTC; JavaScript would parse them
 * as local time, so they are pinned to UTC explicitly.
 *
 * Adapted from God's Eye View (MIT), server/providers/regional/weather.js and weather-effects.js
 */

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
export const OPEN_METEO_ATTRIBUTION = 'Données météo Open-Meteo.com (CC BY 4.0)';

const CURRENT_FIELDS =
  'temperature_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,visibility,cloud_cover';

export interface WeatherObservation {
  latitude: number;
  longitude: number;
  observedAt: string;
  temperatureC: number | null;
  windKmh: number | null;
  windGustKmh: number | null;
  precipitationMm: number | null;
  visibilityM: number | null;
  cloudCoverPct: number | null;
  weatherCode: number | null;
}

/** The grid cell a point is served from. Also the cache key. */
export function weatherCell(latitude: number, longitude: number): { latitude: number; longitude: number; key: string } {
  const lat = round(latitude, 1);
  const lon = round(longitude, 1);
  return { latitude: lat, longitude: lon, key: `${lat.toFixed(1)},${lon.toFixed(1)}` };
}

export function openMeteoUrl(latitude: number, longitude: number): string {
  const params = new URLSearchParams({
    latitude: latitude.toFixed(1),
    longitude: longitude.toFixed(1),
    current: CURRENT_FIELDS,
    // Open-Meteo defaults to km/h and mm, but saying so protects against a default changing.
    wind_speed_unit: 'kmh',
    precipitation_unit: 'mm',
    timezone: 'UTC',
  });
  return `${OPEN_METEO_URL}?${params.toString()}`;
}

export function parseOpenMeteo(payload: unknown, latitude: number, longitude: number): WeatherObservation {
  const current = (payload as { current?: Record<string, unknown> } | null)?.current;
  if (!current || typeof current !== 'object') {
    throw new UpstreamError('Open-Meteo response has no current block', 'api.open-meteo.com', null);
  }
  const time = typeof current.time === 'string' ? current.time : null;
  const zoned = time && !/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(time) ? `${time}Z` : time;
  const observedMs = zoned ? Date.parse(zoned) : Number.NaN;

  return {
    latitude,
    longitude,
    observedAt: Number.isFinite(observedMs) ? new Date(observedMs).toISOString() : new Date().toISOString(),
    temperatureC: toFiniteOrNull(current.temperature_2m),
    windKmh: toFiniteOrNull(current.wind_speed_10m),
    windGustKmh: toFiniteOrNull(current.wind_gusts_10m),
    precipitationMm: toFiniteOrNull(current.precipitation),
    visibilityM: toFiniteOrNull(current.visibility),
    cloudCoverPct: toFiniteOrNull(current.cloud_cover),
    weatherCode: toFiniteOrNull(current.weather_code),
  };
}

export async function fetchOpenMeteo(latitude: number, longitude: number): Promise<WeatherObservation> {
  const payload = await fetchJsonCapped(openMeteoUrl(latitude, longitude), { maxBytes: 64 * 1024 });
  return parseOpenMeteo(payload, latitude, longitude);
}

/**
 * Local weather at an asset, promoted to a hazard. The id is the grid cell, so two warehouses in
 * the same storm share one hazard and the exposure list shows the storm once per site.
 */
export function weatherToHazard(observation: WeatherObservation, assessment: WeatherSeverity): Hazard {
  const cell = weatherCell(observation.latitude, observation.longitude);
  return {
    id: `open-meteo:${cell.key}`,
    kind: 'SEVERE_WEATHER',
    title: `Météo sévère — ${assessment.condition}`,
    severity: levelFromScore(assessment.severity),
    severityScore: assessment.severity,
    latitude: cell.latitude,
    longitude: cell.longitude,
    // Half the grid cell diagonal: the observation stands for roughly this area, no more.
    radiusKm: 10,
    observedAt: observation.observedAt,
    source: 'Open-Meteo',
    url: null,
    details: {
      condition: assessment.condition,
      reasons: assessment.reasons.join(' ; '),
      weatherCode: observation.weatherCode,
      windKmh: observation.windKmh,
      windGustKmh: observation.windGustKmh,
      precipitationMm: observation.precipitationMm,
      visibilityM: observation.visibilityM,
      temperatureC: observation.temperatureC,
    },
    track: null,
    cone: null,
  };
}
