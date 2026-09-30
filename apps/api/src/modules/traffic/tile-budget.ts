/**
 * Tile coordinates and the daily tile budget for the TomTom traffic overlay.
 *
 * TomTom's free allowance is granted per month, and a map is greedy: every pan or zoom asks for
 * a dozen tiles or more. Without a governor, one busy control room could burn the month's
 * allowance in a few days and leave the overlay dead until the next billing period (the failure
 * God's Eye View hit with its first default). So this service keeps its own ceiling per UTC day,
 * set below the provider's, and stops asking once it is reached. Cache hits never count, since
 * they cost TomTom nothing.
 *
 * Adapted from God's Eye View (MIT), `src/data/tomtomTiles.js` and `server/providers/traffic.js`.
 */

export const MIN_TILE_ZOOM = 0;
export const MAX_TILE_ZOOM = 22;

/** A slippy-map tile address: integers, zoom 0–22, and x, y inside the 2^z grid. */
export function isValidTile(z: number, x: number, y: number): boolean {
  if (![z, x, y].every(Number.isInteger)) return false;
  if (z < MIN_TILE_ZOOM || z > MAX_TILE_ZOOM) return false;
  const size = 2 ** z;
  return x >= 0 && x < size && y >= 0 && y < size;
}

/** Parses a path segment strictly: "12" yes, "12.0", "1e1", " 12" or "0x0c" no. */
export function parseTileSegment(value: string): number | null {
  return /^\d{1,7}$/.test(value) ? Number(value) : null;
}

/** The budget day, as "YYYY-MM-DD" in UTC; the counter resets when this changes. */
export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export interface BudgetState {
  day: string;
  used: number;
}

/** Today's state: yesterday's counter is discarded rather than carried over. */
export function rollBudget(state: BudgetState | null, today: string): BudgetState {
  return state && state.day === today ? state : { day: today, used: 0 };
}

/**
 * Counts one upstream request if the budget allows it. Returns the new state and whether the
 * request may proceed; the attempt is counted before the fetch because TomTom bills a request
 * whether or not the tile arrives. A limit of 0 (or less) means no ceiling: the user chose to let
 * their TomTom plan, not SCIP, decide when to stop.
 */
export function tryConsume(state: BudgetState, limit: number): { state: BudgetState; allowed: boolean } {
  if (limit > 0 && state.used >= limit) return { state, allowed: false };
  return { state: { day: state.day, used: state.used + 1 }, allowed: true };
}

/**
 * Stateful wrapper with an injectable clock, so the service does not reimplement day rollover.
 * The limit may be a function: it is then read on every use, so a budget changed in the settings
 * screen applies without a restart.
 */
export class DailyTileBudget {
  private state: BudgetState | null = null;
  private readonly limitSource: () => number;

  constructor(
    limit: number | (() => number),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.limitSource = typeof limit === 'function' ? limit : () => limit;
  }

  /** Tiles allowed per UTC day; 0 means unlimited. */
  get dailyLimit(): number {
    return this.limitSource();
  }

  usedToday(): number {
    this.state = rollBudget(this.state, utcDayKey(this.now()));
    return this.state.used;
  }

  exhausted(): boolean {
    const limit = this.dailyLimit;
    return limit > 0 && this.usedToday() >= limit;
  }

  consume(): boolean {
    const result = tryConsume(rollBudget(this.state, utcDayKey(this.now())), this.dailyLimit);
    this.state = result.state;
    return result.allowed;
  }
}
