import type { BoundingBox, SeverityLevel } from './hazard.types';

/**
 * Shared scoring and geometry helpers for every hazard source.
 *
 * Each feed has its own intensity measure (knots, magnitude, fire radiative power, WMO codes).
 * They are mapped to one 0..1 score and then to four bands with the *same* cut-offs, so a HIGH
 * earthquake and a HIGH cyclone at least mean "the same order of worry" on one screen. The cut
 * points are judgement, not physics, and the docs say so.
 */

const LEVEL_CUTOFFS: Array<[number, SeverityLevel]> = [
  [0.85, 'CRITICAL'],
  [0.6, 'HIGH'],
  [0.35, 'MEDIUM'],
];

const LEVEL_RANK: Record<SeverityLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

/** The score range each level covers under the cut-offs above (LOW starts at 0.1: never "nothing"). */
const LEVEL_BAND: Record<SeverityLevel, [number, number]> = {
  LOW: [0.1, 0.34],
  MEDIUM: [0.35, 0.59],
  HIGH: [0.6, 0.84],
  CRITICAL: [0.85, 1],
};

export function levelFromScore(score: number): SeverityLevel {
  for (const [cutoff, level] of LEVEL_CUTOFFS) {
    if (score >= cutoff) return level;
  }
  return 'LOW';
}

/**
 * A score inside a level's band: `position` 0 is the band's floor, 1 its ceiling. For sources that
 * publish a level of their own (an alert colour) plus a finer figure to order events within it.
 */
export function scoreInBand(level: SeverityLevel, position: number): number {
  const [floor, ceiling] = LEVEL_BAND[level];
  return round(floor + (ceiling - floor) * clamp01(position), 2);
}

export function severityRank(level: SeverityLevel): number {
  return LEVEL_RANK[level];
}

/** The more severe of two levels — used when an official alert outranks our own heuristic. */
export function maxLevel(a: SeverityLevel, b: SeverityLevel): SeverityLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Point-in-box that understands a box crossing the antimeridian (a Pacific view). */
export function isInBoundingBox(latitude: number, longitude: number, box: BoundingBox): boolean {
  if (latitude < box.minLat || latitude > box.maxLat) return false;
  if (box.minLon <= box.maxLon) return longitude >= box.minLon && longitude <= box.maxLon;
  return longitude >= box.minLon || longitude <= box.maxLon;
}

/**
 * Radius of a disc with this area, km. A burned area or a drought is not a disc, so this is only
 * "how far the affected area reaches from its centre, on average" — a footprint for matching.
 */
export function equalAreaRadiusKm(areaKm2: number): number {
  return Number.isFinite(areaKm2) && areaKm2 > 0 ? Math.sqrt(areaKm2 / Math.PI) : 0;
}

/**
 * Footprint of a fire reported with its burned area (GDACS, EONET): the area's disc radius plus
 * 5 km for smoke and closed roads, kept within 10–50 km. Without an area, 15 km.
 */
export function fireAreaRadiusKm(areaHa: number | null): number {
  if (areaHa === null || !Number.isFinite(areaHa) || areaHa <= 0) return 15;
  return Math.min(50, Math.max(10, Math.round(equalAreaRadiusKm(areaHa / 100)) + 5));
}

/**
 * ISO instant from an upstream timestamp. Several feeds (GDACS, Open-Meteo) send zone-less times
 * that are UTC; JavaScript would read those as local time, so they are pinned to UTC here.
 */
export function parseUtcIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const text = value.trim();
  const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text) ? `${text}Z` : text;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Finite number or null: upstream feeds send "", null and strings interchangeably. */
export function toFiniteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Strips control and angle-bracket characters from upstream text before it reaches a screen.
 * The client escapes too; this is the second fence, and it also keeps a hostile feed from
 * stuffing a 1 MB "title" into our responses.
 */
export function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

/** Only absolute http(s) links survive: a `javascript:` URL in a feed must never become a link. */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
