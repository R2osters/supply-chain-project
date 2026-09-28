import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_USER_AGENT,
  TtlCache,
  fetchJsonCapped,
  openUpstream,
  type CappedFetchOptions,
} from '../../common/http';
import {
  RADIO_ATTRIBUTION,
  RADIO_FALLBACK_MIRRORS,
  buildSearchPath,
  isRadioUuid,
  normalizeStations,
  parseMirrorList,
  selectNearbyStations,
  type DirectoryStation,
  type RadioStation,
} from './radio-browser';

/**
 * Local radio near a truck, from the Radio Browser directory.
 *
 * The API only lists stations; it never touches audio. The driver's browser opens the stream
 * directly, which keeps our bandwidth flat and keeps us out of the rebroadcasting business — at
 * the cost that the broadcaster sees the listener's IP (documented in docs/intel/radio.md).
 *
 * Adapted from God's Eye View (MIT), `server/providers/radio/catalog.js`.
 */

export type RadioStatus = 'OK' | 'STALE' | 'UNAVAILABLE';

export interface RadioStationsResponse {
  status: RadioStatus;
  fetchedAt: string | null;
  attribution: string;
  stations: RadioStation[];
}

export interface StationQuery {
  latitude: number;
  longitude: number;
  radiusKm: number;
  tag?: string | null;
  limit: number;
}

/** Radio Browser asks clients to identify themselves so abusive traffic can be traced to an app. */
const REQUEST_OPTIONS: CappedFetchOptions = {
  headers: { 'User-Agent': `${DEFAULT_USER_AGENT} radio-browser-client` },
  timeoutMs: 12_000,
  // A mirror that redirects is either misconfigured or not a mirror; either way, try the next.
  noRedirects: true,
};

/** The directory barely changes within an hour; 45 min keeps a map pan from costing a request. */
const DIRECTORY_TTL_MS = 45 * 60_000;
/** A day-old station list is still right about which stations exist; better than nothing. */
const DIRECTORY_STALE_MS = 24 * 60 * 60_000;
const MIRROR_TTL_MS = 6 * 60 * 60_000;
/** Cells of 0.25° (~28 km) let nearby trucks share one upstream query. */
const CELL_DEGREES = 0.25;
/** Worst-case distance from a query point to its cell centre, added to the fetch radius. */
const CELL_SLACK_KM = 20;
/** Requested radii are rounded up to one of these so the cache is not keyed on every integer. */
const RADIUS_BUCKETS_KM = [50, 100, 150, 300, 500, 1000];
/** Stations fetched per cell, most-listened first; tag filtering and limits are applied locally. */
const UPSTREAM_LIMIT = 500;
/** Bound on remembered station ids for click reporting. */
const KNOWN_IDS_MAX = 20_000;

@Injectable()
export class RadioService {
  private readonly logger = new Logger(RadioService.name);
  private readonly directory = new TtlCache<DirectoryStation[]>({
    ttlMs: DIRECTORY_TTL_MS,
    staleMs: DIRECTORY_STALE_MS,
    maxEntries: 400,
  });
  private readonly mirrors = new TtlCache<string[]>({ ttlMs: MIRROR_TTL_MS, staleMs: 7 * 24 * 60 * 60_000 });
  /** Station ids we have actually served; clicks are only relayed for these. */
  private readonly knownIds = new Set<string>();

  async findStations(query: StationQuery): Promise<RadioStationsResponse> {
    const cell = cellFor(query.latitude, query.longitude);
    const bucketKm = radiusBucket(query.radiusKm);
    const key = `${cell.latitude}:${cell.longitude}:${bucketKm}`;

    try {
      const cached = await this.directory.getOrLoad(key, () =>
        this.searchDirectory(cell.latitude, cell.longitude, bucketKm + CELL_SLACK_KM),
      );
      const stations = selectNearbyStations(cached.value, {
        origin: { latitude: query.latitude, longitude: query.longitude },
        radiusKm: query.radiusKm,
        tag: query.tag,
        limit: query.limit,
      });
      this.remember(stations);
      return {
        status: cached.stale ? 'STALE' : 'OK',
        fetchedAt: cached.fetchedAt.toISOString(),
        attribution: RADIO_ATTRIBUTION,
        stations,
      };
    } catch (error) {
      this.logger.warn(`Radio Browser unavailable: ${(error as Error).message}`);
      return { status: 'UNAVAILABLE', fetchedAt: null, attribution: RADIO_ATTRIBUTION, stations: [] };
    }
  }

  /**
   * Tells Radio Browser a station was played. The directory ranks stations by these counts, so
   * reporting real plays is how we give back; relaying only ids we served stops the endpoint
   * from being used to inflate arbitrary stations.
   */
  async registerClick(id: string): Promise<{ ok: boolean }> {
    const uuid = id.toLowerCase();
    if (!isRadioUuid(uuid) || !this.knownIds.has(uuid)) return { ok: false };
    try {
      await this.withMirror(async (origin) => {
        const response = await openUpstream(`${origin}/json/url/${uuid}`, REQUEST_OPTIONS);
        await response.body?.cancel().catch(() => undefined);
      });
      return { ok: true };
    } catch (error) {
      this.logger.debug(`Radio click not recorded: ${(error as Error).message}`);
      return { ok: false };
    }
  }

  private async searchDirectory(latitude: number, longitude: number, radiusKm: number): Promise<DirectoryStation[]> {
    const path = buildSearchPath({ latitude, longitude, radiusKm, limit: UPSTREAM_LIMIT });
    return this.withMirror(async (origin) => {
      const rows = await fetchJsonCapped<unknown>(`${origin}${path}`, REQUEST_OPTIONS);
      if (!Array.isArray(rows)) throw new Error('Radio Browser search did not return a list');
      return normalizeStations(rows);
    });
  }

  /** Runs `task` against each mirror in turn until one succeeds; mirrors go down independently. */
  private async withMirror<T>(task: (origin: string) => Promise<T>): Promise<T> {
    const origins = await this.mirrorOrigins();
    let lastError: unknown = new Error('No Radio Browser mirror available');
    for (const origin of origins) {
      try {
        return await task(origin);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private async mirrorOrigins(): Promise<string[]> {
    try {
      const cached = await this.mirrors.getOrLoad('servers', async () => {
        const rows = await fetchJsonCapped<unknown>('https://all.api.radio-browser.info/json/servers', {
          ...REQUEST_OPTIONS,
          maxBytes: 256 * 1024,
        });
        const discovered = parseMirrorList(rows);
        if (!discovered.length) throw new Error('Radio Browser server list was empty');
        return discovered;
      });
      return [...new Set([...cached.value, ...RADIO_FALLBACK_MIRRORS])];
    } catch {
      return [...RADIO_FALLBACK_MIRRORS];
    }
  }

  private remember(stations: RadioStation[]): void {
    for (const station of stations) {
      if (this.knownIds.size >= KNOWN_IDS_MAX && !this.knownIds.has(station.id)) {
        const oldest = this.knownIds.values().next().value;
        if (oldest !== undefined) this.knownIds.delete(oldest);
      }
      this.knownIds.add(station.id);
    }
  }
}

export function cellFor(latitude: number, longitude: number): { latitude: number; longitude: number } {
  const snap = (value: number): number => Math.round(value / CELL_DEGREES) * CELL_DEGREES;
  return { latitude: snap(latitude), longitude: snap(longitude) };
}

export function radiusBucket(radiusKm: number): number {
  return RADIUS_BUCKETS_KM.find((bucket) => bucket >= radiusKm) ?? RADIUS_BUCKETS_KM[RADIUS_BUCKETS_KM.length - 1];
}
