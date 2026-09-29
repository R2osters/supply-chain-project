import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

/**
 * Single source of truth for runtime configuration.
 * Everything is read through `ConfigService.get('...')` with these typed shapes — no bare
 * `process.env` access anywhere else in the codebase, so a missing variable fails once, loudly,
 * at boot rather than at 3 a.m. inside a request handler.
 */

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const float = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const list = (value: string | undefined, fallback: string[]): string[] => {
  if (!value) return fallback;
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
};

export interface AppConfig {
  env: string;
  isProduction: boolean;
  port: number;
  /**
   * Interface the API binds to. 127.0.0.1 by default: nothing on the network can reach it until
   * an administrator enables local network access (drivers' phones, trackers) in the settings.
   */
  host: string;
  globalPrefix: string;
  corsOrigins: string[];
  /**
   * Static export of the web UI. When set, the API serves it so drivers' phones on the local
   * network can open the app at http://<this PC>:<port>/drive — the desktop has no web server.
   */
  webDistDir: string | null;
  /**
   * `desktop` is the single-company install: registration closes once the first company exists.
   * `server` keeps open self-service registration.
   */
  runtime: 'desktop' | 'server';
  setup: {
    /** Compiled demo seed shipped with the desktop build; absent elsewhere. */
    demoSeedScript: string | null;
  };
  /** Values entered in the app's settings screen, which override the environment. */
  settings: {
    file: string;
    /**
     * Keys shipped inside this build (resources/defaults/feeds.json), so an install works with no
     * setup. Lowest precedence: the settings screen and the environment both override them.
     */
    bundledFile: string | null;
  };
  /**
   * Live aircraft. OpenSky Network first (as in God's Eye View), adsb.lol when OpenSky is rate
   * limited or down. OpenSky works anonymously; client credentials raise its daily quota. Its
   * terms allow non-commercial use only, which is what SCIP is (a personal, school project).
   */
  aircraft: {
    enabled: boolean;
    openskyClientId: string | null;
    openskyClientSecret: string | null;
  };
  database: { url: string };
  auth: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: string;
    refreshTtl: string;
    argon2MemoryCost: number;
    passwordResetTtlMinutes: number;
    maxFailedLogins: number;
    lockoutMinutes: number;
    /**
     * Shared secret between the desktop shell and this API for POST /auth/local-recovery (the
     * "forgotten password" of an install that cannot send e-mail). Only the shell knows it — it
     * lives in the user's own config.json. Null disables the endpoint, which then answers 404.
     */
    localRecoveryToken: string | null;
  };
  throttle: { ttlSeconds: number; limit: number; authLimit: number };
  ai: { url: string; timeoutMs: number; token: string };
  /** Local file storage for proof-of-delivery files. */
  storage: {
    dir: string;
    /** Signs download links. Derived from the access secret unless set explicitly. */
    signingSecret: string;
    /** Absolute base of this API, used to build download links the webview can open. */
    publicBaseUrl: string;
  };
  mail: {
    /** Null disables mail: a desktop install often has no SMTP server, and that is fine. */
    host: string | null;
    port: number;
    secure: boolean;
    user?: string;
    password?: string;
    from: string;
  };
  providers: {
    osrmUrl: string | null;
    roadWindingFactor: number;
  };
  simulator: { enabled: boolean; tickMs: number; speedMultiplier: number };
  deviceGateway: {
    /** TCP listener for hardware GPS trackers. Off in development unless asked for. */
    enabled: boolean;
    port: number;
    /** Same rule as the API: this PC only, unless local network access is enabled. */
    host: string;
  };
  network: {
    /** Where the local-network choice is saved (network.json in the data folder on desktop). */
    settingsFile: string | null;
  };
  maritime: {
    aisStreamApiKey: string | null;
    /** [[lat1, lon1], [lat2, lon2]] pairs. Empty subscribes worldwide. */
    aisBoundingBoxes: number[][][];
    /** Time compression for simulated voyages. Ignored entirely when a live feed is configured. */
    speedMultiplier: number;
    /** MarineTraffic API key. Paid — their service has no free tier. */
    marineTrafficApiKey: string | null;
    marineTrafficPollSeconds: number;
    /**
     * Whether to embed MarineTraffic's live map in the vessel screen. Off by default: embedding a
     * third party's map is governed by *their* terms, which is an operator's decision, not a code
     * default. Deep links carry no such question and are always on.
     */
    marineTrafficEmbedEnabled: boolean;
    /** Keyless Baltic AIS (Digitraffic) for the live map layer. */
    ambientFeed: boolean;
  };
  /**
   * Public situational feeds: hazards, cameras, radio, satellites, traffic, geocoding.
   * Everything here works without a key except TomTom traffic, which switches on when its key is
   * set and is reported as unavailable otherwise. FIRMS is optional (see below).
   */
  intel: {
    /**
     * NASA FIRMS MAP_KEY, optional and free. With it, fires are FIRMS satellite hotspots; without
     * it, they come from the keyless GDACS and NASA EONET feeds. The settings screen overrides it.
     */
    firmsMapKey: string | null;
    /** TomTom key for live traffic-flow tiles. Free tier: 50 000 tiles/day. */
    tomtomApiKey: string | null;
    /** Our own ceiling on TomTom tiles per UTC day, below the provider's so a runaway map stops first. */
    tomtomDailyTileBudget: number;
    /**
     * Camera catalogues to load, by id: tfl, fintraffic, drivebc, nsw, calgary. `ontario511` also
     * exists but its catalogue started requiring a developer key in 2026, so it is off by default.
     */
    cameraPacks: string[];
    /** Radius around an asset inside which a hazard counts as exposure, km. */
    hazardExposureRadiusKm: number;
  };
}

export default (): AppConfig => {
  const env = process.env.NODE_ENV ?? 'development';
  const isProduction = env === 'production';

  const accessSecret = process.env.JWT_ACCESS_SECRET ?? '';
  const refreshSecret = process.env.JWT_REFRESH_SECRET ?? '';

  // Fail fast rather than silently signing tokens with a placeholder in production.
  if (isProduction) {
    if (accessSecret.length < 32 || accessSecret.startsWith('dev_only')) {
      throw new Error('JWT_ACCESS_SECRET must be a real secret of >= 32 chars in production');
    }
    if (refreshSecret.length < 32 || refreshSecret.startsWith('dev_only')) {
      throw new Error('JWT_REFRESH_SECRET must be a real secret of >= 32 chars in production');
    }
    if (accessSecret === refreshSecret) {
      throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
    }
  }

  return {
    env,
    isProduction,
    port: int(process.env.API_PORT, 3001),
    host: process.env.API_HOST || '127.0.0.1',
    globalPrefix: process.env.API_GLOBAL_PREFIX ?? 'api/v1',
    // The desktop webview serves the UI from its own origin, which differs by WebView2 settings.
    corsOrigins: list(process.env.CORS_ORIGINS, [
      'http://tauri.localhost',
      'https://tauri.localhost',
      'tauri://localhost',
      'http://localhost:3000',
    ]),

    webDistDir: process.env.WEB_DIST_DIR || null,
    runtime: process.env.SCIP_RUNTIME === 'desktop' ? 'desktop' : 'server',
    setup: {
      demoSeedScript: process.env.DEMO_SEED_SCRIPT || resolve(process.cwd(), 'seed.js'),
    },
    settings: {
      file: process.env.SETTINGS_FILE || resolve(process.cwd(), 'settings.local.json'),
      bundledFile: process.env.BUNDLED_FEEDS_FILE || null,
    },
    aircraft: {
      enabled: bool(process.env.AIRCRAFT_ENABLED, true),
      openskyClientId: process.env.OPENSKY_CLIENT_ID || null,
      openskyClientSecret: process.env.OPENSKY_CLIENT_SECRET || null,
    },

    database: {
      url: process.env.DATABASE_URL ?? '',
    },


    auth: {
      accessSecret: accessSecret || 'dev_only_access_secret_replace_me_0000000000000000',
      refreshSecret: refreshSecret || 'dev_only_refresh_secret_replace_me_000000000000000',
      accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
      refreshTtl: process.env.JWT_REFRESH_TTL ?? '7d',
      argon2MemoryCost: int(process.env.ARGON2_MEMORY_COST, 19456),
      passwordResetTtlMinutes: int(process.env.PASSWORD_RESET_TTL_MINUTES, 30),
      maxFailedLogins: int(process.env.MAX_FAILED_LOGINS, 8),
      lockoutMinutes: int(process.env.LOCKOUT_MINUTES, 15),
      localRecoveryToken: process.env.LOCAL_RECOVERY_TOKEN?.trim() || null,
    },

    throttle: {
      ttlSeconds: int(process.env.THROTTLE_TTL_SECONDS, 60),
      limit: int(process.env.THROTTLE_LIMIT, 120),
      authLimit: int(process.env.THROTTLE_AUTH_LIMIT, 10),
    },

    ai: {
      url: process.env.AI_SERVICE_URL ?? 'http://localhost:8000',
      timeoutMs: int(process.env.AI_SERVICE_TIMEOUT_MS, 30000),
      token: process.env.AI_SERVICE_TOKEN ?? 'dev_only_ai_shared_token_replace_me',
    },

    storage: {
      dir: process.env.STORAGE_DIR ?? './storage',
      signingSecret:
        process.env.STORAGE_SIGNING_SECRET ||
        createHash('sha256').update(`storage:${accessSecret || 'dev_only'}`).digest('base64url'),
      publicBaseUrl:
        process.env.PUBLIC_API_URL ??
        `http://127.0.0.1:${int(process.env.API_PORT, 3001)}/${process.env.API_GLOBAL_PREFIX ?? 'api/v1'}`,
    },

    mail: {
      host: process.env.SMTP_HOST || null,
      port: int(process.env.SMTP_PORT, 1025),
      secure: bool(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER || undefined,
      password: process.env.SMTP_PASSWORD || undefined,
      from: process.env.MAIL_FROM ?? 'SCIP <no-reply@scip.local>',
    },

    providers: {
      osrmUrl: process.env.OSRM_URL || null,
      roadWindingFactor: float(process.env.ROAD_WINDING_FACTOR, 1.25),
    },

    simulator: {
      enabled: bool(process.env.SIMULATOR_ENABLED, true),
      tickMs: int(process.env.SIMULATOR_TICK_MS, 5000),
      // 12× keeps simulated vehicles visibly moving without finishing every trip within minutes
      // and leaving the live map empty.
      speedMultiplier: float(process.env.SIMULATOR_SPEED_MULTIPLIER, 12),
    },

    deviceGateway: {
      enabled: bool(process.env.DEVICE_GATEWAY_ENABLED, true),
      // 5023 is the port Traccar uses for GT06, so a device already configured for a Traccar
      // installation points here without being re-flashed by SMS.
      port: int(process.env.DEVICE_GATEWAY_PORT, 5023),
      host: process.env.DEVICE_GATEWAY_HOST || '127.0.0.1',
    },

    network: {
      settingsFile: process.env.NETWORK_SETTINGS_FILE || null,
    },

    maritime: {
      aisStreamApiKey: process.env.AISSTREAM_API_KEY || null,
      // Optional: restrict the AIS subscription to regions you care about. A worldwide
      // subscription is tens of thousands of messages a minute, most of them for vessels
      // nobody here tracks. Format: "lat1,lon1,lat2,lon2;lat1,lon1,lat2,lon2".
      aisBoundingBoxes: parseBoundingBoxes(process.env.AIS_BOUNDING_BOXES),
      // Ocean passages take days to weeks in reality. 240× turns a 9-day Tema→Rotterdam run into
      // about 55 minutes of watching, which is fast enough to see movement and slow enough that
      // the fleet does not empty while you look at it. Far higher than the road multiplier
      // because road legs are hours, not weeks.
      speedMultiplier: float(process.env.MARITIME_SPEED_MULTIPLIER, 240),
      marineTrafficApiKey: process.env.MARINETRAFFIC_API_KEY || null,
      // Every poll costs credits per vessel, so the default is deliberately unhurried. A ship at
      // 18 knots covers 1.5 nautical miles in five minutes — nothing a planner needs sooner.
      marineTrafficPollSeconds: int(process.env.MARINETRAFFIC_POLL_SECONDS, 300),
      marineTrafficEmbedEnabled: bool(process.env.MARINETRAFFIC_EMBED_ENABLED, false),
      ambientFeed: bool(process.env.MARITIME_AMBIENT_FEED, true),
    },

    intel: {
      firmsMapKey: process.env.FIRMS_MAP_KEY || null,
      tomtomApiKey: process.env.TOMTOM_API_KEY || null,
      // 6 000 a day keeps a 31-day month under TomTom's free allowance with room to spare.
      tomtomDailyTileBudget: int(process.env.TOMTOM_DAILY_TILE_BUDGET, 6000),
      cameraPacks: list(process.env.CAMERA_PACKS, [
        'tfl',
        'fintraffic',
        'drivebc',
        'nsw',
        'calgary',
      ]),
      hazardExposureRadiusKm: float(process.env.HAZARD_EXPOSURE_RADIUS_KM, 150),
    },
  };
};

/** Parses `"lat1,lon1,lat2,lon2;…"` into the nested-array shape the AIS feed expects. */
function parseBoundingBoxes(raw: string | undefined): number[][][] {
  if (!raw) return [];
  return raw
    .split(';')
    .map((box) => box.split(',').map((value) => Number.parseFloat(value.trim())))
    .filter((values) => values.length === 4 && values.every(Number.isFinite))
    .map(([lat1, lon1, lat2, lon2]) => [
      [lat1, lon1],
      [lat2, lon2],
    ]);
}
