/**
 * In-memory cache for feeds that change slowly relative to how often screens ask for them.
 *
 * Two behaviours matter more than the caching itself:
 *
 *   - Single flight. Ten operators opening the same map at 08:00 must cost one upstream request,
 *     not ten. Concurrent misses for one key share the same pending promise.
 *   - Serve stale on failure. Free public services go down for minutes at a time. For a hazard
 *     map, a cyclone position that is 20 minutes old and labelled as such is far more useful
 *     than an error, so a failed refresh falls back to the last good value within `staleMs`.
 *
 * The caller sees `stale: true` and the age, and is expected to show it: a stale answer that
 * looks fresh is worse than no answer.
 */

export interface CachedValue<V> {
  value: V;
  fetchedAt: Date;
  stale: boolean;
}

interface Entry<V> {
  value: V;
  fetchedAt: number;
}

export interface TtlCacheOptions {
  ttlMs: number;
  /** How long past expiry a value may still be served when a refresh fails. 0 disables it. */
  staleMs?: number;
  maxEntries?: number;
  /** Injected in tests. */
  now?: () => number;
}

export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inFlight = new Map<string, Promise<CachedValue<V>>>();
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.staleMs = options.staleMs ?? 0;
    this.maxEntries = options.maxEntries ?? 500;
    this.now = options.now ?? Date.now;
  }

  async getOrLoad(key: string, load: () => Promise<V>): Promise<CachedValue<V>> {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.fetchedAt < this.ttlMs) {
      return { value: entry.value, fetchedAt: new Date(entry.fetchedAt), stale: false };
    }

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const attempt = this.refresh(key, load).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, attempt);
    return attempt;
  }

  peek(key: string): V | undefined {
    return this.entries.get(key)?.value;
  }

  get size(): number {
    return this.entries.size;
  }

  private async refresh(key: string, load: () => Promise<V>): Promise<CachedValue<V>> {
    try {
      const value = await load();
      this.store(key, value);
      return { value, fetchedAt: new Date(this.now()), stale: false };
    } catch (error) {
      const previous = this.entries.get(key);
      if (previous && this.now() - previous.fetchedAt < this.ttlMs + this.staleMs) {
        return { value: previous.value, fetchedAt: new Date(previous.fetchedAt), stale: true };
      }
      throw error;
    }
  }

  private store(key: string, value: V): void {
    // Re-inserting moves the key to the end, so the first key is always the least recently set.
    this.entries.delete(key);
    this.entries.set(key, { value, fetchedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
