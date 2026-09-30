/**
 * Radio Browser directory: pure parsing and admission rules.
 *
 * Radio Browser (radio-browser.info) is a community-maintained, public-domain directory of
 * internet radio streams. Anyone can add a station, so every field is untrusted: names may carry
 * control characters, "stream" URLs may point at a LAN address, and a station tagged "news" may
 * play music. The rules below decide what reaches a driver's screen:
 *
 *   - only HTTPS streams on public hostnames: the browser plays the stream directly, and a
 *     plain-HTTP stream inside our HTTPS app is blocked as mixed content anyway, while a private
 *     address would turn the directory into a way to make browsers probe internal networks;
 *   - no HLS, and only MP3/AAC: those are the codecs an <audio> element plays everywhere
 *     without a JavaScript demuxer;
 *   - only stations whose last health check passed and that carry a real position, because the
 *     whole point is "stations near this truck".
 *
 * Adapted from God's Eye View (MIT), `src/sources/radioBrowser.js` and
 * `server/providers/radio/transport.js`.
 */

import { haversineKm, isValidLatLon, type LatLon } from '../../common/http';

export const RADIO_ATTRIBUTION = 'Radio Browser (radio-browser.info), annuaire du domaine public';

export const RADIO_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Used when mirror discovery itself fails; these three have been stable for years. */
export const RADIO_FALLBACK_MIRRORS: readonly string[] = [
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
];

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

/** A station before distance is known: the cache stores these, distance depends on the caller. */
export type DirectoryStation = Omit<RadioStation, 'distanceKm'>;

/** Strips control characters and collapses whitespace; directory text is user-submitted. */
export function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

export function isRadioUuid(value: unknown): value is string {
  return typeof value === 'string' && RADIO_UUID_RE.test(value);
}

/** True for IPv4 literals in loopback, private, link-local, CGNAT, multicast or documentation space. */
export function isNonGlobalIpv4(hostname: string): boolean {
  const pieces = hostname.split('.');
  if (pieces.length !== 4 || pieces.some((piece) => !/^\d{1,3}$/.test(piece))) return false;
  const [a, b, c] = pieces.map(Number);
  if ([a, b, c, Number(pieces[3])].some((value) => value > 255)) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** A normalised public HTTPS URL, or null for anything local, private, credentialed or not HTTPS. */
export function publicHttpsUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value ?? ''));
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || !hostname) return null;
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      isNonGlobalIpv4(hostname) ||
      // IPv6 literals: rare for radio, and too many private ranges to vet here.
      hostname.includes(':')
    ) {
      return null;
    }
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Accepts only `<name>.api.radio-browser.info` so a poisoned server list cannot redirect our
 * outbound requests somewhere else.
 */
export function mirrorOrigin(hostname: unknown): string | null {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9-]+\.api\.radio-browser\.info$/.test(host)) return null;
  if (host === 'all.api.radio-browser.info') return null; // the round-robin alias, not a mirror
  return `https://${host}`;
}

/** Mirror list from `/json/servers`, de-duplicated, invalid names dropped. */
export function parseMirrorList(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  const origins = rows
    .map((row) => mirrorOrigin((row as { name?: unknown } | null)?.name))
    .filter((origin): origin is string => origin !== null);
  return [...new Set(origins)];
}

const PLAYABLE_CODEC = /^(?:MP3|AAC(?:\+|-LC|-HE)?|HE-AAC)$/i;

/** One raw directory row to a station we are willing to show, or null. */
export function normalizeStation(raw: Record<string, unknown>): DirectoryStation | null {
  const id = cleanText(raw.stationuuid, 40).toLowerCase();
  const latitude = raw.geo_lat === null || raw.geo_lat === '' ? NaN : Number(raw.geo_lat);
  const longitude = raw.geo_long === null || raw.geo_long === '' ? NaN : Number(raw.geo_long);
  const codec = cleanText(raw.codec, 16).toUpperCase();
  const streamUrl = publicHttpsUrl(raw.url_resolved || raw.url);
  const name = cleanText(raw.name, 140);

  if (
    !isRadioUuid(id) ||
    !name ||
    Number(raw.lastcheckok) !== 1 ||
    Number(raw.hls) === 1 ||
    !streamUrl ||
    // Some rows claim hls=0 while pointing at a playlist; the URL is the ground truth.
    /\.m3u8(?:$|\?)/i.test(streamUrl) ||
    !PLAYABLE_CODEC.test(codec) ||
    !isValidLatLon(latitude, longitude) ||
    // 0,0 is the directory's "unknown" filler, not a station in the Gulf of Guinea.
    (latitude === 0 && longitude === 0)
  ) {
    return null;
  }

  const tags = String(raw.tags ?? '')
    .split(',')
    .map((tag) => cleanText(tag, 80).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .slice(0, 24);
  const countryCode = cleanText(raw.countrycode, 2).toUpperCase();
  const bitrate = Number(raw.bitrate);

  return {
    id,
    name,
    streamUrl,
    homepage: publicHttpsUrl(raw.homepage),
    country: cleanText(raw.country, 80) || null,
    countryCode: /^[A-Z]{2}$/.test(countryCode) ? countryCode : null,
    state: cleanText(raw.state, 80) || null,
    language: cleanText(raw.language, 80) || null,
    tags,
    codec,
    bitrate: Number.isInteger(bitrate) && bitrate >= 8 && bitrate <= 1024 ? bitrate : null,
    latitude,
    longitude,
  };
}

export function normalizeStations(rows: unknown): DirectoryStation[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row))
    .map(normalizeStation)
    .filter((station): station is DirectoryStation => station !== null);
}

export interface SelectOptions {
  origin: LatLon;
  radiusKm: number;
  tag?: string | null;
  limit: number;
}

/** Distance from the caller, radius and tag filter, nearest first. */
export function selectNearbyStations(stations: DirectoryStation[], options: SelectOptions): RadioStation[] {
  const tag = options.tag?.trim().toLowerCase() || null;
  return stations
    .filter((station) => !tag || station.tags.some((candidate) => candidate.includes(tag)))
    .map((station) => ({ ...station, distanceKm: round1(haversineKm(options.origin, station)) }))
    .filter((station) => station.distanceKm <= options.radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name))
    .slice(0, options.limit);
}

export interface SearchParams {
  latitude: number;
  longitude: number;
  radiusKm: number;
  limit: number;
}

/** Path and query for a geo search; Radio Browser takes the radius in metres. */
export function buildSearchPath(params: SearchParams): string {
  const query = new URLSearchParams({
    has_geo_info: 'true',
    is_https: 'true',
    hidebroken: 'true',
    order: 'clickcount',
    reverse: 'true',
    limit: String(params.limit),
    geo_lat: params.latitude.toFixed(4),
    geo_long: params.longitude.toFixed(4),
    geo_distance: String(Math.round(params.radiusKm * 1000)),
  });
  return `/json/stations/search?${query.toString()}`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
