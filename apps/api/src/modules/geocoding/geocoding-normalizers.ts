/**
 * Pure pieces of the keyless geocoder: coordinate parsing, and turning Photon and Nominatim
 * answers into one result shape.
 *
 * Both services return OpenStreetMap data but in different envelopes — Photon GeoJSON with
 * [lon, lat] coordinates, Nominatim flat rows with string lat/lon — and both carry
 * community-edited text. Everything is validated and cleaned here so the service only deals in
 * results it can trust to be on the planet.
 *
 * Adapted from God's Eye View (MIT), `src/keylessGeocoder.js` and `src/sources/nominatim.js`.
 */

import { isValidLatLon } from '../../common/http';

export interface GeocodeResult {
  label: string;
  latitude: number;
  longitude: number;
  kind: string | null;
  country: string | null;
}

export interface ReverseResult {
  label: string | null;
  locality: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
}

export function cleanText(value: unknown, maxLength = 200): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

function textOrNull(value: unknown, maxLength = 120): string | null {
  return cleanText(value, maxLength) || null;
}

const NUMBER = String.raw`([+-]?\d{1,3}(?:\.\d+)?)`;
const HEMISPHERE_PAIR = new RegExp(
  String.raw`^${NUMBER}\s*°?\s*([NS])[\s,;]+${NUMBER}\s*°?\s*([EW])$`,
  'i',
);
const PLAIN_PAIR = new RegExp(String.raw`^${NUMBER}\s*°?\s*(?:[,;]\s*|\s+)${NUMBER}\s*°?$`);

/**
 * Recognises "5.6, -0.18", "5.6 -0.18", "5.6;-0.18" and "5.6N 0.18W" (latitude first, the
 * order people copy out of a phone). A dispatcher pasting a driver's coordinates should not wait
 * on a network round trip, nor have the numbers "corrected" to some street that happens to
 * match them as text.
 */
export function parseCoordinateQuery(query: string): { latitude: number; longitude: number } | null {
  const text = query.trim();
  const hemispheres = HEMISPHERE_PAIR.exec(text);
  if (hemispheres) {
    const [, lat, ns, lon, ew] = hemispheres;
    // A signed number plus a hemisphere letter is contradictory; refuse rather than guess.
    if (/^[+-]/.test(lat) || /^[+-]/.test(lon)) return null;
    const latitude = Number(lat) * (ns.toUpperCase() === 'S' ? -1 : 1);
    const longitude = Number(lon) * (ew.toUpperCase() === 'W' ? -1 : 1);
    return isValidLatLon(latitude, longitude) ? { latitude, longitude } : null;
  }
  const plain = PLAIN_PAIR.exec(text);
  if (!plain) return null;
  // "10 20" is more likely an address fragment than a position; real pasted coordinates have decimals.
  if (!plain[1].includes('.') && !plain[2].includes('.')) return null;
  const latitude = Number(plain[1]);
  const longitude = Number(plain[2]);
  return isValidLatLon(latitude, longitude) ? { latitude, longitude } : null;
}

export function coordinateResult(point: { latitude: number; longitude: number }): GeocodeResult {
  return {
    label: `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`,
    latitude: point.latitude,
    longitude: point.longitude,
    kind: 'coordinates',
    country: null,
  };
}

/** Photon feature properties to a one-line label: the name plus the places containing it. */
export function photonLabel(properties: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const field of ['name', 'street', 'district', 'city', 'state', 'country']) {
    const part = cleanText(properties[field], 120);
    if (part && !parts.includes(part)) parts.push(part);
  }
  return parts.join(', ');
}

/** Photon GeoJSON FeatureCollection to results; features without a usable point are dropped. */
export function normalizePhotonResponse(body: unknown): GeocodeResult[] {
  const features = (body as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) throw new Error('Photon response has no features array');

  const results: GeocodeResult[] = [];
  for (const feature of features as Array<Record<string, any>>) {
    const geometry = feature?.geometry;
    if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates)) continue;
    const [longitude, latitude] = geometry.coordinates.map(Number);
    if (!isValidLatLon(latitude, longitude)) continue;
    const properties: Record<string, unknown> = feature.properties ?? {};
    const label = photonLabel(properties);
    if (!label) continue;
    results.push({
      label,
      latitude,
      longitude,
      // osm_value is the specific kind ("port", "city", "fuel"); type is Photon's coarse class.
      kind: textOrNull(properties.osm_value ?? properties.type, 40),
      country: textOrNull(properties.country),
    });
  }
  return results;
}

/** Nominatim `jsonv2` search rows to results. */
export function normalizeNominatimSearch(body: unknown): GeocodeResult[] {
  if (!Array.isArray(body)) throw new Error('Nominatim search response is not a list');
  const results: GeocodeResult[] = [];
  for (const row of body as Array<Record<string, any>>) {
    const latitude = Number(row?.lat);
    const longitude = Number(row?.lon);
    const label = cleanText(row?.display_name, 300);
    if (!isValidLatLon(latitude, longitude) || !label) continue;
    results.push({
      label,
      latitude,
      longitude,
      kind: textOrNull(row.addresstype ?? row.type, 40),
      country: textOrNull(row.address?.country),
    });
  }
  return results;
}

/**
 * Nominatim `jsonv2` reverse answer to a place description. `null` means Nominatim answered but
 * found nothing (open sea, for example) — distinct from a failure, which throws upstream.
 */
export function normalizeNominatimReverse(body: unknown): ReverseResult | null {
  const row = body as Record<string, any> | null;
  if (!row || typeof row !== 'object') throw new Error('Nominatim reverse response is not an object');
  if (row.error) return null;
  const address: Record<string, unknown> = row.address ?? {};
  // Nominatim names the settlement by its size; the first present is the most specific.
  const locality =
    address.city ?? address.town ?? address.village ?? address.hamlet ?? address.suburb ?? address.municipality;
  const region = address.state ?? address.region ?? address.state_district ?? address.county;
  const countryCode = cleanText(address.country_code, 2).toUpperCase();
  return {
    label: textOrNull(row.display_name, 300),
    locality: textOrNull(locality),
    region: textOrNull(region),
    country: textOrNull(address.country),
    countryCode: /^[A-Z]{2}$/.test(countryCode) ? countryCode : null,
  };
}
