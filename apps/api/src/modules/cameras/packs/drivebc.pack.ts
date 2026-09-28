/**
 * DriveBC highway cameras (British Columbia).
 *
 * The frame URL is built from the numeric camera id on the current image host. The DataBC CSV of
 * the same cameras still lists the retired `images.drivebc.ca` URLs, which now return a
 * placeholder picture — a frame that looks live and is not.
 *
 * Adapted from God's Eye View (MIT), `server/providers/cctv/sources.js`
 * (loadDriveBcSourcesFromOpenData).
 */
import type { CameraPack, CameraRecord } from '../camera.types';
import { dedupeById, headingFromDirection, isInsideBox, toFiniteNumber, toTrimmedString } from './normalize-helpers';

const FRAME_HOST = 'www.drivebc.ca';
const BC_BOX = { minLat: 48, maxLat: 60.5, minLon: -139.5, maxLon: -114 };

interface DriveBcRow {
  id?: unknown;
  name?: unknown;
  is_on?: unknown;
  should_appear?: unknown;
  orientation?: unknown;
  location?: { coordinates?: unknown[] };
}

export function normalizeDriveBc(raw: unknown): CameraRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: CameraRecord[] = [];
  for (const row of raw as DriveBcRow[]) {
    const record = rowToRecord(row);
    if (record) records.push(record);
  }
  return dedupeById(records);
}

function rowToRecord(row: DriveBcRow): CameraRecord | null {
  if (!row || typeof row !== 'object') return null;
  // Switched-off and unpublished cameras stay in the feed; both flags must be true.
  if (row.is_on !== true || row.should_appear !== true) return null;
  const id = row.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;

  // GeoJSON order: [longitude, latitude].
  const coordinates = row.location?.coordinates ?? [];
  const longitude = toFiniteNumber(coordinates[0]);
  const latitude = toFiniteNumber(coordinates[1]);
  if (!isInsideBox(latitude, longitude, BC_BOX)) return null;

  const orientation = toTrimmedString(row.orientation).toUpperCase() || null;
  return {
    upstreamId: String(id),
    name: toTrimmedString(row.name) || `DriveBC camera ${id}`,
    latitude: latitude as number,
    longitude: longitude as number,
    headingDegrees: headingFromDirection(orientation),
    direction: orientation,
    frameUrl: `https://${FRAME_HOST}/images/${id}.jpg`,
  };
}

export const drivebcPack: CameraPack = {
  id: 'drivebc',
  label: 'DriveBC highway cameras',
  attribution: 'DriveBC. Contains information licensed under the Open Government Licence – British Columbia',
  licence: 'Open Government Licence – British Columbia',
  catalogUrl: 'https://www.drivebc.ca/api/webcams/',
  refreshSeconds: 60,
  frameHosts: [FRAME_HOST],
  framePathPrefix: '/images/',
  normalize: normalizeDriveBc,
};
