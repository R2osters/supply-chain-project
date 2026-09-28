import { UpstreamError, fetchTextCapped } from '../../../common/http';
import { clamp01, levelFromScore, round } from '../hazard-severity';
import type { BoundingBox, Hazard } from '../hazard.types';

/**
 * NASA FIRMS active fires (VIIRS near-real-time), queried by area.
 *
 * FIRMS is the one source here that needs a key, and the one whose world query is enormous — a
 * two-day VIIRS pull is well over 100 000 rows. So we never ask for the world: only a bounded
 * box (the map viewport, clamped, or boxes around the company's own sites), and the parsed rows
 * are capped.
 *
 * Individual detections are 375 m pixels; a burning hillside is dozens of them. Showing each as
 * a "hazard" would bury the list, so detections are clustered on a 0.1° grid and each cluster
 * becomes one FIRE hazard carrying its pixel count and total fire radiative power.
 *
 * `days=1` means "the current UTC day" to FIRMS — almost empty just after midnight UTC — so we
 * ask for two days and keep the trailing 24 hours ourselves.
 *
 * Adapted from God's Eye View (MIT), server/providers/firms.js and src/data/firmsCsv.js
 */

export const FIRMS_SOURCE = 'VIIRS_NOAA20_NRT';
const FIRMS_HOST = 'firms.modaps.eosdis.nasa.gov';

/** Largest box side we send to FIRMS. Bigger views are clamped to their centre. */
export const MAX_FIRMS_SPAN_DEG = 15;
/** Rows parsed per query; beyond this a box is on fire enough that more rows add nothing. */
export const MAX_FIRMS_ROWS = 20_000;
/** Clusters returned per query, strongest first. */
export const MAX_FIRE_CLUSTERS = 300;
const CLUSTER_CELL_DEG = 0.1;

const HOUR_MS = 3_600_000;
const WINDOW_MS = 24 * HOUR_MS;
const FORWARD_SLACK_MS = 2 * HOUR_MS;

const REQUIRED_HEADER = ['latitude', 'longitude', 'acq_date', 'acq_time', 'confidence', 'frp'];

export interface FireDetection {
  latitude: number;
  longitude: number;
  frp: number;
  confidence: string;
  acquiredAtMs: number;
  daynight: string;
}

/**
 * FIRMS reports errors ("Invalid MAP_KEY", an HTML page) with a 200 status, never as CSV.
 * Checking the header is what distinguishes "no fires" from "the request failed".
 */
export function isFirmsCsv(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed || trimmed.startsWith('<')) return false;
  const firstLine = trimmed.split('\n', 1)[0].trim().toLowerCase();
  const fields = firstLine.split(',').map((f) => f.trim());
  return REQUIRED_HEADER.every((required) => fields.includes(required));
}

/** `acq_time` is unpadded HHMM in UTC: "45" is 00:45, "1006" is 10:06. */
export function acquisitionMsUtc(acqDate: string, acqTime: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(acqDate) || !/^\d{1,4}$/.test(acqTime)) return Number.NaN;
  const hhmm = acqTime.padStart(4, '0');
  const hours = Number(hhmm.slice(0, 2));
  const minutes = Number(hhmm.slice(2));
  if (hours > 23 || minutes > 59) return Number.NaN;
  const [year, month, day] = acqDate.split('-').map(Number);
  return Date.UTC(year, month - 1, day, hours, minutes);
}

/** Parses the area CSV, keeping only detections from the trailing 24 h. Throws on a non-CSV body. */
export function parseFirmsCsv(text: string, nowMs: number, maxRows = MAX_FIRMS_ROWS): FireDetection[] {
  if (!isFirmsCsv(text)) {
    throw new UpstreamError('FIRMS answered with something other than CSV', FIRMS_HOST, null);
  }
  const lines = text.trimStart().split('\n');
  const header = lines[0].trim().toLowerCase().split(',').map((f) => f.trim());
  const col = (name: string) => header.indexOf(name);
  const iLat = col('latitude');
  const iLon = col('longitude');
  const iFrp = col('frp');
  const iConf = col('confidence');
  const iDate = col('acq_date');
  const iTime = col('acq_time');
  const iDayNight = col('daynight');

  const oldest = nowMs - WINDOW_MS;
  const newest = nowMs + FORWARD_SLACK_MS;
  const detections: FireDetection[] = [];
  for (let i = 1; i < lines.length && detections.length < maxRows; i += 1) {
    const parts = lines[i].trim().split(',');
    if (parts.length < header.length) continue;
    const latitude = Number(parts[iLat]);
    const longitude = Number(parts[iLon]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const acquiredAtMs = acquisitionMsUtc(parts[iDate].trim(), parts[iTime].trim());
    if (!Number.isFinite(acquiredAtMs) || acquiredAtMs < oldest || acquiredAtMs > newest) continue;
    const frp = Number(parts[iFrp]);
    detections.push({
      latitude,
      longitude,
      frp: Number.isFinite(frp) && frp > 0 ? frp : 0,
      confidence: parts[iConf].trim().toLowerCase(),
      acquiredAtMs,
      daynight: iDayNight >= 0 ? (parts[iDayNight] ?? '').trim() : '',
    });
  }
  return detections;
}

/**
 * Clusters detections on a fixed grid. VIIRS "low" confidence pixels are mostly sun glint and
 * hot industrial roofs; they are dropped so a steel mill does not appear as a wildfire.
 */
export function clusterFires(detections: FireDetection[], maxClusters = MAX_FIRE_CLUSTERS): Hazard[] {
  const cells = new Map<string, FireDetection[]>();
  for (const d of detections) {
    if (d.confidence === 'l' || d.confidence === 'low') continue;
    const key = `${Math.floor(d.latitude / CLUSTER_CELL_DEG)}:${Math.floor(d.longitude / CLUSTER_CELL_DEG)}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(d);
    else cells.set(key, [d]);
  }

  return [...cells.entries()]
    .map(([key, members]) => clusterToHazard(key, members))
    .sort((a, b) => b.severityScore - a.severityScore || Number(b.details.totalFrpMw) - Number(a.details.totalFrpMw))
    .slice(0, maxClusters);
}

/**
 * Severity from total fire radiative power: ~30 MW is a field burn, ~300 MW a serious wildfire,
 * ~3 000 MW a firestorm. Log scale, because FRP spans four orders of magnitude.
 */
export function fireSeverityScore(totalFrpMw: number): number {
  return clamp01(Math.log10(totalFrpMw + 1) / 3.5);
}

function clusterToHazard(key: string, members: FireDetection[]): Hazard {
  const totalFrp = members.reduce((sum, d) => sum + d.frp, 0);
  // FRP-weighted centroid: the point drawn is where the fire is burning hardest.
  const weight = (d: FireDetection) => (totalFrp > 0 ? d.frp / totalFrp : 1 / members.length);
  const latitude = members.reduce((sum, d) => sum + d.latitude * weight(d), 0);
  const longitude = members.reduce((sum, d) => sum + d.longitude * weight(d), 0);
  const latest = Math.max(...members.map((d) => d.acquiredAtMs));
  const highConfidence = members.filter((d) => d.confidence === 'h' || d.confidence === 'high').length;
  const score = round(fireSeverityScore(totalFrp), 2);

  return {
    id: `firms:${key}`,
    kind: 'FIRE',
    title: `Active fire — ${members.length} detection${members.length === 1 ? '' : 's'}`,
    severity: levelFromScore(score),
    severityScore: score,
    latitude: round(latitude, 4),
    longitude: round(longitude, 4),
    radiusKm: 10,
    observedAt: new Date(latest).toISOString(),
    source: 'NASA FIRMS (VIIRS NOAA-20)',
    url: `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${longitude.toFixed(2)},${latitude.toFixed(2)},10z`,
    details: {
      detections: members.length,
      highConfidenceDetections: highConfidence,
      totalFrpMw: round(totalFrp, 1),
      maxFrpMw: round(Math.max(...members.map((d) => d.frp)), 1),
      daynight: members[0].daynight || null,
    },
    track: null,
    cone: null,
  };
}

/* ------------------------------------------------------------------ bboxes */

export interface ClampedBox {
  box: BoundingBox;
  clamped: boolean;
}

/**
 * Shrinks a viewport larger than MAX_FIRMS_SPAN_DEG to a box of that size around its centre.
 * The caller reports `clamped` so the user knows fires outside the centre were not looked for.
 */
export function clampFirmsBox(box: BoundingBox, maxSpanDeg = MAX_FIRMS_SPAN_DEG): ClampedBox {
  const lonSpan = box.minLon <= box.maxLon ? box.maxLon - box.minLon : 360 - (box.minLon - box.maxLon);
  const latSpan = box.maxLat - box.minLat;
  if (latSpan <= maxSpanDeg && lonSpan <= maxSpanDeg) return { box, clamped: false };

  const centreLat = (box.minLat + box.maxLat) / 2;
  const centreLon = wrapLon(box.minLon + lonSpan / 2);
  const halfLat = Math.min(latSpan, maxSpanDeg) / 2;
  const halfLon = Math.min(lonSpan, maxSpanDeg) / 2;
  return {
    box: {
      minLat: Math.max(-90, centreLat - halfLat),
      maxLat: Math.min(90, centreLat + halfLat),
      minLon: wrapLon(centreLon - halfLon),
      maxLon: wrapLon(centreLon + halfLon),
    },
    clamped: true,
  };
}

/** FIRMS takes west,south,east,north and does not understand wrapping, so split at 180°. */
export function splitAtAntimeridian(box: BoundingBox): BoundingBox[] {
  if (box.minLon <= box.maxLon) return [box];
  return [
    { ...box, maxLon: 180 },
    { ...box, minLon: -180 },
  ];
}

/**
 * Boxes around asset positions for the exposure check. Sites are snapped to a 5° grid so ten
 * warehouses around one city cost one FIRMS query, and the result is capped so a company with
 * sites on every continent cannot turn one page load into dozens of upstream requests.
 */
export function boxesAroundPoints(
  points: Array<{ latitude: number; longitude: number }>,
  paddingDeg: number,
  maxBoxes = 12,
): BoundingBox[] {
  const cells = new Map<string, BoundingBox>();
  for (const p of points) {
    const cellLat = Math.floor(p.latitude / 5) * 5;
    const cellLon = Math.floor(p.longitude / 5) * 5;
    const key = `${cellLat}:${cellLon}`;
    if (cells.has(key)) continue;
    cells.set(key, {
      minLat: Math.max(-90, cellLat - paddingDeg),
      maxLat: Math.min(90, cellLat + 5 + paddingDeg),
      minLon: Math.max(-180, cellLon - paddingDeg),
      maxLon: Math.min(180, cellLon + 5 + paddingDeg),
    });
    if (cells.size >= maxBoxes) break;
  }
  return [...cells.values()];
}

function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Cache key and URL segment (west,south,east,north). Edges snap outward to 0.5° so near-identical
 * viewports share one query, and snapping outward means the snapped box never loses area.
 */
export function firmsAreaKey(box: BoundingBox): string {
  const down = (n: number, limit: number) => Math.max(-limit, Math.floor(n * 2) / 2).toFixed(1);
  const up = (n: number, limit: number) => Math.min(limit, Math.ceil(n * 2) / 2).toFixed(1);
  return `${down(box.minLon, 180)},${down(box.minLat, 90)},${up(box.maxLon, 180)},${up(box.maxLat, 90)}`;
}

/* ------------------------------------------------------------------- fetch */

/** The URL embeds the MAP_KEY: it must never be logged, and UpstreamError only carries the host. */
export async function fetchFirmsArea(mapKey: string, box: BoundingBox, nowMs = Date.now()): Promise<Hazard[]> {
  const detections: FireDetection[] = [];
  for (const part of splitAtAntimeridian(box)) {
    const url =
      `https://${FIRMS_HOST}/api/area/csv/${encodeURIComponent(mapKey)}/${FIRMS_SOURCE}/` +
      `${firmsAreaKey(part)}/2`;
    const text = await fetchTextCapped(url, { maxBytes: 8 * 1024 * 1024, timeoutMs: 30_000 });
    for (const d of parseFirmsCsv(text, nowMs, MAX_FIRMS_ROWS - detections.length)) detections.push(d);
  }
  return clusterFires(detections);
}
