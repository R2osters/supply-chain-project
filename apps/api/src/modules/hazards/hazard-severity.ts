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

export function levelFromScore(score: number): SeverityLevel {
  for (const [cutoff, level] of LEVEL_CUTOFFS) {
    if (score >= cutoff) return level;
  }
  return 'LOW';
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
