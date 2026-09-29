/**
 * Pure pieces of the aircraft feed: the shared shape, bounding boxes, and the two upstream
 * formats normalised to it. Adapted from God's Eye View (MIT,
 * github.com/bilawalsidhu/gods-eye-view, server/providers/aircraft/opensky.js and
 * src/data/adsbLolFallback.js).
 */

export interface Aircraft {
  /** ICAO 24-bit address, lower-case hex. Stable across sources, so it is the id. */
  id: string;
  callsign: string | null;
  registration: string | null;
  type: string | null;
  latitude: number;
  longitude: number;
  altitudeM: number | null;
  speedKts: number | null;
  trackDeg: number | null;
  verticalRateMs: number | null;
  onGround: boolean;
  originCountry: string | null;
}

export interface BoundingBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

const FEET_TO_M = 0.3048;
const MS_TO_KTS = 1.943844;
const FPM_TO_MS = 0.00508;

/**
 * Widest view we query. OpenSky bills a request by area (1 credit up to 25 square degrees, 4 past
 * 400), and a continent's worth of aircraft is unreadable on a map anyway, so a wider view is
 * shrunk around its centre.
 */
export const MAX_SPAN_DEG = 20;

export function parseBoundingBox(query: Record<string, unknown>): BoundingBox | null {
  const read = (name: string): number => Number.parseFloat(String(query[name] ?? ''));
  const box = { minLat: read('minLat'), minLon: read('minLon'), maxLat: read('maxLat'), maxLon: read('maxLon') };
  const finite = Object.values(box).every(Number.isFinite);
  if (!finite || box.minLat >= box.maxLat || box.minLon >= box.maxLon) return null;
  if (box.minLat < -90 || box.maxLat > 90 || box.minLon < -180 || box.maxLon > 180) return null;
  return box;
}

export function clampBoundingBox(box: BoundingBox, maxSpan: number = MAX_SPAN_DEG): BoundingBox {
  const shrink = (min: number, max: number, lo: number, hi: number): [number, number] => {
    if (max - min <= maxSpan) return [min, max];
    const centre = (min + max) / 2;
    return [Math.max(lo, centre - maxSpan / 2), Math.min(hi, centre + maxSpan / 2)];
  };
  const [minLat, maxLat] = shrink(box.minLat, box.maxLat, -90, 90);
  const [minLon, maxLon] = shrink(box.minLon, box.maxLon, -180, 180);
  return { minLat, minLon, maxLat, maxLon };
}

/** Snaps a box outward to a coarse grid so nearby views share one cached upstream response. */
export function snapBoundingBox(box: BoundingBox, step = 0.5): BoundingBox {
  return {
    minLat: Math.max(-90, Math.floor(box.minLat / step) * step),
    minLon: Math.max(-180, Math.floor(box.minLon / step) * step),
    maxLat: Math.min(90, Math.ceil(box.maxLat / step) * step),
    maxLon: Math.min(180, Math.ceil(box.maxLon / step) * step),
  };
}

export function boxKey(box: BoundingBox): string {
  return `${box.minLat},${box.minLon},${box.maxLat},${box.maxLon}`;
}

export function contains(box: BoundingBox, lat: number, lon: number): boolean {
  return lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;
}

/** Centre and radius (nautical miles) of the circle around a box, for adsb.lol's point query. */
export function circleAround(box: BoundingBox, maxRadiusNm = 250): { lat: number; lon: number; radiusNm: number } {
  const lat = (box.minLat + box.maxLat) / 2;
  const lon = (box.minLon + box.maxLon) / 2;
  const halfHeightNm = ((box.maxLat - box.minLat) / 2) * 60;
  const halfWidthNm = ((box.maxLon - box.minLon) / 2) * 60 * Math.cos((lat * Math.PI) / 180);
  const radiusNm = Math.min(maxRadiusNm, Math.ceil(Math.hypot(halfHeightNm, halfWidthNm)));
  return { lat, lon, radiusNm: Math.max(1, radiusNm) };
}

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * One row of OpenSky's `/states/all`: a positional array, documented at
 * openskynetwork.github.io/opensky-api/rest.html. Rows without a position are dropped.
 */
export function fromOpenSkyState(row: unknown[]): Aircraft | null {
  const latitude = num(row[6]);
  const longitude = num(row[5]);
  const id = text(row[0]);
  if (latitude === null || longitude === null || !id) return null;
  const velocity = num(row[9]);
  const altitude = num(row[13]) ?? num(row[7]);
  return {
    id: id.toLowerCase(),
    callsign: text(row[1]),
    registration: null,
    type: null,
    latitude,
    longitude,
    altitudeM: altitude,
    speedKts: velocity === null ? null : Math.round(velocity * MS_TO_KTS),
    trackDeg: num(row[10]),
    verticalRateMs: num(row[11]),
    onGround: row[8] === true,
    originCountry: text(row[2]),
  };
}

/** One aircraft from adsb.lol's readsb-style JSON (`ac` array). Feet and knots upstream. */
export function fromAdsbLol(entry: Record<string, unknown>): Aircraft | null {
  const latitude = num(entry.lat);
  const longitude = num(entry.lon);
  const id = text(entry.hex);
  if (latitude === null || longitude === null || !id) return null;
  const onGround = entry.alt_baro === 'ground';
  const altitudeFt = num(entry.alt_geom) ?? num(entry.alt_baro);
  const rateFpm = num(entry.baro_rate) ?? num(entry.geom_rate);
  return {
    id: id.replace(/^~/, '').toLowerCase(),
    callsign: text(entry.flight),
    registration: text(entry.r),
    type: text(entry.t),
    latitude,
    longitude,
    altitudeM: onGround ? 0 : altitudeFt === null ? null : Math.round(altitudeFt * FEET_TO_M),
    speedKts: num(entry.gs),
    trackDeg: num(entry.track) ?? num(entry.true_heading),
    verticalRateMs: rateFpm === null ? null : Math.round(rateFpm * FPM_TO_MS * 10) / 10,
    onGround,
    originCountry: null,
  };
}

/**
 * How long to reuse an OpenSky answer given the credits left today, as in God's Eye View: full
 * freshness while the budget is healthy, then progressively staler so a whole day of use never
 * exhausts the quota and kills the layer.
 */
export function openSkyTtlMs(creditsRemaining: number | null, dailyQuota = 4000, baseMs = 10_000): number {
  if (creditsRemaining === null || !Number.isFinite(creditsRemaining)) return baseMs;
  // Thresholds from God's Eye View, written for the 4 000-credit authenticated quota; scaled so
  // the anonymous 400-credit quota degrades the same way instead of starting at the last tier.
  const share = creditsRemaining / dailyQuota;
  if (share > 0.6) return baseMs;
  if (share > 0.3) return 30_000;
  if (share > 0.1) return 90_000;
  return 300_000;
}

/** OpenSky's daily credit quota: 4 000 with client credentials, 400 anonymously. */
export function openSkyDailyQuota(authenticated: boolean): number {
  return authenticated ? 4000 : 400;
}
