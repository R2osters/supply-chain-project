import { UpstreamError, fetchJsonCapped } from '../../../common/http';
import { clamp01, cleanText, levelFromScore, round, toFiniteOrNull } from '../hazard-severity';
import type { Hazard, LonLatRing, TrackPoint } from '../hazard.types';

/**
 * NOAA National Hurricane Center: active tropical cyclones, their forecast track and cone.
 *
 * Two keyless endpoints. `CurrentStorms.json` gives the position and intensity of every active
 * storm; the tropical-weather-summary MapServer gives the 5-day forecast points (layer 5), track
 * line (6) and cone of uncertainty (7). Geometry is attached only when its advisory number
 * matches the status advisory — drawing Tuesday's cone under Wednesday's storm position would be
 * worse than drawing no cone at all.
 *
 * Coverage is the Atlantic and the eastern/central North Pacific. A typhoon near Manila is not
 * in this feed, and the source status says so rather than implying a quiet planet.
 *
 * Adapted from God's Eye View (MIT), server/providers/cyclones.js
 */

export const NHC_STATUS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';
export const NHC_GIS_URL =
  'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer';
export const NHC_COVERAGE_NOTE =
  'Le NHC ne couvre que l’Atlantique et le Pacifique Nord oriental et central : les typhons du ' +
  'Pacifique Ouest et les cyclones de l’océan Indien n’y figurent pas.';

const HOUR_MS = 3_600_000;
const KNOT_KMH = 1.852;

/** One MapServer layer: the id, the most features we accept, and the body ceiling. */
const GIS_LAYERS = {
  points: { id: 5, maxFeatures: 500, maxBytes: 512 * 1024 },
  track: { id: 6, maxFeatures: 32, maxBytes: 512 * 1024 },
  cone: { id: 7, maxFeatures: 32, maxBytes: 2 * 1024 * 1024 },
} as const;

type GisLayer = keyof typeof GIS_LAYERS;

export interface StormStatus {
  id: string;
  name: string;
  classification: string;
  basin: string;
  latitude: number;
  longitude: number;
  positionAt: string;
  advisoryNumber: string | null;
  windKt: number | null;
  pressureHpa: number | null;
  movementDirDeg: number | null;
  movementSpeedKt: number | null;
  advisoryUrl: string | null;
}

export interface StormGeometry {
  track: TrackPoint[] | null;
  cone: LonLatRing[] | null;
}

interface GeoJsonFeature {
  type?: unknown;
  geometry?: { type?: unknown; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

interface GeoJsonCollection {
  type?: unknown;
  features?: unknown;
}

/* ------------------------------------------------------------------ parsing */

/**
 * Parses `CurrentStorms.json`. One malformed storm is dropped rather than failing the feed:
 * a typo in one advisory should not hide a hurricane in the next basin.
 */
export function parseCurrentStorms(payload: unknown): StormStatus[] {
  const rawStorms = (payload as { activeStorms?: unknown } | null)?.activeStorms;
  if (!Array.isArray(rawStorms)) {
    throw new UpstreamError('Le flux d’état du NHC ne contient pas de liste activeStorms', 'www.nhc.noaa.gov', null);
  }
  const seen = new Set<string>();
  const storms: StormStatus[] = [];
  for (const raw of rawStorms.slice(0, 32)) {
    const storm = parseStorm(raw);
    if (!storm || seen.has(storm.id)) continue;
    seen.add(storm.id);
    storms.push(storm);
  }
  return storms;
}

function parseStorm(raw: unknown): StormStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^(?:al|ep|cp)\d{6}$/i.test(r.id)) return null;

  const latitude = toFiniteOrNull(r.latitudeNumeric);
  const longitude = toFiniteOrNull(r.longitudeNumeric);
  if (latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return null;
  }
  const name = cleanText(r.name, 80);
  if (!name) return null;

  const forecast = (r.forecastAdvisory ?? {}) as Record<string, unknown>;
  const id = r.id.toLowerCase();
  return {
    id,
    name,
    classification: cleanText(r.classification, 16) ?? 'TC',
    basin: id.slice(0, 2).toUpperCase(),
    latitude,
    longitude,
    positionAt: parseIso(r.lastUpdate) ?? new Date().toISOString(),
    advisoryNumber: normaliseAdvisory(forecast.advNum),
    windKt: boundedOrNull(r.intensity, 0, 300),
    pressureHpa: boundedOrNull(r.pressure, 800, 1100),
    movementDirDeg: boundedOrNull(r.movementDir, 0, 360),
    movementSpeedKt: boundedOrNull(r.movementSpeed, 0, 200),
    advisoryUrl: officialNhcLink(forecast.url),
  };
}

/** "007" and "7" are the same advisory; "12A" is an intermediate one. */
export function normaliseAdvisory(value: unknown): string | null {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,3}[A-Z]?$/i.test(text.trim())) return null;
  return text.trim().replace(/^0+(?=\d)/, '').toUpperCase();
}

function boundedOrNull(value: unknown, min: number, max: number): number | null {
  const n = toFiniteOrNull(value);
  return n !== null && n >= min && n <= max ? n : null;
}

function parseIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Only links to NHC's own advisory pages are passed on; anything else in the feed is dropped. */
function officialNhcLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const url = new URL(value);
    return url.origin === 'https://www.nhc.noaa.gov' && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- geometry */

interface ParsedGisFeature {
  stormId: string;
  advisoryNumber: string;
  tauHours: number | null;
  geometry: { type: string; coordinates: unknown };
}

/**
 * Reads one MapServer layer. Features are keyed by `idp_source`, e.g. `al052026-012_5day_pgn`,
 * which carries both the storm id and the advisory the geometry was drawn for.
 */
export function parseGisLayer(payload: unknown, layer: GisLayer): ParsedGisFeature[] {
  const collection = payload as GeoJsonCollection | null;
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new UpstreamError(`NHC ${layer} layer is not a FeatureCollection`, 'mapservices.weather.noaa.gov', null);
  }
  const suffix = { points: 'pts', track: 'lin', cone: 'pgn' }[layer];
  const parsed: ParsedGisFeature[] = [];
  for (const raw of collection.features.slice(0, GIS_LAYERS[layer].maxFeatures) as GeoJsonFeature[]) {
    const props = raw?.properties ?? {};
    const source =
      typeof props.idp_source === 'string'
        ? /^((?:al|ep|cp)\d{6})-(\d{1,3}[a-z]?)_5day_(pts|lin|pgn)$/i.exec(props.idp_source)
        : null;
    if (!source || source[3].toLowerCase() !== suffix || !raw.geometry) continue;
    const advisoryNumber = normaliseAdvisory(source[2]);
    if (!advisoryNumber || typeof raw.geometry.type !== 'string') continue;
    parsed.push({
      stormId: source[1].toLowerCase(),
      advisoryNumber,
      tauHours: boundedOrNull(props.tau, 0, 168),
      geometry: { type: raw.geometry.type, coordinates: raw.geometry.coordinates },
    });
  }
  return parsed;
}

/**
 * Builds the forecast track and cone for one storm from the three parsed layers, or nulls when
 * the geometry belongs to a different advisory. Forecast point times are the storm's position
 * time plus the forecast hour (tau), which is what NHC's tau is measured from.
 */
export function buildStormGeometry(
  storm: StormStatus,
  points: ParsedGisFeature[],
  lines: ParsedGisFeature[],
  cones: ParsedGisFeature[],
): StormGeometry {
  const matches = (f: ParsedGisFeature) =>
    f.stormId === storm.id && storm.advisoryNumber !== null && f.advisoryNumber === storm.advisoryNumber;

  const base = Date.parse(storm.positionAt);
  const track = points
    .filter(matches)
    .filter((f) => f.geometry.type === 'Point')
    .map((f) => ({ tau: f.tauHours, position: lonLat(f.geometry.coordinates) }))
    .filter((p): p is { tau: number | null; position: [number, number] } => p.position !== null)
    .sort((a, b) => (a.tau ?? 0) - (b.tau ?? 0))
    .map(({ tau, position }) => ({
      latitude: position[1],
      longitude: position[0],
      at: tau !== null && Number.isFinite(base) ? new Date(base + tau * HOUR_MS).toISOString() : null,
    }));

  const lineTrack = track.length > 0 ? track : trackFromLine(lines.find(matches));
  const coneFeature = cones.find(matches);

  return {
    track: lineTrack.length > 0 ? lineTrack : null,
    cone: coneFeature ? polygonRings(coneFeature.geometry) : null,
  };
}

function trackFromLine(feature: ParsedGisFeature | undefined): TrackPoint[] {
  if (!feature) return [];
  const parts =
    feature.geometry.type === 'LineString'
      ? [feature.geometry.coordinates]
      : feature.geometry.type === 'MultiLineString' && Array.isArray(feature.geometry.coordinates)
        ? feature.geometry.coordinates
        : [];
  const points: TrackPoint[] = [];
  for (const part of parts as unknown[]) {
    if (!Array.isArray(part)) continue;
    for (const coordinate of part.slice(0, 2000)) {
      const position = lonLat(coordinate);
      if (position) points.push({ latitude: position[1], longitude: position[0], at: null });
    }
  }
  return points;
}

/** Polygon and MultiPolygon both flatten to a list of rings; the map draws each ring. */
function polygonRings(geometry: { type: string; coordinates: unknown }): LonLatRing[] | null {
  const polygons =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)
        ? geometry.coordinates
        : [];
  const rings: LonLatRing[] = [];
  for (const polygon of (polygons as unknown[]).slice(0, 64)) {
    if (!Array.isArray(polygon)) continue;
    for (const ring of polygon.slice(0, 64)) {
      if (!Array.isArray(ring)) continue;
      const points = ring
        .slice(0, 10_000)
        .map(lonLat)
        .filter((p): p is [number, number] => p !== null)
        .map(([lon, lat]) => [round(lon, 4), round(lat, 4)] as [number, number]);
      if (points.length >= 4) rings.push(points);
    }
  }
  return rings.length > 0 ? rings : null;
}

function lonLat(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const [lon, lat] = value;
  if (typeof lon !== 'number' || typeof lat !== 'number') return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
    return null;
  }
  return [lon, lat];
}

/* ------------------------------------------------------------------- hazard */

/**
 * Saffir–Simpson bands mapped onto the shared 0..1 score. A tropical depression is worth
 * watching (LOW), a tropical storm disrupts ports and roads (MEDIUM), a hurricane closes them
 * (HIGH), a major hurricane (Cat 3+, ≥ 96 kt) destroys things (CRITICAL).
 */
export function cycloneSeverityScore(windKt: number | null): number {
  if (windKt === null) return 0.3;
  if (windKt >= 137) return 1;
  if (windKt >= 96) return clamp01(0.85 + ((windKt - 96) / 41) * 0.14);
  if (windKt >= 64) return clamp01(0.6 + ((windKt - 64) / 32) * 0.24);
  if (windKt >= 34) return clamp01(0.35 + ((windKt - 34) / 30) * 0.24);
  return 0.2;
}

/**
 * Rough radius of damaging wind, km. Real wind radii are asymmetric and published per quadrant
 * in the advisory text; this single number is only a footprint for exposure matching, and the
 * cone and forecast track carry the real spatial uncertainty.
 */
export function cycloneRadiusKm(windKt: number | null): number {
  if (windKt === null || windKt < 34) return 100;
  if (windKt < 64) return 200;
  if (windKt < 96) return 250;
  return 300;
}

export function stormToHazard(storm: StormStatus, geometry: StormGeometry): Hazard {
  const score = round(cycloneSeverityScore(storm.windKt), 2);
  const classification = classificationLabels(storm.classification);
  return {
    id: `nhc:${storm.id}`,
    kind: 'CYCLONE',
    title: `${classification.label} ${storm.name}`,
    severity: levelFromScore(score),
    severityScore: score,
    latitude: storm.latitude,
    longitude: storm.longitude,
    radiusKm: cycloneRadiusKm(storm.windKt),
    observedAt: storm.positionAt,
    source: 'NOAA National Hurricane Center',
    url: storm.advisoryUrl ?? 'https://www.nhc.noaa.gov/',
    details: {
      classification: storm.classification,
      basin: storm.basin,
      advisoryNumber: storm.advisoryNumber,
      windKt: storm.windKt,
      windKmh: storm.windKt === null ? null : Math.round(storm.windKt * KNOT_KMH),
      pressureHpa: storm.pressureHpa,
      movementDirDeg: storm.movementDirDeg,
      movementSpeedKt: storm.movementSpeedKt,
      geometry: geometry.track || geometry.cone ? 'current' : 'unavailable',
      // What a reporter writes, in English, as for GDACS `place`: the news search (the web's and
      // `placeQueryFromHazard`) runs on it, since GDELT is queried in English, not with the French title.
      place: `${classification.english} ${storm.name}`,
    },
    track: geometry.track,
    cone: geometry.cone,
  };
}

/** The French label shown in the title, and NHC's own English wording for the news search. */
const CLASSIFICATIONS: Record<string, { label: string; english: string }> = {
  TD: { label: 'Dépression tropicale', english: 'Tropical Depression' },
  TS: { label: 'Tempête tropicale', english: 'Tropical Storm' },
  HU: { label: 'Ouragan', english: 'Hurricane' },
  STD: { label: 'Dépression subtropicale', english: 'Subtropical Depression' },
  STS: { label: 'Tempête subtropicale', english: 'Subtropical Storm' },
  PTC: { label: 'Cyclone tropical potentiel', english: 'Potential Tropical Cyclone' },
  PC: { label: 'Cyclone post-tropical', english: 'Post-tropical Cyclone' },
};

function classificationLabels(code: string): { label: string; english: string } {
  return CLASSIFICATIONS[code.toUpperCase()] ?? { label: 'Cyclone tropical', english: 'Tropical Cyclone' };
}

/* -------------------------------------------------------------------- fetch */

/**
 * Loads storms and, when there are any, their geometry. A geometry failure downgrades to
 * position-only storms instead of failing: the position is the part that matters most.
 */
export async function fetchNhcHazards(): Promise<Hazard[]> {
  const storms = parseCurrentStorms(await fetchJsonCapped(NHC_STATUS_URL, { maxBytes: 256 * 1024 }));
  if (storms.length === 0) return [];

  let layers: Record<GisLayer, ParsedGisFeature[]> = { points: [], track: [], cone: [] };
  try {
    const [points, track, cone] = await Promise.all(
      (['points', 'track', 'cone'] as const).map(async (layer) =>
        parseGisLayer(await fetchJsonCapped(gisQueryUrl(layer), { maxBytes: GIS_LAYERS[layer].maxBytes }), layer),
      ),
    );
    layers = { points, track, cone };
  } catch {
    // Positions without geometry; each hazard reports `geometry: unavailable`.
  }

  return storms.map((storm) =>
    stormToHazard(storm, buildStormGeometry(storm, layers.points, layers.track, layers.cone)),
  );
}

function gisQueryUrl(layer: GisLayer): string {
  const spec = GIS_LAYERS[layer];
  const params = new URLSearchParams({
    where: '1=1',
    outFields: layer === 'points' ? 'idp_source,advisnum,tau,maxwind,gust' : 'idp_source,advisnum',
    outSR: '4326',
    resultRecordCount: String(spec.maxFeatures),
    geometryPrecision: '4',
    f: 'geojson',
  });
  return `${NHC_GIS_URL}/${spec.id}/query?${params.toString()}`;
}
