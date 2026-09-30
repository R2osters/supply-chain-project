import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { TtlCache, fetchTextCapped } from '../../common/http';
import { assessFixQuality, findVisible, type FixQuality, type VisibleSatellite } from './look-angles';
import { CELESTRAK_ATTRIBUTION, SATELLITE_GROUPS, type SatelliteGroup } from './satellite-groups';
import { parseTle, type TleRecord } from './tle';

/**
 * Orbital elements from CelesTrak, and what they imply for a truck's GPS fix.
 *
 * CelesTrak is run by one person as a public service and asks clients not to download the same
 * group more often than every two hours — elements are only updated a few times a day anyway —
 * and it blocks addresses that ignore that. So each group is cached for two hours, and a stale
 * copy is served for up to a day when a refresh fails: day-old elements put a GPS satellite
 * within a few kilometres of its true position, which is irrelevant at 20 000 km range.
 *
 * Adapted from God's Eye View (MIT), `server/providers/space/celestrak.js`.
 */

export interface TleResponse {
  group: string;
  fetchedAt: string;
  stale: boolean;
  attribution: string;
  satellites: TleRecord[];
}

export interface VisibleResponse {
  group: string;
  at: string;
  latitude: number;
  longitude: number;
  minElevationDeg: number;
  visible: VisibleSatellite[];
  summary: { count: number; above30Deg: number; quality: FixQuality };
}

const TLE_TTL_MS = 2 * 60 * 60_000;
const TLE_STALE_MS = 22 * 60 * 60_000; // 2 h fresh + 22 h stale = served for at most 24 h
/** The largest allowed group (`geo`, ~600 objects) is ~110 kB; anything near this is wrong. */
const TLE_MAX_BYTES = 2 * 1024 * 1024;

@Injectable()
export class SatellitesService {
  private readonly logger = new Logger(SatellitesService.name);
  private readonly cache = new TtlCache<TleRecord[]>({ ttlMs: TLE_TTL_MS, staleMs: TLE_STALE_MS, maxEntries: 32 });

  constructor(private readonly now: () => Date = () => new Date()) {}

  listGroups(): { groups: SatelliteGroup[] } {
    return { groups: [...SATELLITE_GROUPS] };
  }

  async getTle(group: string): Promise<TleResponse> {
    const cached = await this.loadGroup(group);
    return {
      group,
      fetchedAt: cached.fetchedAt.toISOString(),
      stale: cached.stale,
      attribution: CELESTRAK_ATTRIBUTION,
      satellites: cached.value,
    };
  }

  async getVisible(latitude: number, longitude: number, group: string, minElevationDeg: number): Promise<VisibleResponse> {
    const cached = await this.loadGroup(group);
    const at = this.now();
    const visible = findVisible(cached.value, { latitude, longitude }, at, minElevationDeg);
    return {
      group,
      at: at.toISOString(),
      latitude,
      longitude,
      minElevationDeg,
      visible,
      summary: assessFixQuality(visible),
    };
  }

  private async loadGroup(group: string) {
    try {
      return await this.cache.getOrLoad(group, () => this.fetchGroup(group));
    } catch (error) {
      this.logger.warn(`CelesTrak group ${group} unavailable: ${(error as Error).message}`);
      throw new ServiceUnavailableException('Les éléments orbitaux sont momentanément indisponibles');
    }
  }

  private async fetchGroup(group: string): Promise<TleRecord[]> {
    const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
    const text = await fetchTextCapped(url, { maxBytes: TLE_MAX_BYTES, timeoutMs: 20_000 });
    const records = parseTle(text);
    // CelesTrak answers 200 with a plain-text message ("GP data has not updated...", "No GP data
    // found") in some cases; zero parsed sets means that, not an empty constellation.
    if (!records.length) throw new Error('CelesTrak returned no valid element sets');
    return records;
  }
}
