import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppConfig } from '../../config/configuration';

/** The data-feed credentials a user can paste into the settings screen. */
export const FEED_KEYS = [
  'aisStreamApiKey',
  'marineTrafficApiKey',
  'openskyClientId',
  'openskyClientSecret',
  'tomtomApiKey',
  'firmsMapKey',
] as const;
export type FeedKey = (typeof FEED_KEYS)[number];

export type FeedValues = Partial<Record<FeedKey, string>>;
export type FeedUpdate = Partial<Record<FeedKey, string | null>>;

export interface FeedKeyState {
  configured: boolean;
  /** Where the effective value comes from: the settings screen wins over the environment. */
  from: 'settings' | 'environment' | null;
  /** Last four characters only; the full value never leaves the server. */
  hint: string | null;
}

type Listener = (changed: FeedKey[]) => void;

/**
 * Credentials for live data feeds (AIS for ships, OpenSky for aircraft).
 *
 * On a server these came from environment variables. A desktop user has no `.env` to edit, so
 * they paste keys into the settings screen instead; the values live in a small JSON file next to
 * the database (SETTINGS_FILE) and take precedence over the environment. Feeds subscribe to
 * changes and reconnect on the spot, so a new key works without restarting anything.
 */
@Injectable()
export class FeedSettingsService {
  private readonly logger = new Logger(FeedSettingsService.name);
  private readonly file: string;
  private readonly fromEnvironment: FeedValues;
  private stored: FeedValues;
  private readonly listeners: Listener[] = [];

  constructor(config: ConfigService<AppConfig, true>) {
    this.file = config.get('settings', { infer: true }).file;
    const maritime = config.get('maritime', { infer: true });
    const aircraft = config.get('aircraft', { infer: true });
    const intel = config.get('intel', { infer: true });
    this.fromEnvironment = compact({
      aisStreamApiKey: maritime.aisStreamApiKey,
      marineTrafficApiKey: maritime.marineTrafficApiKey,
      openskyClientId: aircraft.openskyClientId,
      openskyClientSecret: aircraft.openskyClientSecret,
      tomtomApiKey: intel.tomtomApiKey,
      firmsMapKey: intel.firmsMapKey,
    });
    this.stored = this.load();
  }

  /** The effective value of a key, or null when neither the screen nor the environment set it. */
  get(key: FeedKey): string | null {
    return this.stored[key] ?? this.fromEnvironment[key] ?? null;
  }

  describe(): Record<FeedKey, FeedKeyState> {
    const entries = FEED_KEYS.map((key): [FeedKey, FeedKeyState] => {
      const value = this.get(key);
      const from = this.stored[key] ? 'settings' : this.fromEnvironment[key] ? 'environment' : null;
      return [key, { configured: value !== null, from, hint: value ? `••••${value.slice(-4)}` : null }];
    });
    return Object.fromEntries(entries) as Record<FeedKey, FeedKeyState>;
  }

  /** Applies an update (`null` or blank clears a key), persists it and notifies the feeds. */
  update(update: FeedUpdate): Record<FeedKey, FeedKeyState> {
    const next: FeedValues = { ...this.stored };
    const changed: FeedKey[] = [];
    for (const key of FEED_KEYS) {
      if (!(key in update)) continue;
      const value = update[key]?.trim() || undefined;
      if (value === next[key]) continue;
      if (value) next[key] = value;
      else delete next[key];
      changed.push(key);
    }
    if (changed.length === 0) return this.describe();

    this.save(next);
    this.stored = next;
    this.logger.log(`Feed settings changed: ${changed.join(', ')}`);
    for (const listener of this.listeners) {
      try {
        listener(changed);
      } catch (error) {
        this.logger.error(`A feed failed to apply new settings: ${error instanceof Error ? error.message : error}`);
      }
    }
    return this.describe();
  }

  onChange(listener: Listener): void {
    this.listeners.push(listener);
  }

  private load(): FeedValues {
    if (!existsSync(this.file)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      const values: FeedValues = {};
      for (const key of FEED_KEYS) {
        if (typeof raw[key] === 'string' && raw[key]) values[key] = raw[key] as string;
      }
      return values;
    } catch (error) {
      // A corrupt file must not stop the API; the user can re-enter the keys.
      this.logger.warn(`Ignoring unreadable ${this.file}: ${error instanceof Error ? error.message : error}`);
      return {};
    }
  }

  /** Write-then-rename, so a crash mid-save never leaves a half-written file behind. */
  private save(values: FeedValues): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(values, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

function compact(values: Record<FeedKey, string | null>): FeedValues {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => Boolean(v))) as FeedValues;
}
