/**
 * Data-feed keys (AISStream, MarineTraffic, OpenSky, TomTom, NASA FIRMS) as the settings page edits them.
 *
 * The API never returns a secret, only whether one is configured, where it comes from and a
 * masked hint. The page sends only what the operator typed: an omitted field is left unchanged,
 * `null` clears it (the environment value, if any, then applies again).
 */

export interface FeedKey {
  configured: boolean;
  /** `bundled`: shipped inside this build of SCIP (keys.local.json at build time). */
  from: 'settings' | 'environment' | 'bundled' | null;
  /** Masked tail such as `••••3f9a`, never the key itself. */
  hint: string | null;
}

export interface FeedSettings {
  aisStream: FeedKey;
  marineTraffic: FeedKey;
  openskyClientId: FeedKey;
  openskyClientSecret: FeedKey;
  tomtom: FeedKey;
  firms: FeedKey;
}

export type FeedField = keyof FeedSettings;

export const FEED_FIELDS: FeedField[] = [
  'aisStream',
  'marineTraffic',
  'openskyClientId',
  'openskyClientSecret',
  'tomtom',
  'firms',
];

/** Body field of `PUT /settings/feeds` for each key of the GET shape. */
export const FEED_BODY_FIELD = {
  aisStream: 'aisStreamApiKey',
  marineTraffic: 'marineTrafficApiKey',
  openskyClientId: 'openskyClientId',
  openskyClientSecret: 'openskyClientSecret',
  tomtom: 'tomtomApiKey',
  firms: 'firmsMapKey',
} as const satisfies Record<FeedField, string>;

export type FeedUpdate = Partial<Record<(typeof FEED_BODY_FIELD)[FeedField], string | null>>;

/**
 * Typed drafts → PUT body. Blank drafts are left out (unchanged), fields marked for clearing are
 * sent as `null`, and a value is trimmed — a key pasted with a trailing newline is still the key.
 */
export function buildFeedUpdate(
  drafts: Partial<Record<FeedField, string>>,
  clear: Partial<Record<FeedField, boolean>> = {},
): FeedUpdate {
  const body: FeedUpdate = {};
  for (const field of FEED_FIELDS) {
    const key = FEED_BODY_FIELD[field];
    if (clear[field]) {
      body[key] = null;
      continue;
    }
    const value = drafts[field]?.trim();
    if (value) body[key] = value;
  }
  return body;
}

export function isEmptyUpdate(update: FeedUpdate): boolean {
  return Object.keys(update).length === 0;
}

export interface AircraftStatus {
  source: 'opensky' | 'adsb.lol' | 'none' | string;
  authenticated: boolean;
  creditsRemaining: number | null;
  coolingDownUntil: string | null;
  attribution: string;
}

export interface MaritimeFeedStatus {
  /** Feed of the vessels this install tracks (AISStream, MarineTraffic or the simulator). */
  source: string;
  isLive: boolean;
  detail: string;
  howToGoLive: string | null;
  /** Keyless Baltic AIS feeding the live map layer, whatever the tracked-vessel feed is. */
  ambient?: { active: boolean; source: string; coverage: string; state: string; attribution: string };
}

/** An OpenSky cool-down still in force at `now`; a past date means the feed is back. */
export function isCoolingDown(status: Pick<AircraftStatus, 'coolingDownUntil'>, now: number = Date.now()): boolean {
  if (!status.coolingDownUntil) return false;
  const until = Date.parse(status.coolingDownUntil);
  return Number.isFinite(until) && until > now;
}
