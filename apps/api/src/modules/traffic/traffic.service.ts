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
 * Live traffic flow from TomTom: raster tiles (the Situation map's overlay) and vector tiles (the
 * live map's measured speeds), both proxied so the API key stays on the server.
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

export const TOMTOM_ATTRIBUTION = 'Traffic © TomTom';
/** Keeps a 31-day month under TomTom's free monthly allowance (see docs/intel/traffic.md). */
export const DEFAULT_DAILY_TILE_BUDGET = 6000;
/** Traffic changes minute to minute; two minutes is the longest a flow colour stays honest. */
const TILE_TTL_MS = 120_000;
/** On upstream failure (or an exhausted budget) a tile up to ten minutes old beats a hole in the map. */
const TILE_STALE_MS = 10 * 60_000;
/** ~512 tiles of 5–30 kB bounds the cache to a few megabytes. */
const TILE_CACHE_ENTRIES = 512;
/** A flow PNG or vector tile is tens of kilobytes; anything near 1 MB is not a tile. */
const TILE_MAX_BYTES = 1024 * 1024;

type TileKind = 'raster' | 'flow';

/** What each kind of tile is, upstream: its URL and the content types that prove it is a tile. */
const TILE_KINDS: Record<TileKind, { url: (z: number, x: number, y: number, key: string) => string; types: string[] }> = {
  raster: {
    url: (z, x, y, key) =>
      `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png?key=${encodeURIComponent(key)}&tileSize=256`,
    types: ['image/png'],
  },
  // Relative speeds (current / free flow) per road line: the live map colours and slows its
  // simulated traffic with them. Adapted from God's Eye View (MIT), server/providers/traffic.js.
  flow: {
    url: (z, x, y, key) =>
      `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.pbf?key=${encodeURIComponent(key)}`,
    types: ['application/vnd.mapbox-vector-tile', 'application/x-protobuf', 'application/octet-stream'],
  },
};

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

  budgetExhausted(): boolean {
    return this.budget.exhausted();
  }

  status(): TrafficStatus {
    if (!this.enabled) {
      return {
        enabled: false,
        provider: null,
        tilesUsedToday: 0,
        dailyBudget: this.budget.dailyLimit,
        attribution: null,
        note:
          'Trafic en direct désactivé : ajoutez une clé TomTom gratuite dans Réglages → Sources de données ' +
          '(ou définissez TOMTOM_API_KEY).',
      };
    }
    return {
      enabled: true,
      provider: 'TomTom',
      tilesUsedToday: this.budget.usedToday(),
      dailyBudget: this.budget.dailyLimit,
      attribution: TOMTOM_ATTRIBUTION,
      note: this.budget.exhausted()
        ? 'Le budget quotidien de tuiles est atteint : seules les tuiles en cache sont servies jusqu’à 00:00 UTC.'
        : null,
    };
  }

  /** A raster flow tile (256 px PNG), for the Situation map's overlay. */
  getTile(z: number, x: number, y: number): Promise<Buffer> {
    return this.serveTile('raster', z, x, y);
  }

  /** A vector flow tile (Mapbox Vector Tile, layer "Traffic flow"), for the live map. */
  getFlowTile(z: number, x: number, y: number): Promise<Buffer> {
    return this.serveTile('flow', z, x, y);
  }

  private async serveTile(kind: TileKind, z: number, x: number, y: number): Promise<Buffer> {
    if (!this.apiKey) throw new NotFoundException('Le trafic en direct n’est pas activé');
    if (!isValidTile(z, x, y)) throw new BadRequestException('Coordonnées de tuile invalides');

    try {
      const cached = await this.tiles.getOrLoad(`${kind}/${z}/${x}/${y}`, () => this.fetchTile(kind, z, x, y));
      return cached.value;
    } catch (error) {
      if (error instanceof TileBudgetExceededError) {
        throw new HttpException('Budget quotidien de tuiles de trafic atteint', HttpStatus.TOO_MANY_REQUESTS);
      }
      this.logger.warn(`TomTom ${kind} tile ${z}/${x}/${y} failed: ${this.redact(describe(error))}`);
      throw new BadGatewayException('Les tuiles de trafic sont momentanément indisponibles');
    }
  }

  private async fetchTile(kind: TileKind, z: number, x: number, y: number): Promise<Buffer> {
    // Counted before the request: TomTom bills the attempt whether or not a tile comes back.
    if (!this.budget.consume()) throw new TileBudgetExceededError();

    const { url, types } = TILE_KINDS[kind];
    const response = await openUpstream(url(z, x, y, this.apiKey ?? ''), { timeoutMs: 15_000, noRedirects: true });
    const contentType = response.headers.get('content-type') ?? '';
    if (!types.some((type) => contentType.startsWith(type))) {
      await response.body?.cancel().catch(() => undefined);
      // An error document served with 200 must not be cached and shown as a tile.
      throw new UpstreamError(`api.tomtom.com returned a body that is not a ${kind} tile`, 'api.tomtom.com', response.status);
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
