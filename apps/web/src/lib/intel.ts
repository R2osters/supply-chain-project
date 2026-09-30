/**
 * Wire types for the situational feeds: hazards, cameras, radio, satellites, traffic, geocoding.
 * They mirror the API contracts documented in docs/INTEL.md. Kept apart from `api.ts` because
 * they belong to one screen family, and the core client should not grow with every feature.
 */

export type FeedStatus = 'OK' | 'STALE' | 'UNAVAILABLE' | 'DISABLED';

/* ------------------------------------------------------------------ hazards */

export type HazardKind = 'CYCLONE' | 'EARTHQUAKE' | 'FIRE' | 'SEVERE_WEATHER' | 'FLOOD' | 'DROUGHT' | 'VOLCANO';

/** Every kind, in legend order. The map draws one sprite per kind, so a kind missing here has no icon. */
export const HAZARD_KINDS: readonly HazardKind[] = [
  'CYCLONE',
  'EARTHQUAKE',
  'FIRE',
  'SEVERE_WEATHER',
  'FLOOD',
  'DROUGHT',
  'VOLCANO',
];
export type HazardSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Hazard {
  id: string;
  kind: HazardKind;
  title: string;
  severity: HazardSeverity;
  severityScore: number;
  latitude: number;
  longitude: number;
  radiusKm: number;
  observedAt: string;
  source: string;
  url: string | null;
  details: Record<string, string | number | boolean | null>;
  track: Array<{ latitude: number; longitude: number; at: string | null }> | null;
  cone: Array<Array<[number, number]>> | null;
}

export interface SourceStatus {
  id: string;
  label: string;
  status: FeedStatus;
  fetchedAt: string | null;
  count: number;
  attribution: string;
  note: string | null;
}

export interface HazardsResponse {
  generatedAt: string;
  sources: SourceStatus[];
  hazards: Hazard[];
}

export interface Exposure {
  hazardId: string;
  hazardKind: HazardKind;
  hazardTitle: string;
  severity: HazardSeverity;
  subjectType: 'WAREHOUSE' | 'SHIPMENT' | 'SUPPLIER';
  subjectId: string;
  subjectLabel: string;
  latitude: number;
  longitude: number;
  distanceKm: number;
}

export interface ExposureResponse {
  radiusKm: number;
  generatedAt: string;
  exposures: Exposure[];
  sources: SourceStatus[];
}

export interface PointWeather {
  latitude: number;
  longitude: number;
  observedAt: string;
  temperatureC: number | null;
  windKmh: number | null;
  windGustKmh: number | null;
  precipitationMm: number | null;
  visibilityM: number | null;
  cloudCoverPct: number | null;
  weatherCode: number | null;
  condition: string;
  severity: number;
  reasons: string[];
  attribution: string;
  stale: boolean;
}

export interface NewsResponse {
  status: FeedStatus;
  query: string;
  articles: Array<{
    title: string;
    url: string;
    domain: string;
    publishedAt: string | null;
    sourceCountry: string | null;
  }>;
  attribution: string;
}

/* ------------------------------------------------------------------ cameras */

export interface Camera {
  id: string;
  pack: string;
  name: string;
  latitude: number;
  longitude: number;
  headingDegrees: number | null;
  direction: string | null;
  refreshSeconds: number;
  attribution: string;
  distanceKm?: number;
}

export interface CameraPackStatus {
  id: string;
  label: string;
  status: FeedStatus;
  count: number;
  fetchedAt: string | null;
  attribution: string;
  licence: string;
}

export interface CamerasResponse {
  cameras: Camera[];
  packs: CameraPackStatus[];
}

/* -------------------------------------------------------------------- radio */

export interface RadioStation {
  id: string;
  name: string;
  streamUrl: string;
  homepage: string | null;
  country: string | null;
  countryCode: string | null;
  state: string | null;
  language: string | null;
  tags: string[];
  codec: string | null;
  bitrate: number | null;
  latitude: number;
  longitude: number;
  distanceKm: number;
}

export interface RadioResponse {
  status: FeedStatus;
  fetchedAt: string | null;
  attribution: string;
  stations: RadioStation[];
}

/* --------------------------------------------------------------- satellites */

export interface SatelliteGroup {
  id: string;
  label: string;
  description: string;
}

export interface TleRecord {
  noradId: number;
  name: string;
  line1: string;
  line2: string;
  epoch: string;
}

export interface TleResponse {
  group: string;
  fetchedAt: string;
  stale: boolean;
  attribution: string;
  satellites: TleRecord[];
}

export interface VisibleSatellitesResponse {
  group: string;
  at: string;
  latitude: number;
  longitude: number;
  minElevationDeg: number;
  visible: Array<{
    noradId: number;
    name: string;
    elevationDeg: number;
    azimuthDeg: number;
    rangeKm: number;
  }>;
  summary: { count: number; above30Deg: number; quality: 'GOOD' | 'FAIR' | 'POOR' };
}

/* ------------------------------------------------------------------ traffic */

export interface TrafficSourceStatus {
  id: 'tomtom' | 'rennes' | 'grenoble';
  active: boolean;
  stale: boolean;
  updatedAt: string | null;
  attribution: string;
}

export interface TrafficStatus {
  enabled: boolean;
  provider: 'TomTom' | null;
  tilesUsedToday: number;
  /** TomTom tiles allowed per UTC day; 0 = unlimited. */
  dailyBudget: number;
  attribution: string | null;
  note: string | null;
  /** TomTom and the keyless measured-speed sources (Rennes, Grenoble), with their last outcome. */
  sources?: TrafficSourceStatus[];
}

/* ---------------------------------------------------------------- geocoding */

export interface GeocodeResponse {
  source: 'coordinates' | 'photon' | 'nominatim' | 'none';
  results: Array<{
    label: string;
    latitude: number;
    longitude: number;
    kind: string | null;
    country: string | null;
  }>;
}

/* ------------------------------------------------------------------ helpers */

export interface Bounds {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** Query string for a bounding box, rounded so small pans hit the same server cache entry. */
export function boundsQuery(bounds: Bounds, decimals = 1): string {
  const step = 10 ** decimals;
  const down = (value: number): number => Math.floor(value * step) / step;
  const up = (value: number): number => Math.ceil(value * step) / step;
  const params = new URLSearchParams({
    minLat: String(Math.max(-90, down(bounds.minLat))),
    minLon: String(Math.max(-180, down(bounds.minLon))),
    maxLat: String(Math.min(90, up(bounds.maxLat))),
    maxLon: String(Math.min(180, up(bounds.maxLon))),
  });
  return params.toString();
}

/**
 * Returns the URL only when it is plain http(s). Station homepages and news links are written by
 * third parties; a `javascript:` URL in an href is script execution on click.
 */
export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Charte §03: colour is reserved for exceptions. A hazard's colour therefore comes from its
 * severity (crit for high, warn for medium, grey for low) and the *kind* is told apart by its
 * icon, never by hue. Values are palette token names so the map and the DOM follow the theme.
 */
export type HazardTone = 'crit' | 'warn' | 'muted';

export const HAZARD_TONE: Record<HazardSeverity, HazardTone> = {
  CRITICAL: 'crit',
  HIGH: 'crit',
  MEDIUM: 'warn',
  LOW: 'muted',
};

/** The CSS variable for a hazard's tone, for DOM elements (which follow the theme on their own). */
export function hazardToneVar(severity: HazardSeverity): string {
  return `var(--color-${HAZARD_TONE[severity]})`;
}

/**
 * The phrase to search news for. USGS titles read "M 5.1 - 12 km SSW of Somewhere, Country";
 * the place after "of" is what reporters actually write. Other hazards use their title.
 */
export function newsKeyword(hazard: Hazard): string {
  const place = typeof hazard.details.place === 'string' ? hazard.details.place : hazard.title;
  const afterOf = /\bof\s+(.+)$/i.exec(place)?.[1];
  return (afterOf ?? place).replace(/^M\s*[\d.]+\s*-\s*/i, '').trim().slice(0, 80);
}
