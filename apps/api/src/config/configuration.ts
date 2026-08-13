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
  globalPrefix: string;
  corsOrigins: string[];
  database: { url: string };
  redis: { host: string; port: number; url: string };
  auth: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: string;
    refreshTtl: string;
    argon2MemoryCost: number;
    passwordResetTtlMinutes: number;
    maxFailedLogins: number;
    lockoutMinutes: number;
  };
  throttle: { ttlSeconds: number; limit: number; authLimit: number };
  ai: { url: string; timeoutMs: number; token: string };
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    forcePathStyle: boolean;
  };
  mail: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    password?: string;
    from: string;
  };
  providers: {
    openWeatherApiKey: string | null;
    osrmUrl: string | null;
    roadWindingFactor: number;
  };
  simulator: { enabled: boolean; tickMs: number; speedMultiplier: number };
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
    globalPrefix: process.env.API_GLOBAL_PREFIX ?? 'api/v1',
    corsOrigins: list(process.env.CORS_ORIGINS, ['http://localhost:3000']),

    database: {
      url: process.env.DATABASE_URL ?? '',
    },

    redis: {
      host: process.env.REDIS_HOST ?? 'localhost',
      port: int(process.env.REDIS_PORT, 6380),
      url: process.env.REDIS_URL ?? `redis://${process.env.REDIS_HOST ?? 'localhost'}:${int(process.env.REDIS_PORT, 6380)}`,
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

    s3: {
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
      region: process.env.S3_REGION ?? 'us-east-1',
      bucket: process.env.S3_BUCKET ?? 'scip-pod',
      accessKey: process.env.S3_ACCESS_KEY ?? 'scipminio',
      secretKey: process.env.S3_SECRET_KEY ?? 'scipminio_dev_password',
      forcePathStyle: bool(process.env.S3_FORCE_PATH_STYLE, true),
    },

    mail: {
      host: process.env.SMTP_HOST ?? 'localhost',
      port: int(process.env.SMTP_PORT, 1025),
      secure: bool(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER || undefined,
      password: process.env.SMTP_PASSWORD || undefined,
      from: process.env.MAIL_FROM ?? 'SCIP <no-reply@scip.local>',
    },

    providers: {
      openWeatherApiKey: process.env.OPENWEATHER_API_KEY || null,
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
