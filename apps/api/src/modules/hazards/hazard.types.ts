/**
 * The shapes the hazards endpoints return.
 *
 * These are a contract with the web client, which is built against the exact field names below.
 * Every source — NOAA, USGS, NASA, Open-Meteo — is normalised into `Hazard` so the map, the
 * exposure list and the risk engine each handle one shape instead of five upstream dialects.
 */

export const HAZARD_KINDS = ['CYCLONE', 'EARTHQUAKE', 'FIRE', 'SEVERE_WEATHER'] as const;
export type HazardKind = (typeof HAZARD_KINDS)[number];

export const SEVERITY_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

export type HazardDetailValue = string | number | boolean | null;

export interface TrackPoint {
  latitude: number;
  longitude: number;
  at: string | null;
}

/** A polygon ring as [lon, lat] pairs — GeoJSON order, so the map can use it untouched. */
export type LonLatRing = Array<[number, number]>;

export interface Hazard {
  id: string;
  kind: HazardKind;
  title: string;
  severity: SeverityLevel;
  /** 0..1, comparable across kinds only roughly: it orders a list, it is not a probability. */
  severityScore: number;
  latitude: number;
  longitude: number;
  /** Area of concern around the point, km. A heuristic footprint, not a damage model. */
  radiusKm: number;
  observedAt: string;
  source: string;
  url: string | null;
  details: Record<string, HazardDetailValue>;
  track: TrackPoint[] | null;
  cone: LonLatRing[] | null;
}

export type SourceId = 'nhc' | 'usgs' | 'firms' | 'open-meteo' | 'gdelt';
export type SourceState = 'OK' | 'STALE' | 'UNAVAILABLE' | 'DISABLED';

export interface SourceStatus {
  id: SourceId;
  label: string;
  status: SourceState;
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

export interface WeatherResponse {
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

export type ExposureSubjectType = 'WAREHOUSE' | 'SHIPMENT' | 'SUPPLIER';

export interface Exposure {
  hazardId: string;
  hazardKind: HazardKind;
  hazardTitle: string;
  severity: SeverityLevel;
  subjectType: ExposureSubjectType;
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

export interface NewsArticle {
  title: string;
  url: string;
  domain: string;
  publishedAt: string | null;
  sourceCountry: string | null;
}

export interface NewsResponse {
  status: 'OK' | 'STALE' | 'UNAVAILABLE';
  query: string;
  articles: NewsArticle[];
  attribution: 'GDELT Project';
}

/** Bounding box in degrees. `minLon > maxLon` means the box crosses the antimeridian. */
export interface BoundingBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}
