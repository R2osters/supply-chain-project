import { UpstreamError, fetchJsonCapped } from '../../../common/http';
import { clamp01, cleanText, levelFromScore, maxLevel, round, safeHttpUrl, toFiniteOrNull } from '../hazard-severity';
import type { Hazard, SeverityLevel } from '../hazard.types';

/**
 * USGS real-time earthquake feed: every M2.5+ event worldwide in the past day.
 *
 * Magnitude alone is a poor proxy for disruption — an M6 under open ocean hurts nobody, an M5.5
 * under a city closes roads. Where USGS has run its PAGER impact model, the `alert` colour is the
 * better signal and it overrides our magnitude heuristic upward. A tsunami flag does the same:
 * for a port, the wave is the hazard, not the shaking.
 *
 * Adapted from God's Eye View (MIT), src/layers/earthquakes/source.js
 */

export const USGS_FEED_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';

const MIN_MAGNITUDE = 2.5;

const ALERT_LEVEL: Record<string, SeverityLevel> = {
  green: 'LOW',
  yellow: 'MEDIUM',
  orange: 'HIGH',
  red: 'CRITICAL',
};

export interface QuakeEvent {
  id: string;
  magnitude: number;
  latitude: number;
  longitude: number;
  depthKm: number | null;
  place: string | null;
  time: string;
  url: string | null;
  alert: string | null;
  tsunami: boolean;
  significance: number | null;
}

export function parseUsgsFeed(payload: unknown): QuakeEvent[] {
  const features = (payload as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) {
    throw new UpstreamError('Le flux USGS ne contient pas de liste features', 'earthquake.usgs.gov', null);
  }
  const seen = new Set<string>();
  const events: QuakeEvent[] = [];
  for (const feature of features.slice(0, 5000)) {
    const event = parseFeature(feature);
    if (!event || seen.has(event.id)) continue;
    seen.add(event.id);
    events.push(event);
  }
  return events;
}

function parseFeature(raw: unknown): QuakeEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const feature = raw as {
    id?: unknown;
    geometry?: { coordinates?: unknown };
    properties?: Record<string, unknown>;
  };
  const coordinates = feature.geometry?.coordinates;
  const props = feature.properties;
  if (!Array.isArray(coordinates) || !props || typeof feature.id !== 'string') return null;

  const [longitude, latitude, depth] = coordinates.map(toFiniteOrNull);
  const magnitude = toFiniteOrNull(props.mag);
  // A missing magnitude cannot establish that the event meets the feed's own M2.5 floor.
  if (longitude === null || latitude === null || magnitude === null) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || magnitude < MIN_MAGNITUDE || magnitude > 10) {
    return null;
  }
  const timeMs = toFiniteOrNull(props.time);
  const alert = typeof props.alert === 'string' && props.alert in ALERT_LEVEL ? props.alert : null;

  return {
    id: feature.id.slice(0, 40),
    magnitude,
    latitude,
    longitude,
    depthKm: depth ?? null,
    place: cleanText(props.place, 160),
    time: new Date(timeMs ?? Date.now()).toISOString(),
    url: safeHttpUrl(props.url),
    alert,
    tsunami: props.tsunami === 1 || props.tsunami === true,
    significance: toFiniteOrNull(props.sig),
  };
}

/** M2.5 → 0, M7.5+ → 1. Linear in magnitude, which is already logarithmic in energy. */
export function magnitudeScore(magnitude: number): number {
  return clamp01((magnitude - MIN_MAGNITUDE) / 5);
}

/**
 * Footprint for exposure matching. Shaking felt strongly enough to disrupt operations reaches
 * roughly tens of km at M5 and a few hundred at M7+; a table is honest about how coarse it is.
 */
export function quakeRadiusKm(magnitude: number): number {
  if (magnitude >= 7) return 400;
  if (magnitude >= 6) return 200;
  if (magnitude >= 5) return 100;
  if (magnitude >= 4) return 50;
  return 20;
}

export function quakeToHazard(event: QuakeEvent): Hazard {
  let score = magnitudeScore(event.magnitude);
  let severity = levelFromScore(score);
  if (event.alert) severity = maxLevel(severity, ALERT_LEVEL[event.alert]);
  if (event.tsunami) severity = maxLevel(severity, 'HIGH');
  // Keep the score consistent with an upgraded level so sorting agrees with the badge.
  score = Math.max(score, minimumScoreFor(severity));

  return {
    id: `usgs:${event.id}`,
    kind: 'EARTHQUAKE',
    // The place is USGS's own text ("12 km SSW of Tema, Ghana") and stays as published.
    title: `Séisme M${event.magnitude.toFixed(1)}${event.place ? ` — ${event.place}` : ''}`,
    severity,
    severityScore: round(score, 2),
    latitude: event.latitude,
    longitude: event.longitude,
    radiusKm: quakeRadiusKm(event.magnitude),
    observedAt: event.time,
    source: 'USGS Earthquake Hazards Program',
    url: event.url,
    details: {
      magnitude: event.magnitude,
      depthKm: event.depthKm,
      place: event.place,
      alert: event.alert,
      tsunami: event.tsunami,
      significance: event.significance,
    },
    track: null,
    cone: null,
  };
}

function minimumScoreFor(level: SeverityLevel): number {
  return { LOW: 0, MEDIUM: 0.35, HIGH: 0.6, CRITICAL: 0.85 }[level];
}

export async function fetchUsgsHazards(): Promise<Hazard[]> {
  const payload = await fetchJsonCapped(USGS_FEED_URL, { maxBytes: 4 * 1024 * 1024 });
  return parseUsgsFeed(payload).map(quakeToHazard);
}
