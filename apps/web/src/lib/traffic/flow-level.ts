/**
 * Measured traffic level → colour bucket, dot speed and dot density.
 *
 * `level` is current speed / free-flow speed, 0..1 with 1 = free flow (TomTom's
 * `traffic_level`; the API computes the same ratio for Rennes and Grenoble). Adapted from
 * God's Eye View (MIT, `src/data/trafficFlowStyle.js`), with one change: a missing or
 * non-finite level yields the `null` bucket ("not measured", drawn grey) instead of "free",
 * so the map never passes an estimate off as a measurement. Speed and density still fall back
 * to neutral values: a road with unusable data moves like the simulation, never like a jam.
 */

export type FlowBucket = 'free' | 'slow' | 'jam';

/** Levels at or above this are free-flowing (green). */
export const FREE_THRESHOLD = 0.85;
/** Levels at or above this, and below FREE_THRESHOLD, are slow (orange); below is a jam (red). */
export const SLOW_THRESHOLD = 0.55;

/** Jammed roads crawl but never freeze, so the layer still reads as alive. */
const MIN_SPEED_SCALE = 0.15;
/** Congestion packs more cars on a road: 1 / max(level, 0.4), so at most 2.5 times. */
const DENSITY_LEVEL_FLOOR = 0.4;
const MAX_DENSITY_MULT = 2.5;

function measured(level: number | null | undefined): level is number {
  return typeof level === 'number' && Number.isFinite(level);
}

export function flowBucket(level: number | null | undefined): FlowBucket | null {
  if (!measured(level)) return null;
  if (level >= FREE_THRESHOLD) return 'free';
  if (level >= SLOW_THRESHOLD) return 'slow';
  return 'jam';
}

/** Multiplier on a road's free speed, within [0.15, 1]; 1 when the level is unusable. */
export function flowSpeedScale(level: number | null | undefined): number {
  if (!measured(level)) return 1;
  return Math.min(1, Math.max(MIN_SPEED_SCALE, level));
}

/** Multiplier on a road's dot count, within [1, 2.5] for levels up to 1; 1 when unusable. */
export function flowDensityMult(level: number | null | undefined): number {
  if (!measured(level)) return 1;
  return Math.min(MAX_DENSITY_MULT, 1 / Math.max(level, DENSITY_LEVEL_FLOOR));
}
