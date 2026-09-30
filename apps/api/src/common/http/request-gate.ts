/**
 * Serialises calls to a service whose usage policy sets a minimum spacing between requests —
 * Nominatim and the public OSRM servers both say "one request per second, maximum". Breaking
 * that gets the whole deployment's address blocked, not just the one user who clicked.
 *
 * The queue is bounded: under a burst, extra callers are refused immediately instead of being
 * held for a minute behind everyone else, which is what a user staring at a spinner would
 * prefer anyway.
 */

export class GateFullError extends Error {
  constructor() {
    super('Trop de requêtes attendent déjà ce service externe');
    this.name = 'GateFullError';
  }
}

export interface RequestGateOptions {
  minIntervalMs: number;
  maxQueue?: number;
  /** Injected in tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RequestGate {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private waiting = 0;
  private readonly minIntervalMs: number;
  private readonly maxQueue: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: RequestGateOptions) {
    this.minIntervalMs = options.minIntervalMs;
    this.maxQueue = options.maxQueue ?? 20;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.waiting >= this.maxQueue) return Promise.reject(new GateFullError());
    this.waiting += 1;

    const result = this.chain.then(async () => {
      const wait = this.lastStartedAt + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStartedAt = this.now();
      this.waiting -= 1;
      return task();
    });
    // The chain only orders start times; one task failing must not poison the next.
    this.chain = result.catch(() => undefined);
    return result;
  }
}
