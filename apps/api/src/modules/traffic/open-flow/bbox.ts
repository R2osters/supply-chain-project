/** The map view a client asks measurements for, and the geometry test that filters them. */

export interface Bbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** A city at street level is a fraction of a degree; 5° keeps a request to a region. */
export const MAX_BBOX_SPAN_DEG = 5;

/** Parses `minLon,minLat,maxLon,maxLat`; null when malformed, inverted, out of range or too wide. */
export function parseBbox(raw: unknown): Bbox | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',');
  if (parts.length !== 4 || parts.some((part) => part.trim() === '')) return null;
  const [minLon, minLat, maxLon, maxLat] = parts.map(Number);
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null;
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) return null;
  if (minLon >= maxLon || minLat >= maxLat) return null;
  if (maxLon - minLon > MAX_BBOX_SPAN_DEG || maxLat - minLat > MAX_BBOX_SPAN_DEG) return null;
  return { minLon, minLat, maxLon, maxLat };
}

export function overlaps(a: Bbox, b: Bbox): boolean {
  return a.minLon <= b.maxLon && b.minLon <= a.maxLon && a.minLat <= b.maxLat && b.minLat <= a.maxLat;
}

const inside = ([lon, lat]: [number, number], box: Bbox): boolean =>
  lon >= box.minLon && lon <= box.maxLon && lat >= box.minLat && lat <= box.maxLat;

/** Whether a polyline touches the box: a vertex inside, or a segment crossing it (Liang–Barsky). */
export function intersects(coordinates: [number, number][], box: Bbox): boolean {
  if (coordinates.some((point) => inside(point, box))) return true;
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    if (segmentCrosses(coordinates[i], coordinates[i + 1], box)) return true;
  }
  return false;
}

function segmentCrosses([x0, y0]: [number, number], [x1, y1]: [number, number], box: Bbox): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, x0 - box.minLon],
    [dx, box.maxLon - x0],
    [-dy, y0 - box.minLat],
    [dy, box.maxLat - y0],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}
