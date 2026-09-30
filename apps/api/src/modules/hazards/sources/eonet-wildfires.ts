import { UpstreamError, fetchJsonCapped } from '../../../common/http';
import {
  clamp01,
  cleanText,
  fireAreaRadiusKm,
  levelFromScore,
  parseUtcIso,
  round,
  safeHttpUrl,
  toFiniteOrNull,
} from '../hazard-severity';
import type { Hazard } from '../hazard.types';

/**
 * NASA EONET v3 (Earth Observatory Natural Event Tracker): open wildfire events.
 *
 * Keyless and public domain. In practice the open wildfires are US incidents from IRWIN, the
 * interagency fire reporting system, each a point with its reported size in acres. EONET also
 * republishes GDACS fires, but closes them on arrival; GDACS is read directly anyway, so any such
 * copy is dropped here rather than drawn twice.
 *
 * EONET leaves events "open" for years — thousands of open wildfires, most untouched since long
 * before this season — so only events with an observation in the last 14 days are asked for, and
 * the window is checked again on our side. Prescribed burns (IRWIN "Prescribed Fire … RX") are
 * planned, controlled fires rather than hazards, and are dropped.
 *
 * Used only while no NASA FIRMS key is configured: FIRMS detections replace it then.
 */

export const EONET_EVENTS_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events';
export const EONET_ATTRIBUTION =
  'NASA Earth Observatory Natural Event Tracker (EONET), domaine public ; incidents américains issus d’IRWIN';
const EONET_HOST = 'eonet.gsfc.nasa.gov';

export const EONET_WINDOW_DAYS = 14;
export const MAX_EONET_EVENTS = 500;

const DAY_MS = 86_400_000;
const ACRE_HA = 0.40468564224;
/** Score of a fire reported without a size: that of a typical IRWIN fire, a few hundred hectares. */
const UNSIZED_FIRE_SCORE = 0.2;
const PRESCRIBED = /^prescribed\b/i;

export interface EonetFire {
  id: string;
  title: string;
  /** IRWIN's "8 Miles SE from Eldorado, TX". */
  description: string | null;
  /** Latest observed position (a polygon's centroid when the observation is a perimeter). */
  latitude: number;
  longitude: number;
  firstSeenAt: string;
  lastSeenAt: string;
  areaHa: number | null;
  /** The size as the source reported it, e.g. "2125 acres". */
  reportedArea: string | null;
  /** Whether any observation is a perimeter polygon rather than a point. */
  polygon: boolean;
  observations: number;
  upstream: string | null;
  url: string;
}

interface Observation {
  latitude: number;
  longitude: number;
  atMs: number;
  polygon: boolean;
  areaHa: number | null;
  reported: string | null;
}

/* ------------------------------------------------------------------ parsing */

export function eonetUrl(days = EONET_WINDOW_DAYS): string {
  const params = new URLSearchParams({
    status: 'open',
    category: 'wildfires',
    days: String(days),
    limit: String(MAX_EONET_EVENTS),
  });
  return `${EONET_EVENTS_URL}?${params.toString()}`;
}

/**
 * Parses the events list. A malformed event is dropped, not fatal; a payload without an events
 * list is, so it is served stale instead of emptying the map.
 */
export function parseEonetFires(payload: unknown, nowMs: number, windowDays = EONET_WINDOW_DAYS): EonetFire[] {
  const events = (payload as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) {
    throw new UpstreamError('La réponse EONET ne contient pas de liste events', EONET_HOST, null);
  }
  const oldest = nowMs - windowDays * DAY_MS;
  const newest = nowMs + DAY_MS;
  const seen = new Set<string>();
  const fires: EonetFire[] = [];
  for (const raw of events.slice(0, MAX_EONET_EVENTS)) {
    const fire = parseEvent(raw);
    if (!fire || seen.has(fire.id)) continue;
    const lastMs = Date.parse(fire.lastSeenAt);
    if (lastMs < oldest || lastMs > newest) continue;
    seen.add(fire.id);
    fires.push(fire);
  }
  return fires;
}

function parseEvent(raw: unknown): EonetFire | null {
  if (!raw || typeof raw !== 'object') return null;
  const event = raw as Record<string, unknown>;
  if (typeof event.id !== 'string' || !/^EONET_\d{1,10}$/.test(event.id)) return null;
  // A closed event is over, whatever the query asked for.
  if (event.closed !== null && event.closed !== undefined) return null;
  if (!isWildfire(event.categories)) return null;

  const title = cleanText(event.title, 160);
  if (!title || PRESCRIBED.test(title)) return null;

  const sources = parseSources(event.sources);
  if (sources.length > 0 && sources.every((source) => source.id.toUpperCase() === 'GDACS')) return null;

  const observations = parseGeometry(event.geometry);
  if (observations.length === 0) return null;
  const latest = observations[observations.length - 1];
  const sized = [...observations].reverse().find((o) => o.areaHa !== null);

  return {
    id: event.id,
    title,
    description: cleanText(event.description, 160),
    latitude: round(latest.latitude, 4),
    longitude: round(latest.longitude, 4),
    firstSeenAt: new Date(observations[0].atMs).toISOString(),
    lastSeenAt: new Date(latest.atMs).toISOString(),
    areaHa: sized?.areaHa ?? null,
    reportedArea: sized?.reported ?? null,
    polygon: observations.some((o) => o.polygon),
    observations: observations.length,
    upstream: sources.length > 0 ? sources.map((s) => s.id).join(', ') : null,
    // The incident record at the source when there is one; EONET's own event page otherwise.
    url:
      sources.map((source) => source.url).find((url): url is string => url !== null) ??
      safeHttpUrl(event.link) ??
      `${EONET_EVENTS_URL}/${event.id}`,
  };
}

function isWildfire(categories: unknown): boolean {
  return (
    Array.isArray(categories) &&
    categories.some((c) => c && typeof c === 'object' && (c as Record<string, unknown>).id === 'wildfires')
  );
}

function parseSources(value: unknown): Array<{ id: string; url: string | null }> {
  if (!Array.isArray(value)) return [];
  const sources: Array<{ id: string; url: string | null }> = [];
  for (const raw of value.slice(0, 10)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = cleanText((raw as Record<string, unknown>).id, 30);
    if (id) sources.push({ id, url: safeHttpUrl((raw as Record<string, unknown>).url) });
  }
  return sources;
}

/** Observations oldest first. Points as given; a polygon becomes its outer ring's centroid. */
function parseGeometry(value: unknown): Observation[] {
  if (!Array.isArray(value)) return [];
  const observations: Observation[] = [];
  for (const raw of value.slice(0, 500)) {
    if (!raw || typeof raw !== 'object') continue;
    const geometry = raw as Record<string, unknown>;
    const at = parseUtcIso(geometry.date);
    const position =
      geometry.type === 'Point'
        ? lonLat(geometry.coordinates)
        : geometry.type === 'Polygon'
          ? ringCentroid(geometry.coordinates)
          : null;
    if (!at || !position) continue;
    const magnitude = toFiniteOrNull(geometry.magnitudeValue);
    const unit = typeof geometry.magnitudeUnit === 'string' ? geometry.magnitudeUnit.trim().toLowerCase() : '';
    const areaHa = magnitude !== null && magnitude > 0 ? toHectares(magnitude, unit) : null;
    observations.push({
      latitude: position[1],
      longitude: position[0],
      atMs: Date.parse(at),
      polygon: geometry.type === 'Polygon',
      areaHa,
      reported: areaHa === null ? null : `${round(magnitude as number, 2)} ${unit}`,
    });
  }
  return observations.sort((a, b) => a.atMs - b.atMs);
}

function toHectares(value: number, unit: string): number | null {
  if (unit === 'acres' || unit === 'acre' || unit === 'ac') return value * ACRE_HA;
  if (unit === 'ha' || unit === 'hectares') return value;
  if (unit === 'km2' || unit === 'km²' || unit === 'sq km') return value * 100;
  return null;
}

function lonLat(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const [lon, lat] = value.map(toFiniteOrNull);
  if (lon === null || lat === null || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return [lon, lat];
}

/** Mean of the outer ring's vertices (closing vertex excluded): good enough for a fire perimeter. */
function ringCentroid(value: unknown): [number, number] | null {
  const ring = Array.isArray(value) && Array.isArray(value[0]) ? (value[0] as unknown[]) : null;
  if (!ring) return null;
  const points = ring
    .slice(0, 10_000)
    .map(lonLat)
    .filter((p): p is [number, number] => p !== null);
  const open = points.length > 1 && samePoint(points[0], points[points.length - 1]) ? points.slice(0, -1) : points;
  if (open.length < 3) return null;
  const lon = open.reduce((sum, p) => sum + p[0], 0) / open.length;
  const lat = open.reduce((sum, p) => sum + p[1], 0) / open.length;
  return [lon, lat];
}

function samePoint(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/* ------------------------------------------------------------------- hazard */

/**
 * Burned area on a log scale: 100 ha is 0, 1 000 ha 0.25 (LOW), 10 000 ha 0.5 (MEDIUM),
 * 100 000 ha 0.75 (HIGH), a million hectares 1 (CRITICAL). Deliberately conservative: IRWIN lists
 * many modest fires (the median is a few hundred hectares), and GDACS rates most fires under
 * 100 000 ha Green, so a routine US fire should not outrank them.
 */
export function fireAreaScore(areaHa: number): number {
  return clamp01((Math.log10(Math.max(areaHa, 1)) - 2) / 4);
}

/** IRWIN titles read "Wildfire Rafter 4B, Schleicher, Texas": the county and state follow the name. */
export function placeFromTitle(title: string): string | null {
  const place = /^[^,]+,\s*(.+)$/.exec(title)?.[1]?.trim();
  return place ? place.slice(0, 80) : null;
}

export function eonetFireToHazard(fire: EonetFire): Hazard {
  const score = round(fire.areaHa === null ? UNSIZED_FIRE_SCORE : fireAreaScore(fire.areaHa), 2);
  return {
    id: `eonet:${fire.id}`,
    kind: 'FIRE',
    title: fire.title,
    severity: levelFromScore(score),
    severityScore: score,
    latitude: fire.latitude,
    longitude: fire.longitude,
    radiusKm: fireAreaRadiusKm(fire.areaHa),
    observedAt: fire.lastSeenAt,
    source: 'NASA EONET',
    url: fire.url,
    details: {
      areaHa: fire.areaHa === null ? null : Math.round(fire.areaHa),
      reportedArea: fire.reportedArea,
      place: placeFromTitle(fire.title),
      location: fire.description,
      firstReported: fire.firstSeenAt,
      reports: fire.observations,
      upstream: fire.upstream,
      eonetId: fire.id,
    },
    track: null,
    cone: null,
  };
}

/* -------------------------------------------------------------------- fetch */

export async function fetchEonetFires(nowMs = Date.now()): Promise<EonetFire[]> {
  // A 14-day answer is ~15 KB; the unbounded "open" list is ~5 MB, hence the ceiling.
  const payload = await fetchJsonCapped(eonetUrl(), { maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000 });
  return parseEonetFires(payload, nowMs);
}
