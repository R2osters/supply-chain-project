/**
 * City of Calgary traffic cameras (Open Calgary, Socrata dataset k7p9-kppz).
 *
 * Most rows publish an `http://` frame URL; the host serves HTTPS and 301-redirects there, so the
 * URL is upgraded up front (frame fetches refuse redirects). The dataset has no id column: the
 * frame filename ("loc86.jpg") is the stable per-camera token the city itself keys on.
 *
 * No heading is derived. The `quadrant` field and the "SE" suffix on each location are Calgary's
 * address grid, not a bearing; converting them would give every camera a confident wrong facing.
 *
 * Adapted from God's Eye View (MIT), `server/providers/cctv/sources.js`
 * (calgaryCameraToSource, normalizeCalgaryImageUrl, calgaryCameraId).
 */
import type { CameraPack, CameraRecord } from '../camera.types';
import { dedupeById, isInsideBox, parseUrl, toFiniteNumber, toTrimmedString } from './normalize-helpers';

const FRAME_HOST = 'trafficcam.calgary.ca';
const CALGARY_BOX = { minLat: 50.8, maxLat: 51.25, minLon: -114.4, maxLon: -113.8 };
const FRAME_FILE = /^\/loc(\d{1,6})\.jpg$/i;

interface CalgaryRow {
  camera_url?: { url?: unknown; description?: unknown };
  camera_location?: unknown;
  point?: { coordinates?: unknown[] };
}

export function normalizeCalgary(raw: unknown): CameraRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: CameraRecord[] = [];
  for (const row of raw as CalgaryRow[]) {
    const record = rowToRecord(row);
    if (record) records.push(record);
  }
  return dedupeById(records);
}

function rowToRecord(row: CalgaryRow): CameraRecord | null {
  if (!row || typeof row !== 'object') return null;
  const coordinates = row.point?.coordinates ?? [];
  const longitude = toFiniteNumber(coordinates[0]);
  const latitude = toFiniteNumber(coordinates[1]);
  if (!isInsideBox(latitude, longitude, CALGARY_BOX)) return null;

  const frame = upgradeFrameUrl(row.camera_url?.url);
  const match = frame ? FRAME_FILE.exec(frame.pathname) : null;
  if (!frame || !match) return null;
  const upstreamId = match[1];

  return {
    upstreamId,
    name:
      toTrimmedString(row.camera_location) ||
      toTrimmedString(row.camera_url?.description) ||
      `Calgary camera ${upstreamId}`,
    latitude: latitude as number,
    longitude: longitude as number,
    headingDegrees: null,
    direction: null,
    frameUrl: frame.toString(),
  };
}

function upgradeFrameUrl(value: unknown): URL | null {
  const url = parseUrl(value);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
  url.protocol = 'https:';
  return url.hostname === FRAME_HOST && !url.port ? url : null;
}

export const calgaryPack: CameraPack = {
  id: 'calgary',
  label: 'City of Calgary traffic cameras',
  attribution: 'Contains information licensed under the Open Government Licence – City of Calgary',
  licence: 'Open Government Licence – City of Calgary',
  catalogUrl: 'https://data.calgary.ca/resource/k7p9-kppz.json?$limit=500',
  refreshSeconds: 60,
  frameHosts: [FRAME_HOST],
  upgradeHttpFrames: true,
  normalize: normalizeCalgary,
};
