/**
 * Fintraffic road weather cameras (Digitraffic), all of Finland.
 *
 * One station has several presets — fixed views from the same pole — and a preset is what an
 * operator actually looks at, so one preset is one camera here. Frame URLs are built from a
 * strictly shaped preset id on the official image host rather than read from the payload, which
 * pins frames to that host by construction.
 *
 * Digitraffic asks every client to identify itself with a `Digitraffic-User` header.
 *
 * Adapted from God's Eye View (MIT), `server/providers/cctv/sources.js`
 * (loadFintrafficSourcesFromOpenData) and `normalize.js` (fintrafficCameraName).
 */
import type { CameraPack, CameraRecord } from '../camera.types';
import { dedupeById, isInsideBox, toFiniteNumber, toTrimmedString } from './normalize-helpers';

const FRAME_HOST = 'weathercam.digitraffic.fi';
const DIGITRAFFIC_USER = { 'Digitraffic-User': 'SCIP' };
const FINLAND_BOX = { minLat: 59.5, maxLat: 70.5, minLon: 19, maxLon: 32 };
// Station id plus a two-digit view number. Also what keeps a hostile id out of the frame path.
const PRESET_ID = /^C\d{7}$/;

interface FintrafficFeature {
  geometry?: { coordinates?: unknown[] };
  properties?: {
    id?: unknown;
    name?: unknown;
    collectionStatus?: unknown;
    presets?: Array<{ id?: unknown; inCollection?: unknown }>;
  };
}

export function normalizeFintraffic(raw: unknown): CameraRecord[] {
  const features = (raw as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  const records: CameraRecord[] = [];
  for (const feature of features as FintrafficFeature[]) {
    records.push(...stationToRecords(feature));
  }
  return dedupeById(records);
}

function stationToRecords(feature: FintrafficFeature): CameraRecord[] {
  const props = feature?.properties;
  const stationId = toTrimmedString(props?.id);
  if (!props || !stationId) return [];
  // GATHERING is the only status meaning the station is taking pictures right now.
  if (toTrimmedString(props.collectionStatus).toUpperCase() !== 'GATHERING') return [];

  const coordinates = feature.geometry?.coordinates ?? [];
  const longitude = toFiniteNumber(coordinates[0]);
  const latitude = toFiniteNumber(coordinates[1]);
  if (!isInsideBox(latitude, longitude, FINLAND_BOX)) return [];

  const stationName = toTrimmedString(props.name).replace(/_/g, ' ') || `Fintraffic ${stationId}`;
  const records: CameraRecord[] = [];
  for (const preset of Array.isArray(props.presets) ? props.presets : []) {
    if (preset?.inCollection !== true) continue;
    const presetId = toTrimmedString(preset.id);
    if (!PRESET_ID.test(presetId) || !presetId.startsWith(stationId)) continue;
    records.push({
      upstreamId: presetId,
      name: `${stationName} (view ${presetId.slice(stationId.length)})`,
      latitude: latitude as number,
      longitude: longitude as number,
      // The only facing Digitraffic publishes is road-register relative, not a bearing.
      headingDegrees: null,
      direction: null,
      frameUrl: `https://${FRAME_HOST}/${presetId}.jpg`,
    });
  }
  return records;
}

export const fintrafficPack: CameraPack = {
  id: 'fintraffic',
  label: 'Fintraffic weather cameras (Finland)',
  attribution: 'Fintraffic / digitraffic.fi, license CC BY 4.0',
  licence: 'CC BY 4.0',
  catalogUrl: 'https://tie.digitraffic.fi/api/weathercam/v1/stations',
  // Stations collect a new picture about every ten minutes.
  refreshSeconds: 600,
  frameHosts: [FRAME_HOST],
  catalogHeaders: DIGITRAFFIC_USER,
  frameHeaders: DIGITRAFFIC_USER,
  normalize: normalizeFintraffic,
};
