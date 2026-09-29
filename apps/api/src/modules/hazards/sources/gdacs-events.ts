import { UpstreamError, openUpstream, readBodyCapped } from '../../../common/http';
import {
  cleanText,
  equalAreaRadiusKm,
  fireAreaRadiusKm,
  levelFromScore,
  parseUtcIso,
  round,
  scoreInBand,
  toFiniteOrNull,
} from '../hazard-severity';
import type { Hazard, HazardDetailValue, HazardKind, SeverityLevel } from '../hazard.types';

/**
 * GDACS, the Global Disaster Alert and Coordination System (European Commission JRC and UN OCHA).
 *
 * One keyless API for floods (GloFAS), droughts (the EC Global Drought Observatory), volcanic
 * eruptions (the volcanic ash advisory centres), forest fires (GWIS) and tropical cyclones in
 * every basin. Each event carries a Green / Orange / Red alert that GDACS computes from the
 * physical hazard *and* the population exposed to it — closer to "will this disrupt anything"
 * than a raw magnitude.
 *
 * The search endpoint returns history as well as live events: at most 100 per page, ordered by
 * `todate` (the latest episode), and a bare 204 when nothing matches. So each group of types is
 * asked for a recent window only, pages are read until one comes back short, and whether an event
 * is still live is decided here, per type (`liveGdacsEvents`).
 *
 * GDACS earthquakes are never requested: USGS is the better source for those, and one quake drawn
 * twice would be worse than either feed alone. Cyclones inside NHC's basins and forest fires are
 * filtered or merged later, where the other feeds are known (`hazard-merge.ts`).
 */

export const GDACS_SEARCH_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';
export const GDACS_ATTRIBUTION = 'GDACS — European Commission JRC / UN OCHA';
const GDACS_HOST = 'www.gdacs.org';

/** GDACS never returns more than this per page, whatever `pageSize` asks for. */
export const GDACS_PAGE_SIZE = 100;
/** A full page is about 140 KB. */
const PAGE_MAX_BYTES = 1024 * 1024;
const PAGE_TIMEOUT_MS = 20_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const GDACS_TYPES = ['TC', 'FL', 'VO', 'DR', 'WF'] as const;
export type GdacsType = (typeof GDACS_TYPES)[number];
export type GdacsAlert = 'Green' | 'Orange' | 'Red';

const KIND: Record<GdacsType, HazardKind> = {
  TC: 'CYCLONE',
  FL: 'FLOOD',
  VO: 'VOLCANO',
  DR: 'DROUGHT',
  WF: 'FIRE',
};

const TYPE_LABEL: Record<GdacsType, string> = {
  TC: 'Tropical cyclone',
  FL: 'Flood',
  VO: 'Volcanic eruption',
  DR: 'Drought',
  WF: 'Forest fire',
};

export interface GdacsQuery {
  /** Cache key, and what the status note names when this part fails. */
  key: string;
  label: string;
  types: GdacsType[];
  /** Events whose latest episode falls in the last `windowDays` days. */
  windowDays: number;
  maxPages: number;
}

/**
 * Three queries rather than one, because their windows differ and a single mixed list would let
 * a busy fire season push floods onto a later page.
 */
export const GDACS_QUERIES: Record<'events' | 'droughts' | 'fires', GdacsQuery> = {
  /** Cyclones, floods and eruptions are updated daily or faster: ten days reaches every live one. */
  events: {
    key: 'TC;FL;VO',
    label: 'cyclones, floods and eruptions',
    types: ['TC', 'FL', 'VO'],
    windowDays: 10,
    maxPages: 3,
  },
  /** Droughts are re-assessed about every ten days, so their window is longer. */
  droughts: { key: 'DR', label: 'droughts', types: ['DR'], windowDays: 45, maxPages: 2 },
  /** Forest fires, only asked for while no FIRMS key is configured. */
  fires: { key: 'WF', label: 'forest fires', types: ['WF'], windowDays: 3, maxPages: 3 },
};

/** How long after its latest episode a GDACS-flagged current event still counts as live. */
const LIVE_FOR_MS: Record<Exclude<GdacsType, 'DR'>, number> = {
  // Advisories come every six hours; two quiet days mean the storm has dissipated.
  TC: 2 * DAY_MS,
  // GloFAS re-forecasts floods daily.
  FL: 7 * DAY_MS,
  // An eruption is a report, not a series; GDACS stops calling it current within days.
  VO: 14 * DAY_MS,
  // GWIS updates a burned area daily while the fire grows.
  WF: 3 * DAY_MS,
};

/**
 * Droughts: GDACS leaves `iscurrent` false on most live droughts, while its own map shows every
 * drought of the latest assessment. So a drought is live when it belongs to that latest batch
 * (within five days of the newest drought update) and is at most 45 days old.
 */
const DROUGHT_BATCH_MS = 5 * DAY_MS;
const DROUGHT_MAX_AGE_MS = 45 * DAY_MS;

export interface GdacsEvent {
  type: GdacsType;
  eventId: number;
  episodeId: number | null;
  name: string;
  /** GDACS's short name: `SURIGAE-26`, `Etna`, `Europe-2026`. Often empty for floods and fires. */
  eventName: string | null;
  /** The event's overall alert: its worst episode so far. */
  alertLevel: GdacsAlert;
  alertScore: number | null;
  /** The latest episode's alert: what is happening now. */
  episodeAlertLevel: GdacsAlert | null;
  /** 0–3 with resolution: Green 0–1, Orange 1–2, Red 2–3. */
  episodeAlertScore: number | null;
  current: boolean;
  countries: string[];
  fromDate: string;
  toDate: string;
  latitude: number;
  longitude: number;
  severity: number | null;
  severityUnit: string | null;
  severityText: string | null;
  /** Who GDACS got the event from: GLOFAS, GDO, GWIS, NOAA, JTWC, a VAAC… */
  upstream: string | null;
  reportUrl: string;
}

/* ------------------------------------------------------------------ parsing */

/**
 * Parses one search page. A malformed feature is dropped, not fatal; an answer that is not a
 * feature collection is, so it is served stale instead of wiping the map.
 */
export function parseGdacsEvents(payload: unknown): GdacsEvent[] {
  return mergeEpisodes(featuresOf(payload).map(parseFeature).filter((e): e is GdacsEvent => e !== null));
}

function featuresOf(payload: unknown): unknown[] {
  const features = (payload as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) {
    throw new UpstreamError('GDACS answer has no features list', GDACS_HOST, null);
  }
  return features.slice(0, GDACS_PAGE_SIZE * 2);
}

/** One entry per event; if an event appears twice (two episodes), the latest episode wins. */
function mergeEpisodes(events: GdacsEvent[]): GdacsEvent[] {
  const byKey = new Map<string, GdacsEvent>();
  for (const event of events) {
    const key = `${event.type}:${event.eventId}`;
    const existing = byKey.get(key);
    if (!existing || Date.parse(event.toDate) > Date.parse(existing.toDate)) byKey.set(key, event);
  }
  return [...byKey.values()];
}

function parseFeature(raw: unknown): GdacsEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const feature = raw as {
    geometry?: { type?: unknown; coordinates?: unknown } | null;
    properties?: Record<string, unknown> | null;
  };
  const props = feature.properties;
  const geometry = feature.geometry;
  if (!props || !geometry || geometry.type !== 'Point' || !Array.isArray(geometry.coordinates)) return null;

  const type = typeof props.eventtype === 'string' ? props.eventtype.trim().toUpperCase() : '';
  if (!isGdacsType(type)) return null;

  const [longitude, latitude] = geometry.coordinates.map(toFiniteOrNull);
  if (latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  const eventId = toFiniteOrNull(props.eventid);
  const alertLevel = parseAlert(props.alertlevel);
  const toDate = parseUtcIso(props.todate);
  if (eventId === null || !Number.isInteger(eventId) || eventId <= 0 || !alertLevel || !toDate) return null;

  const episode = toFiniteOrNull(props.episodeid);
  const episodeId = episode !== null && Number.isInteger(episode) && episode > 0 ? episode : null;
  const severity = (
    props.severitydata && typeof props.severitydata === 'object' ? props.severitydata : {}
  ) as Record<string, unknown>;

  return {
    type,
    eventId,
    episodeId,
    name: cleanText(props.name, 160) ?? cleanText(props.description, 160) ?? `${TYPE_LABEL[type]} ${eventId}`,
    eventName: cleanText(props.eventname, 80),
    alertLevel,
    alertScore: toFiniteOrNull(props.alertscore),
    episodeAlertLevel: parseAlert(props.episodealertlevel),
    episodeAlertScore: toFiniteOrNull(props.episodealertscore),
    current: props.iscurrent === true || props.iscurrent === 'true',
    countries: parseCountries(props.affectedcountries, props.country),
    fromDate: parseUtcIso(props.fromdate) ?? toDate,
    toDate,
    latitude,
    longitude,
    severity: toFiniteOrNull(severity.severity),
    severityUnit: cleanText(severity.severityunit, 16),
    severityText: cleanText(severity.severitytext, 160),
    upstream: cleanText(props.source, 40),
    reportUrl: officialReportLink(props.url) ?? canonicalReportUrl(type, eventId, episodeId),
  };
}

function isGdacsType(value: string): value is GdacsType {
  return (GDACS_TYPES as readonly string[]).includes(value);
}

function parseAlert(value: unknown): GdacsAlert | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  return text === 'green' ? 'Green' : text === 'orange' ? 'Orange' : text === 'red' ? 'Red' : null;
}

/** `affectedcountries` when it names any, else the comma-separated `country` text. */
function parseCountries(affected: unknown, country: unknown): string[] {
  const clean = (names: unknown[]): string[] => {
    const cleaned = names.map((name) => cleanText(name, 60)).filter((name): name is string => Boolean(name));
    return [...new Set(cleaned)].slice(0, 30);
  };
  const nameOf = (entry: unknown): unknown =>
    entry && typeof entry === 'object' ? (entry as Record<string, unknown>).countryname : null;
  const listed = Array.isArray(affected) ? clean(affected.map(nameOf)) : [];
  return listed.length > 0 ? listed : clean(typeof country === 'string' ? country.split(',') : []);
}

/** Only links to GDACS's own report pages are passed on; anything else in the feed is dropped. */
function officialReportLink(value: unknown): string | null {
  const report = value && typeof value === 'object' ? (value as Record<string, unknown>).report : null;
  if (typeof report !== 'string' || report.length > 512) return null;
  try {
    const url = new URL(report);
    const official = url.protocol === 'https:' && (url.hostname === 'www.gdacs.org' || url.hostname === 'gdacs.org');
    return official && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function canonicalReportUrl(type: GdacsType, eventId: number, episodeId: number | null): string {
  const params = new URLSearchParams({ eventid: String(eventId), eventtype: type });
  if (episodeId !== null) params.set('episodeid', String(episodeId));
  return `https://www.gdacs.org/report.aspx?${params.toString()}`;
}

/* ----------------------------------------------------------------- liveness */

/** The events that are still happening; see LIVE_FOR_MS and the drought rule above. */
export function liveGdacsEvents(events: GdacsEvent[], nowMs: number): GdacsEvent[] {
  const droughtUpdates = events.filter((e) => e.type === 'DR').map((e) => Date.parse(e.toDate));
  const latestDrought = droughtUpdates.length > 0 ? Math.max(...droughtUpdates) : Number.NEGATIVE_INFINITY;

  return events.filter((event) => {
    const updatedMs = Date.parse(event.toDate);
    const age = nowMs - updatedMs;
    if (event.type === 'DR') {
      return age <= DROUGHT_MAX_AGE_MS && (event.current || updatedMs >= latestDrought - DROUGHT_BATCH_MS);
    }
    return event.current && age <= LIVE_FOR_MS[event.type];
  });
}

/* ----------------------------------------------------------------- severity */

const ALERT_RANK: Record<GdacsAlert, number> = { Green: 0, Orange: 1, Red: 2 };

/**
 * GDACS's alert onto the shared scale. The latest episode's alert is what is happening now, so it
 * sets the level — Red → CRITICAL, Orange → HIGH, Green → LOW, the colours USGS PAGER uses too —
 * except that a Green episode of an event that peaked Orange or Red is MEDIUM: receding, not over.
 *
 * The event's `alertscore` only restates its colour (1, 2, 3). The episode's alert score has
 * resolution (Green 0–1, Orange 1–2, Red 2–3), so it places the score inside the level's band.
 */
export function gdacsAlertSeverity(
  event: Pick<GdacsEvent, 'alertLevel' | 'episodeAlertLevel' | 'episodeAlertScore'>,
): { level: SeverityLevel; score: number } {
  const now = event.episodeAlertLevel ?? event.alertLevel;
  const level: SeverityLevel =
    now === 'Red'
      ? 'CRITICAL'
      : now === 'Orange'
        ? 'HIGH'
        : ALERT_RANK[event.alertLevel] > ALERT_RANK.Green
          ? 'MEDIUM'
          : 'LOW';
  return { level, score: scoreInBand(level, alertPosition(event)) };
}

/** Where the episode's alert score sits inside its colour's range (Green 0–1, Orange 1–2, Red 2–3). */
function alertPosition(event: Pick<GdacsEvent, 'alertLevel' | 'episodeAlertLevel' | 'episodeAlertScore'>): number {
  const now = event.episodeAlertLevel ?? event.alertLevel;
  return event.episodeAlertScore === null ? 0.5 : event.episodeAlertScore - ALERT_RANK[now];
}

/**
 * Droughts sit one level lower: GDACS's own words for its drought alerts are minor, medium and
 * high impact, and a slow-onset drought is never the "destroys things now" of a CRITICAL level.
 */
const DROUGHT_LEVEL: Record<SeverityLevel, SeverityLevel> = {
  CRITICAL: 'HIGH',
  HIGH: 'MEDIUM',
  MEDIUM: 'LOW',
  LOW: 'LOW',
};

type StormClass = 'TD' | 'TS' | 'HU';

/**
 * The storm's class *now*, from GDACS's severity text: "Tropical Storm (maximum wind speed of
 * 241 km/h)". The wind figure in that text is the event's peak, not its current wind, so it is
 * shown but never scored; the class before the bracket is current.
 */
export function stormClass(severityText: string | null): StormClass | null {
  const head = (severityText ?? '').split('(')[0];
  if (/hurricane|typhoon/i.test(head)) return 'HU';
  if (/tropical storm/i.test(head)) return 'TS';
  if (/tropical depression/i.test(head)) return 'TD';
  return null;
}

/** Floors matching NHC's Saffir–Simpson bands, so a typhoon ranks like a hurricane. */
const STORM_CLASS_SCORE: Record<StormClass, number> = { TD: 0.2, TS: 0.45, HU: 0.7 };
const STORM_CLASS_LABEL: Record<StormClass, string> = {
  TD: 'Tropical depression',
  TS: 'Tropical storm',
  HU: 'Hurricane / typhoon',
};

/**
 * Level and score of a GDACS event: the alert (above); for a drought one level lower; for a
 * cyclone never below what its current class would get from NHC — GDACS may call a typhoon over a
 * sparsely populated coast Green, but a typhoon still closes ports.
 */
export function gdacsSeverity(event: GdacsEvent): { level: SeverityLevel; score: number } {
  const alert = gdacsAlertSeverity(event);
  if (event.type === 'DR') {
    const level = DROUGHT_LEVEL[alert.level];
    return { level, score: scoreInBand(level, alertPosition(event)) };
  }
  if (event.type !== 'TC') return alert;
  const storm = stormClass(event.severityText);
  const score = Math.max(alert.score, storm ? STORM_CLASS_SCORE[storm] : 0);
  return { level: levelFromScore(score), score };
}

/* ---------------------------------------------------------------- footprint */

type Measured = Pick<GdacsEvent, 'type' | 'severity' | 'severityUnit'>;

/** GDACS's severity figure when it is of this type and in this unit, else null. */
function measure(event: Measured, type: GdacsType, unit: RegExp): number | null {
  const value = event.severity;
  return event.type === type && value !== null && value > 0 && unit.test(event.severityUnit ?? '') ? value : null;
}

/** Burned area in hectares, when GDACS gives one (forest fires). */
export function burnedAreaHa(event: Measured): number | null {
  return measure(event, 'WF', /^ha$/i);
}

/** Drought extent in km², when GDACS gives one. */
function droughtAreaKm2(event: Measured): number | null {
  return measure(event, 'DR', /^km2$/i);
}

const FLOOD_RADIUS_KM: Record<SeverityLevel, number> = { LOW: 50, MEDIUM: 75, HIGH: 100, CRITICAL: 150 };
const VOLCANO_RADIUS_KM: Record<SeverityLevel, number> = { LOW: 25, MEDIUM: 50, HIGH: 100, CRITICAL: 150 };
const STORM_RADIUS_KM: Record<StormClass, number> = { TD: 100, TS: 200, HU: 250 };

/**
 * Area of concern around the event's point, km. A heuristic per kind, documented in
 * docs/intel/hazards.md: GDACS gives a point (the centroid) and, for fires and droughts, an area.
 *
 *   - flood: by level, 50 / 75 / 100 / 150 km — a GloFAS event is a river reach, not a basin;
 *   - eruption: by level, 25 / 50 / 100 / 150 km — flows near, ash far;
 *   - drought: the radius of a disc of the reported area, kept within 100–500 km;
 *   - forest fire: the burned area's disc radius + 5 km, within 10–50 km;
 *   - cyclone: by current class, 100 / 200 / 250 km as for NHC storms, 300 km on a Red alert.
 */
export function gdacsRadiusKm(event: GdacsEvent, level: SeverityLevel): number {
  switch (event.type) {
    case 'FL':
      return FLOOD_RADIUS_KM[level];
    case 'VO':
      return VOLCANO_RADIUS_KM[level];
    case 'DR': {
      const area = droughtAreaKm2(event);
      return area === null ? 250 : Math.min(500, Math.max(100, Math.round(equalAreaRadiusKm(area))));
    }
    case 'WF':
      return fireAreaRadiusKm(burnedAreaHa(event));
    case 'TC': {
      if (event.alertLevel === 'Red') return 300;
      const storm = stormClass(event.severityText);
      return storm ? STORM_RADIUS_KM[storm] : 200;
    }
  }
}

/* ------------------------------------------------------------------- hazard */

export function gdacsEventToHazard(event: GdacsEvent): Hazard {
  const { level, score } = gdacsSeverity(event);
  return {
    id: `gdacs:${event.type}:${event.eventId}`,
    kind: KIND[event.type],
    title: gdacsTitle(event),
    severity: level,
    severityScore: score,
    latitude: round(event.latitude, 4),
    longitude: round(event.longitude, 4),
    radiusKm: gdacsRadiusKm(event, level),
    observedAt: event.toDate,
    source: 'GDACS',
    url: event.reportUrl,
    details: gdacsDetails(event),
    track: null,
    cone: null,
  };
}

/** GDACS's own names, which read well ("Flood in Guinea"), made distinct where they repeat. */
function gdacsTitle(event: GdacsEvent): string {
  if (event.type === 'DR' && event.eventName) return `Drought — ${event.eventName}`;
  const area = burnedAreaHa(event);
  // Dozens of fires are all "Forest fires in Australia"; the burned area tells them apart.
  if (area !== null) return `${event.name} — ${Math.round(area).toLocaleString('en-US')} ha`;
  return event.name;
}

/**
 * Facts for the detail panel, most telling first (it shows eight). `place` is the name a reporter
 * would write — the volcano, or the country when there is one — and is what the news search uses.
 */
function gdacsDetails(event: GdacsEvent): Record<string, HazardDetailValue> {
  const details: Record<string, HazardDetailValue> = {
    alertLevel: event.alertLevel,
    currentAlertLevel: event.episodeAlertLevel,
  };
  switch (event.type) {
    case 'TC': {
      const storm = stormClass(event.severityText);
      const windKmh = /^km\/h$/i.test(event.severityUnit ?? '') ? event.severity : null;
      details.classification = storm ? STORM_CLASS_LABEL[storm] : null;
      details.peakWindKmh = windKmh === null ? null : Math.round(windKmh);
      details.stormName = event.eventName;
      break;
    }
    case 'DR': {
      const area = droughtAreaKm2(event);
      details.region = event.eventName;
      details.areaKm2 = area === null ? null : Math.round(area);
      break;
    }
    case 'WF': {
      const area = burnedAreaHa(event);
      details.burnedAreaHa = area === null ? null : Math.round(area);
      break;
    }
    case 'VO':
      details.volcano = event.eventName;
      break;
    case 'FL':
      break;
  }
  const singleCountry = event.countries.length === 1 ? event.countries[0] : null;
  details.place =
    event.type === 'VO' && event.eventName
      ? event.eventName
      : event.type === 'DR'
        ? singleCountry
        : (event.countries[0] ?? null);
  if (event.countries.length > 1) details.countries = cleanText(event.countries.join(', '), 200);
  details.since = event.fromDate;
  details.upstream = event.upstream;
  details.gdacsEventId = event.eventId;
  return details;
}

/* -------------------------------------------------------------------- fetch */

export function gdacsSearchUrl(types: GdacsType[], fromMs: number, toMs: number, page: number): string {
  const params = new URLSearchParams({
    eventlist: types.join(';'),
    // Without it GDACS returns Orange and Red only; a Green flood next to a warehouse still matters.
    alertlevel: 'Green;Orange;Red',
    fromDate: isoDay(fromMs),
    toDate: isoDay(toMs),
    pageSize: String(GDACS_PAGE_SIZE),
    pageNumber: String(page),
  });
  return `${GDACS_SEARCH_URL}?${params.toString()}`;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Reads a query's pages one after another until a page comes back short. Pages are sequential by
 * nature (only a full page says there is another) and the page cap bounds a runaway season.
 */
export async function fetchGdacsEvents(query: GdacsQuery, nowMs = Date.now()): Promise<GdacsEvent[]> {
  const events: GdacsEvent[] = [];
  for (let page = 1; page <= query.maxPages; page += 1) {
    // `toDate` is tomorrow so that today's episodes, stamped later today, are always inside.
    const url = gdacsSearchUrl(query.types, nowMs - query.windowDays * DAY_MS, nowMs + DAY_MS, page);
    const { events: batch, full } = await fetchGdacsPage(url);
    events.push(...batch);
    if (!full) break;
  }
  return mergeEpisodes(events);
}

async function fetchGdacsPage(url: string): Promise<{ events: GdacsEvent[]; full: boolean }> {
  const response = await openUpstream(url, { timeoutMs: PAGE_TIMEOUT_MS, headers: { Accept: 'application/json' } });
  // "Nothing matches" (or a page past the end) is a 204 with no body, not an empty collection.
  if (response.status === 204) {
    await response.body?.cancel().catch(() => undefined);
    return { events: [], full: false };
  }
  const text = (await readBodyCapped(response, PAGE_MAX_BYTES, GDACS_HOST)).toString('utf8');
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new UpstreamError('GDACS returned a body that is not JSON', GDACS_HOST, response.status);
  }
  return { events: parseGdacsEvents(payload), full: featuresOf(payload).length >= GDACS_PAGE_SIZE };
}
