/**
 * Ontario 511 highway cameras.
 *
 * Each catalogue row is a camera site with one or more views; the first enabled view that is not
 * flagged as down is the one shown. View URLs are rebuilt on the canonical still host from a
 * validated view id, so a row pointing elsewhere is dropped instead of proxied.
 *
 * Note (2026-09): the `api/v2/get/cameras` endpoint now answers "Invalid Key" without a developer
 * key, so this pack reports UNAVAILABLE until a key is wired through configuration.
 *
 * Adapted from God's Eye View (MIT), `server/providers/cctv/sources.js`
 * (loadOntarioSourcesFromOpenData, normalizeOntarioCctvUrl, pickOntarioCctvView).
 */
import type { CameraPack, CameraRecord } from '../camera.types';
import {
  dedupeById,
  headingFromDirection,
  isInsideBox,
  parseUrl,
  toFiniteNumber,
  toSafeId,
  toTrimmedString,
} from './normalize-helpers';

const FRAME_HOST = '511on.ca';
const ONTARIO_BOX = { minLat: 41.0, maxLat: 57.5, minLon: -95.6, maxLon: -74.0 };

interface OntarioView {
  Url?: unknown;
  Status?: unknown;
  Description?: unknown;
}

interface OntarioRow {
  Id?: unknown;
  Latitude?: unknown;
  Longitude?: unknown;
  Location?: unknown;
  Roadway?: unknown;
  Direction?: unknown;
  Views?: unknown;
}

interface PickedView {
  frameUrl: string;
  description: string;
}

export function normalizeOntario511(raw: unknown): CameraRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: CameraRecord[] = [];
  for (const row of raw as OntarioRow[]) {
    const record = rowToRecord(row);
    if (record) records.push(record);
  }
  return dedupeById(records);
}

function rowToRecord(row: OntarioRow): CameraRecord | null {
  if (!row || typeof row !== 'object') return null;
  const upstreamId = toSafeId(row.Id);
  if (!upstreamId) return null;
  const latitude = toFiniteNumber(row.Latitude);
  const longitude = toFiniteNumber(row.Longitude);
  if (!isInsideBox(latitude, longitude, ONTARIO_BOX)) return null;

  const view = pickView(row.Views);
  if (!view) return null;

  const place =
    toTrimmedString(row.Location) || toTrimmedString(row.Roadway) || `Ontario 511 camera ${upstreamId}`;
  const direction = toTrimmedString(row.Direction);
  const usableDirection = direction && direction.toLowerCase() !== 'unknown' ? direction : null;
  return {
    upstreamId,
    name: view.description ? `${place} - ${view.description}` : place,
    latitude: latitude as number,
    longitude: longitude as number,
    headingDegrees: headingFromDirection(usableDirection) ?? headingFromDirection(view.description),
    direction: usableDirection,
    frameUrl: view.frameUrl,
  };
}

function pickView(views: unknown): PickedView | null {
  if (!Array.isArray(views)) return null;
  for (const view of views as OntarioView[]) {
    if (toTrimmedString(view?.Status).toLowerCase() !== 'enabled') continue;
    const description = toTrimmedString(view.Description);
    // Ontario marks a broken view in its description ("Camera down") rather than its status.
    if (/\bdown\b/i.test(description)) continue;
    const frameUrl = canonicalFrameUrl(view.Url);
    if (frameUrl) return { frameUrl, description };
  }
  return null;
}

function canonicalFrameUrl(value: unknown): string | null {
  const url = parseUrl(value);
  if (!url || url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  // 511on.ca runs on Castle Rock's platform; some rows still carry a traveliq.co hostname.
  if (host !== FRAME_HOST && !host.endsWith('.traveliq.co')) return null;
  const match = /^\/map\/Cctv\/([^/?#]+)$/.exec(url.pathname);
  const viewId = match ? toSafeId(decodeSegment(match[1])) : null;
  return viewId ? `https://${FRAME_HOST}/map/Cctv/${viewId}` : null;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

export const ontario511Pack: CameraPack = {
  id: 'ontario511',
  label: 'Ontario 511',
  attribution: 'Ontario 511. Contains information licensed under the Open Government Licence – Ontario',
  licence: 'Open Government Licence – Ontario',
  catalogUrl: 'https://511on.ca/api/v2/get/cameras?format=json&lang=en',
  refreshSeconds: 60,
  frameHosts: [FRAME_HOST],
  framePathPrefix: '/map/Cctv/',
  normalize: normalizeOntario511,
};
