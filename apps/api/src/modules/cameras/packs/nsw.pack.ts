/**
 * Live Traffic NSW cameras (Transport for NSW).
 *
 * The image host answers non-browser clients with HTTP 200 and a short HTML page instead of the
 * picture, so frame requests identify as a browser — for this host only. The magic-byte check on
 * frames would reject that HTML anyway; the header is what makes the real picture arrive.
 *
 * Adapted from God's Eye View (MIT), `server/providers/cctv/sources.js` (nswCameraToSource,
 * nswCameraLabel) and `constants.js` (NSW_IMAGE_USER_AGENT).
 */
import type { CameraPack, CameraRecord } from '../camera.types';
import { dedupeById, headingFromDirection, isInsideBox, parseUrl, toSafeId, toTrimmedString } from './normalize-helpers';

const FRAME_HOST = 'webcams.transport.nsw.gov.au';
const NSW_BOX = { minLat: -38, maxLat: -28, minLon: 140.9, maxLon: 159.2 };
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// NSW sometimes reuses `view` for a multi-paragraph works notice; real descriptions stay short.
const MAX_VIEW_LABEL = 140;

interface NswProperties {
  title?: unknown;
  view?: unknown;
  direction?: unknown;
  href?: unknown;
}

interface NswFeature {
  id?: unknown;
  geometry?: { coordinates?: unknown[] };
  properties?: NswProperties;
}

export function normalizeNsw(raw: unknown): CameraRecord[] {
  const features = (raw as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  const records: CameraRecord[] = [];
  for (const feature of features as NswFeature[]) {
    const record = featureToRecord(feature);
    if (record) records.push(record);
  }
  return dedupeById(records);
}

function featureToRecord(feature: NswFeature): CameraRecord | null {
  const upstreamId = toSafeId(feature?.id);
  if (!upstreamId) return null;
  const coordinates = feature.geometry?.coordinates ?? [];
  // Numbers only here: Number(null) is 0, which would park a camera on the equator.
  const longitude = typeof coordinates[0] === 'number' ? coordinates[0] : null;
  const latitude = typeof coordinates[1] === 'number' ? coordinates[1] : null;
  if (!isInsideBox(latitude, longitude, NSW_BOX)) return null;

  const props = feature.properties ?? {};
  const frame = parseUrl(props.href);
  if (!frame || frame.protocol !== 'https:' || frame.hostname !== FRAME_HOST) return null;

  const direction = toTrimmedString(props.direction) || null;
  return {
    upstreamId,
    name: cameraLabel(props) || `Caméra NSW ${upstreamId}`,
    latitude: latitude as number,
    longitude: longitude as number,
    headingDegrees: headingFromDirection(direction),
    direction,
    frameUrl: frame.toString(),
  };
}

/** The `view` sentence when it really is one ("... looking west towards Sutherland."), else the title. */
export function cameraLabel(props: NswProperties): string {
  const view = toTrimmedString(props.view);
  const title = toTrimmedString(props.title);
  const viewIsALabel = view.length > 0 && view.length <= MAX_VIEW_LABEL && !/[\r\n]/.test(view);
  return viewIsALabel ? view : title;
}

export const nswPack: CameraPack = {
  id: 'nsw',
  label: 'Live Traffic NSW',
  attribution: 'Live Traffic NSW — Transport for NSW, CC BY 4.0',
  licence: 'CC BY 4.0',
  catalogUrl: 'https://data.livetraffic.com/cameras/traffic-cam.json',
  refreshSeconds: 60,
  frameHosts: [FRAME_HOST],
  frameHeaders: { 'User-Agent': BROWSER_USER_AGENT },
  normalize: normalizeNsw,
};
