import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TtlCache, UpstreamError, openUpstream, readBodyCapped } from '../../common/http';
import type { AppConfig } from '../../config/configuration';
import { DailyTileBudget, isValidTile } from './tile-budget';

/**
 * Live traffic-flow overlay: TomTom raster flow tiles, proxied so the API key stays on the server.
 *
 * A key in the browser is a key anyone can copy out of the network tab and spend. Proxying costs
 * us bandwidth (tiles are small, ~5–30 kB) but lets us enforce the daily budget, cache tiles
 * shared by every operator looking at the same corridor, and rotate the key without a frontend
 * release. The key is never echoed: not in responses, not in logs, not in error messages.
 *
 * Adapted from God's Eye View (MIT), `server/providers/traffic.js`.
 */

export interface TrafficStatus {
  enabled: boolean;
  provider: 'TomTom' | null;
  tilesUsedToday: number;
  dailyBudget: number;
  attribution: string | null;
  note: string | null;
}

export interface TrafficSettings {
  apiKey: string | null;
  dailyBudget: number;
}

export class TileBudgetExceededError extends Error {
  constructor() {
    super('Daily traffic tile budget reached');
    this.name = 'TileBudgetExceededError';
  }
}

const TOMTOM_ATTRIBUTION = 'Traffic © TomTom';
/** Keeps a 31-day month under TomTom's free monthly allowance (see docs/intel/traffic.md). */
export const DEFAULT_DAILY_TILE_BUDGET = 6000;
/** Traffic changes minute to minute; two minutes is the longest a flow colour stays honest. */
const TILE_TTL_MS = 120_000;
/** On upstream failure (or an exhausted budget) a tile up to ten minutes old beats a hole in the map. */
const TILE_STALE_MS = 10 * 60_000;
/** ~512 tiles of 5–30 kB bounds the cache to a few megabytes. */
const TILE_CACHE_ENTRIES = 512;
/** A flow PNG is tens of kilobytes; anything near 1 MB is not a tile. */
const TILE_MAX_BYTES = 1024 * 1024;

@Injectable()
export class TrafficService {
  private readonly logger = new Logger(TrafficService.name);
  private readonly fixedApiKey: string | null;
  private readonly budget: DailyTileBudget;
  private readonly tiles = new TtlCache<Buffer>({
    ttlMs: TILE_TTL_MS,
    staleMs: TILE_STALE_MS,
    maxEntries: TILE_CACHE_ENTRIES,
  });

  /**
   * `keySource`, when given, is asked on every use: the key can be entered in the app's settings
   * screen while the API runs, and traffic should switch on without a restart.
   */
  constructor(
    config?: ConfigService<AppConfig, true>,
    settings?: TrafficSettings,
    private readonly keySource?: () => string | null,
    /** Asked on every tile, like the key: the budget can be changed in the settings screen. */
    budgetSource?: () => number,
  ) {
    const intel = config?.get('intel', { infer: true });
    this.fixedApiKey = settings?.apiKey ?? intel?.tomtomApiKey ?? null;
    this.budget = new DailyTileBudget(
      budgetSource ?? settings?.dailyBudget ?? intel?.tomtomDailyTileBudget ?? DEFAULT_DAILY_TILE_BUDGET,
    );
  }

  private get apiKey(): string | null {
    return this.keySource ? this.keySource() : this.fixedApiKey;
  }

  get enabled(): boolean {
    return !!this.apiKey;
  }

  status(): TrafficStatus {
    if (!this.enabled) {
      return {
        enabled: false,
        provider: null,
        tilesUsedToday: 0,
        dailyBudget: this.budget.dailyLimit,
        attribution: null,
        note: 'Live traffic is off: add a free TomTom key in Settings → Data sources (or set TOMTOM_API_KEY).',
      };
    }
    return {
      enabled: true,
      provider: 'TomTom',
      tilesUsedToday: this.budget.usedToday(),
      dailyBudget: this.budget.dailyLimit,
      attribution: TOMTOM_ATTRIBUTION,
      note: this.budget.exhausted()
        ? 'Daily tile budget reached: cached tiles only until 00:00 UTC.'
        : null,
    };
  }

  async getTile(z: number, x: number, y: number): Promise<Buffer> {
    if (!this.apiKey) throw new NotFoundException('Live traffic is not enabled');
    if (!isValidTile(z, x, y)) throw new BadRequestException('Invalid tile coordinates');

    try {
      const cached = await this.tiles.getOrLoad(`${z}/${x}/${y}`, () => this.fetchTile(z, x, y));
      return cached.value;
    } catch (error) {
      if (error instanceof TileBudgetExceededError) {
        throw new HttpException('Daily traffic tile budget reached', HttpStatus.TOO_MANY_REQUESTS);
      }
      this.logger.warn(`TomTom tile ${z}/${x}/${y} failed: ${this.redact(describe(error))}`);
      throw new BadGatewayException('Traffic tiles are temporarily unavailable');
    }
  }

  private async fetchTile(z: number, x: number, y: number): Promise<Buffer> {
    // Counted before the request: TomTom bills the attempt whether or not a tile comes back.
    if (!this.budget.consume()) throw new TileBudgetExceededError();

    const url =
      `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png` +
      `?key=${encodeURIComponent(this.apiKey ?? '')}&tileSize=256`;
    const response = await openUpstream(url, { timeoutMs: 15_000, noRedirects: true });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/png')) {
      await response.body?.cancel().catch(() => undefined);
      // An error document served with 200 must not be cached and shown as a tile.
      throw new UpstreamError('api.tomtom.com returned a non-PNG body', 'api.tomtom.com', response.status);
    }
    return readBodyCapped(response, TILE_MAX_BYTES, 'api.tomtom.com');
  }

  /** Belt and braces: messages are built without the URL, but never let the key reach a log. */
  private redact(message: string): string {
    if (!this.apiKey) return message;
    return message.split(this.apiKey).join('[redacted]').split(encodeURIComponent(this.apiKey)).join('[redacted]');
  }
}

function describe(error: unknown): string {
  if (error instanceof UpstreamError) return error.message;
  return error instanceof Error ? error.name : 'unknown error';
}
