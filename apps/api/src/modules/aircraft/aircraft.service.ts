import { Injectable, Logger } from '@nestjs/common';
import { DEFAULT_USER_AGENT } from '../../common/http';
import { FeedSettingsService } from '../settings/feed-settings.service';
import {
  type Aircraft,
  type BoundingBox,
  boxKey,
  circleAround,
  clampBoundingBox,
  contains,
  fromAdsbLol,
  fromOpenSkyState,
  openSkyDailyQuota,
  openSkyTtlMs,
  snapBoundingBox,
} from './aircraft.model';

export type AircraftSource = 'opensky' | 'adsb.lol' | 'none';

export interface AircraftResponse {
  source: AircraftSource;
  authenticated: boolean;
  stale: boolean;
  fetchedAt: string;
  attribution: string;
  aircraft: Aircraft[];
}

interface CacheEntry {
  source: Exclude<AircraftSource, 'none'>;
  authenticated: boolean;
  aircraft: Aircraft[];
  fetchedAt: number;
  ttlMs: number;
}

const OPENSKY_STATES = 'https://opensky-network.org/api/states/all';
const OPENSKY_TOKEN =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const ADSBLOL_POINT = 'https://api.adsb.lol/v2';

export const ATTRIBUTION: Record<AircraftSource, string> = {
  opensky: 'The OpenSky Network, https://opensky-network.org',
  'adsb.lol': 'adsb.lol (ODbL 1.0)',
  none: '',
};

const REQUEST_TIMEOUT_MS = 10_000;
const ADSBLOL_TTL_MS = 12_000;
/** Past this age a cached answer is dropped rather than served as stale. */
const MAX_STALE_MS = 10 * 60_000;
const CACHE_LIMIT = 60;
const COOLDOWN_MIN_MS = 30_000;
const COOLDOWN_MAX_MS = 30 * 60_000;

/**
 * Live aircraft around a map view.
 *
 * Same strategy as God's Eye View (MIT, server/providers/aircraft/opensky.js): OpenSky Network
 * first, with OAuth client credentials when the user entered some (they raise the daily quota)
 * and anonymously otherwise; adsb.lol, which needs no key, whenever OpenSky is rate limited,
 * cooling down or failing. OpenSky's terms allow non-commercial use only, which SCIP is.
 *
 * OpenSky counts credits per request, so answers are cached per snapped view and the cache
 * stretches as the remaining budget thins; a 429 starts a cooldown honouring Retry-After, during
 * which nothing is sent to OpenSky at all.
 */
@Injectable()
export class AircraftService {
  private readonly logger = new Logger(AircraftService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CacheEntry>>();

  private token: { value: string; expiresAt: number } | null = null;
  private creditsRemaining: number | null = null;
  private coolingDownUntil = 0;
  private lastError: string | null = null;

  constructor(private readonly feeds: FeedSettingsService) {
    feeds.onChange((changed) => {
      if (changed.some((key) => key.startsWith('opensky'))) {
        // New credentials: forget the old token and the anonymous cooldown.
        this.token = null;
        this.coolingDownUntil = 0;
        this.cache.clear();
      }
    });
  }

  status() {
    return {
      source: Date.now() < this.coolingDownUntil || this.openSkyBudgetLow() ? 'adsb.lol' : 'opensky',
      authenticated: this.hasCredentials(),
      creditsRemaining: this.creditsRemaining,
      coolingDownUntil: this.coolingDownUntil > Date.now() ? new Date(this.coolingDownUntil).toISOString() : null,
      lastError: this.lastError,
      attribution: `${ATTRIBUTION.opensky}; fallback ${ATTRIBUTION['adsb.lol']}`,
    };
  }

  async inView(requested: BoundingBox): Promise<AircraftResponse> {
    const view = clampBoundingBox(requested);
    const box = snapBoundingBox(view);
    const key = boxKey(box);
    const cached = this.cache.get(key);

    let entry: CacheEntry | undefined = cached;
    let stale = false;
    if (!cached || Date.now() - cached.fetchedAt > cached.ttlMs) {
      try {
        entry = await this.refresh(key, box);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        if (cached && Date.now() - cached.fetchedAt < MAX_STALE_MS) stale = true;
        else entry = undefined;
      }
    }

    if (!entry) {
      return { source: 'none', authenticated: false, stale: false, fetchedAt: new Date().toISOString(), attribution: '', aircraft: [] };
    }
    return {
      source: entry.source,
      authenticated: entry.authenticated,
      stale,
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
      attribution: ATTRIBUTION[entry.source],
      // The snapped box is wider than the view; trim so the map gets what it shows.
      aircraft: entry.aircraft.filter((a) => contains(view, a.latitude, a.longitude)),
    };
  }

  /** One upstream request per snapped box at a time; concurrent viewers share it. */
  private refresh(key: string, box: BoundingBox): Promise<CacheEntry> {
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const request = this.fetchAny(box)
      .then((entry) => {
        this.remember(key, entry);
        return entry;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private async fetchAny(box: BoundingBox): Promise<CacheEntry> {
    if (Date.now() >= this.coolingDownUntil && !this.openSkyBudgetLow()) {
      try {
        const fromOpenSky = await this.fetchOpenSky(box);
        if (fromOpenSky.aircraft.length > 0) return fromOpenSky;
        // Empty is often a coverage gap (West Africa, open ocean), not an empty sky: ask
        // adsb.lol, whose receivers differ, before concluding there is nothing there.
        const fromAdsbLol = await this.fetchAdsbLol(box).catch(() => null);
        return fromAdsbLol && fromAdsbLol.aircraft.length > 0 ? fromAdsbLol : fromOpenSky;
      } catch (error) {
        this.lastError = `OpenSky: ${error instanceof Error ? error.message : error}`;
        this.logger.warn(`${this.lastError}; using adsb.lol`);
      }
    }
    return this.fetchAdsbLol(box);
  }

  /**
   * Once OpenSky would have to serve answers more than 30 s old to last the day, adsb.lol (no
   * quota) gives fresher positions; OpenSky takes over again when its credits reset.
   */
  private openSkyBudgetLow(): boolean {
    const quota = openSkyDailyQuota(this.hasCredentials());
    return openSkyTtlMs(this.creditsRemaining, quota) > 30_000;
  }

  private async fetchOpenSky(box: BoundingBox): Promise<CacheEntry> {
    const token = await this.openSkyToken();
    const query = new URLSearchParams({
      lamin: String(box.minLat),
      lomin: String(box.minLon),
      lamax: String(box.maxLat),
      lomax: String(box.maxLon),
    });
    const response = await fetch(`${OPENSKY_STATES}?${query}`, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const remaining = Number.parseInt(response.headers.get('x-rate-limit-remaining') ?? '', 10);
    if (Number.isFinite(remaining)) this.creditsRemaining = remaining;

    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get('x-rate-limit-retry-after-seconds') ?? '', 10);
      const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : COOLDOWN_MIN_MS;
      this.coolingDownUntil = Date.now() + Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, wait));
      throw new Error('rate limited');
    }
    if (response.status === 401 && token) {
      this.token = null;
      throw new Error('credentials rejected');
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const body = (await response.json()) as { states?: unknown[][] | null };
    const aircraft = (body.states ?? []).map(fromOpenSkyState).filter((a): a is Aircraft => a !== null);
    return {
      source: 'opensky',
      authenticated: token !== null,
      aircraft,
      fetchedAt: Date.now(),
      ttlMs: openSkyTtlMs(this.creditsRemaining, openSkyDailyQuota(token !== null)),
    };
  }

  private async fetchAdsbLol(box: BoundingBox): Promise<CacheEntry> {
    const { lat, lon, radiusNm } = circleAround(box);
    const url = `${ADSBLOL_POINT}/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${radiusNm}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`adsb.lol HTTP ${response.status}`);
    const body = (await response.json()) as { ac?: Array<Record<string, unknown>> };
    const aircraft = (body.ac ?? []).map(fromAdsbLol).filter((a): a is Aircraft => a !== null);
    return { source: 'adsb.lol', authenticated: false, aircraft, fetchedAt: Date.now(), ttlMs: ADSBLOL_TTL_MS };
  }

  private hasCredentials(): boolean {
    return Boolean(this.feeds.get('openskyClientId') && this.feeds.get('openskyClientSecret'));
  }

  /** OAuth2 client-credentials token, refreshed a minute before expiry; null means anonymous. */
  private async openSkyToken(): Promise<string | null> {
    const clientId = this.feeds.get('openskyClientId');
    const clientSecret = this.feeds.get('openskyClientSecret');
    if (!clientId || !clientSecret) return null;
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;

    const response = await fetch(OPENSKY_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!response.ok || !body.access_token) {
      // Wrong credentials should not cost the user the whole layer: carry on anonymously.
      this.logger.warn(`OpenSky OAuth failed (HTTP ${response.status}); continuing anonymously`);
      return null;
    }
    const expiresIn = Number.isFinite(body.expires_in) ? (body.expires_in as number) : 1800;
    this.token = { value: body.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return this.token.value;
  }

  private remember(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    // Map iteration order is insertion order: the first key is the least recently refreshed.
    while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value as string);
  }
}
