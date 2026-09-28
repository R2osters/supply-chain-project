/**
 * Transport for London JamCams.
 *
 * One keyless list endpoint for the whole city; frames are stills on TfL's public S3 bucket. The
 * S3 host is shared by every bucket in the region, so the frame path is pinned to TfL's bucket as
 * well as the host — otherwise a poisoned catalogue row could point the proxy at anyone's bucket.
 *
 * Adapted from God's Eye View (MIT), `server/providers/cctv/sources.js` (loadTflSourcesFromOpenData).
 */
import type { CameraPack, CameraRecord } from '../camera.types';
import { dedupeById, isInsideBox, parseUrl, toFiniteNumber, toSafeId, toTrimmedString } from './normalize-helpers';

const FRAME_HOST = 's3-eu-west-1.amazonaws.com';
const FRAME_PATH_PREFIX = '/jamcams.tfl.gov.uk/';
// Greater London with a margin for cameras out towards the M25.
const LONDON_BOX = { minLat: 51.2, maxLat: 51.8, minLon: -0.7, maxLon: 0.4 };

interface TflPlace {
  id?: unknown;
  commonName?: unknown;
  lat?: unknown;
  lon?: unknown;
  additionalProperties?: Array<{ key?: unknown; value?: unknown }>;
}

export function normalizeTfl(raw: unknown): CameraRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: CameraRecord[] = [];
  for (const place of raw as TflPlace[]) {
    const record = placeToRecord(place);
    if (record) records.push(record);
  }
  return dedupeById(records);
}

function placeToRecord(place: TflPlace): CameraRecord | null {
  if (!place || typeof place !== 'object') return null;
  const props = readAdditionalProperties(place.additionalProperties);
  // TfL keeps offline cameras in the list and flags them; showing one would be a black frame.
  if (toTrimmedString(props.available).toLowerCase() !== 'true') return null;

  const latitude = toFiniteNumber(place.lat);
  const longitude = toFiniteNumber(place.lon);
  if (!isInsideBox(latitude, longitude, LONDON_BOX)) return null;

  const frame = parseUrl(props.imageUrl);
  if (!frame || frame.protocol !== 'https:' || frame.hostname !== FRAME_HOST) return null;
  if (!frame.pathname.startsWith(FRAME_PATH_PREFIX)) return null;

  // "JamCams_00002.00865" -> "00002.00865"
  const upstreamId = toSafeId(toTrimmedString(place.id).replace(/^JamCams_/, ''));
  if (!upstreamId) return null;

  return {
    upstreamId,
    name: toTrimmedString(place.commonName) || `JamCam ${upstreamId}`,
    latitude: latitude as number,
    longitude: longitude as number,
    // JamCam data carries no facing at all.
    headingDegrees: null,
    direction: null,
    frameUrl: frame.toString(),
  };
}

function readAdditionalProperties(list: TflPlace['additionalProperties']): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (!Array.isArray(list)) return props;
  for (const entry of list) {
    if (entry && typeof entry.key === 'string') props[entry.key] = entry.value;
  }
  return props;
}

export const tflPack: CameraPack = {
  id: 'tfl',
  label: 'Transport for London JamCams',
  attribution: 'Powered by TfL Open Data. Contains OS data © Crown copyright and database rights',
  licence: 'TfL Open Data terms',
  catalogUrl: 'https://api.tfl.gov.uk/Place/Type/JamCam',
  refreshSeconds: 60,
  frameHosts: [FRAME_HOST],
  framePathPrefix: FRAME_PATH_PREFIX,
  normalize: normalizeTfl,
};
