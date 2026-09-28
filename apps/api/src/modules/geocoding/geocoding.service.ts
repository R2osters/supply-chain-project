import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_USER_AGENT, RequestGate, TtlCache, fetchJsonCapped, type CappedFetchOptions } from '../../common/http';
import type { AppConfig } from '../../config/configuration';
import { runGeocodeCascade, type GeocodeFetchers, type GeocodeResponse } from './geocoding-cascade';
import {
  normalizeNominatimReverse,
  normalizeNominatimSearch,
  normalizePhotonResponse,
  type GeocodeResult,
  type ReverseResult,
} from './geocoding-normalizers';

/**
 * Keyless place search for dispatchers: Photon, then Nominatim, both OpenStreetMap-based.
 *
 * Nominatim's usage policy (operations.osmfoundation.org/policies/nominatim) is strict and
 * enforced by blocking: at most one request per second from the whole application, a
 * User-Agent and Referer that identify it, and results cached rather than re-requested. One
 * process-wide gate spaces every Nominatim call, forward and reverse alike, and the caches are
 * single-flight so twenty dispatchers typing the same depot name cost one request.
 */

export interface ReverseResponse extends ReverseResult {
  source: 'nominatim' | 'none';
}

const PHOTON_URL = 'https://photon.komoot.io/api/';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';

/** Shared by every instance: the 1 req/s limit is per application, not per service object. */
export const NOMINATIM_GATE = new RequestGate({ minIntervalMs: 1100, maxQueue: 10 });

/** Place names do not move; ten minutes covers a burst of repeated searches. */
const FORWARD_TTL_MS = 10 * 60_000;
/** Reverse answers are keyed by 0.01° (~1 km) cells, which change even less often. */
const REVERSE_TTL_MS = 30 * 60_000;
/** Photon is a courtesy service; a slow answer is worse than falling through to Nominatim. */
const PHOTON_TIMEOUT_MS = 6_000;
const REVERSE_CELL_DEGREES = 0.01;

@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly forwardCache = new TtlCache<GeocodeResponse>({ ttlMs: FORWARD_TTL_MS, maxEntries: 1000 });
  private readonly reverseCache = new TtlCache<ReverseResult | null>({ ttlMs: REVERSE_TTL_MS, maxEntries: 2000 });
  private readonly headers: Record<string, string>;
  private readonly fetchers: GeocodeFetchers;

  constructor(
    config?: ConfigService<AppConfig, true>,
    private readonly gate: RequestGate = NOMINATIM_GATE,
  ) {
    const origins = config?.get('corsOrigins', { infer: true }) ?? [];
    this.headers = {
      'User-Agent': `${DEFAULT_USER_AGENT} geocoding`,
      // Nominatim asks for a Referer naming the application that shows the results.
      ...(origins[0] ? { Referer: origins[0] } : {}),
    };
    this.fetchers = {
      photon: (query, limit) => this.searchPhoton(query, limit),
      nominatim: (query, limit) => this.searchNominatim(query, limit),
    };
  }

  async search(rawQuery: string, limit: number): Promise<GeocodeResponse> {
    const query = rawQuery.trim().replace(/\s+/g, ' ');
    const key = `${limit}:${query.toLowerCase()}`;
    try {
      const cached = await this.forwardCache.getOrLoad(key, () => runGeocodeCascade(query, limit, this.fetchers));
      return cached.value;
    } catch (error) {
      this.logger.warn(`Geocoding unavailable: ${(error as Error).message}`);
      return { source: 'none', results: [] };
    }
  }

  async reverse(latitude: number, longitude: number): Promise<ReverseResponse> {
    const cell = {
      latitude: snap(latitude, REVERSE_CELL_DEGREES),
      longitude: snap(longitude, REVERSE_CELL_DEGREES),
    };
    try {
      const cached = await this.reverseCache.getOrLoad(`${cell.latitude}:${cell.longitude}`, () =>
        this.reverseNominatim(cell.latitude, cell.longitude),
      );
      return cached.value ? { source: 'nominatim', ...cached.value } : { source: 'nominatim', ...EMPTY_REVERSE };
    } catch (error) {
      this.logger.warn(`Reverse geocoding unavailable: ${(error as Error).message}`);
      return { source: 'none', ...EMPTY_REVERSE };
    }
  }

  private async searchPhoton(query: string, limit: number): Promise<GeocodeResult[]> {
    const url = new URL(PHOTON_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    const body = await fetchJsonCapped<unknown>(url.toString(), this.options(PHOTON_TIMEOUT_MS));
    return normalizePhotonResponse(body);
  }

  private async searchNominatim(query: string, limit: number): Promise<GeocodeResult[]> {
    const url = new URL(`${NOMINATIM_URL}/search`);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    const body = await this.gate.run(() => fetchJsonCapped<unknown>(url.toString(), this.options()));
    return normalizeNominatimSearch(body);
  }

  private async reverseNominatim(latitude: number, longitude: number): Promise<ReverseResult | null> {
    const url = new URL(`${NOMINATIM_URL}/reverse`);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    // Zoom 14 = suburb level: enough to say where a truck is without resolving a house number.
    url.searchParams.set('zoom', '14');
    url.searchParams.set('lat', latitude.toFixed(4));
    url.searchParams.set('lon', longitude.toFixed(4));
    const body = await this.gate.run(() => fetchJsonCapped<unknown>(url.toString(), this.options()));
    return normalizeNominatimReverse(body);
  }

  private options(timeoutMs = 10_000): CappedFetchOptions {
    return { headers: this.headers, timeoutMs, maxBytes: 512 * 1024 };
  }
}

const EMPTY_REVERSE: ReverseResult = { label: null, locality: null, region: null, country: null, countryCode: null };

function snap(value: number, step: number): number {
  return Number((Math.round(value / step) * step).toFixed(6));
}
