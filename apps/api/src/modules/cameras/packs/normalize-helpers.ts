/**
 * Small pure helpers every pack normaliser leans on.
 *
 * Catalogues are written by six different agencies, and each has its own way of being wrong:
 * coordinates as strings, `null` that `Number()` would turn into the equator, ids with spaces,
 * facing text that is sometimes a bearing and sometimes an address. These helpers are where
 * that is absorbed, so the pack files read as field mappings.
 *
 * Adapted from God's Eye View (MIT), `server/providers/cctv/normalize.js` and
 * `src/data/directionText.js`.
 */

const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * An upstream id that can sit in a URL path segment without encoding surprises, or null.
 * Ids are refused rather than rewritten: two different upstream ids that sanitise to the same
 * string would otherwise collide and one camera would show the other's picture.
 */
export function toSafeId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return SAFE_ID.test(text) ? text : null;
}

/** Numbers and numeric strings only. `null`, `''` and `true` are not coordinates. */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/**
 * Each pack covers one known region. A camera outside it is a data error (swapped lat/lon,
 * 0/0 placeholder), and a truck operator clicking a camera in the Gulf of Guinea labelled
 * "Toronto" would stop trusting the whole layer.
 */
export function isInsideBox(latitude: number | null, longitude: number | null, box: BoundingBox): boolean {
  if (latitude === null || longitude === null) return false;
  return (
    latitude >= box.minLat && latitude <= box.maxLat && longitude >= box.minLon && longitude <= box.maxLon
  );
}

const COMPASS_POINTS: Record<string, number> = {
  N: 0,
  NNE: 22.5,
  NE: 45,
  ENE: 67.5,
  E: 90,
  ESE: 112.5,
  SE: 135,
  SSE: 157.5,
  S: 180,
  SSW: 202.5,
  SW: 225,
  WSW: 247.5,
  W: 270,
  WNW: 292.5,
  NW: 315,
  NNW: 337.5,
};

const TRAVEL_WORDS: Array<[RegExp, number]> = [
  [/\bNORTHBOUND\b|\bNB\b/, 0],
  [/\bSOUTHBOUND\b|\bSB\b/, 180],
  [/\bEASTBOUND\b|\bEB\b/, 90],
  [/\bWESTBOUND\b|\bWB\b/, 270],
  [/\bNORTHEAST\b/, 45],
  [/\bNORTHWEST\b/, 315],
  [/\bSOUTHEAST\b/, 135],
  [/\bSOUTHWEST\b/, 225],
  [/\bNORTH\b/, 0],
  [/\bSOUTH\b/, 180],
  [/\bEAST\b/, 90],
  [/\bWEST\b/, 270],
];

/**
 * Bearing from a dedicated facing field ("N-E", "Northbound", "SW"), or null.
 * Only call this on a field that is meant to be a facing: Calgary's "SE" is an address quadrant
 * and would convert to a confident, wrong bearing.
 */
export function headingFromDirection(value: unknown): number | null {
  const text = toTrimmedString(value).toUpperCase();
  if (!text) return null;
  const compact = text.replace(/[\s-]/g, '');
  if (compact in COMPASS_POINTS) return COMPASS_POINTS[compact];
  for (const [pattern, heading] of TRAVEL_WORDS) {
    if (pattern.test(text)) return heading;
  }
  return null;
}

/** Parses a URL, or null. Normalisers use this so a malformed row is dropped, not thrown. */
export function parseUrl(value: unknown): URL | null {
  const text = toTrimmedString(value);
  if (!text) return null;
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/** Keeps the first camera per id; catalogues occasionally list one camera twice. */
export function dedupeById<T extends { upstreamId: string }>(records: T[]): T[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.upstreamId)) return false;
    seen.add(record.upstreamId);
    return true;
  });
}
