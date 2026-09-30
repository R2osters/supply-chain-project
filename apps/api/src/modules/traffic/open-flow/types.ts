/**
 * Measured road speeds from keyless open data (cities that publish their traffic in real time).
 *
 * The live map simulates traffic everywhere; these measurements are what makes it real where they
 * exist: a measured road's dots take its speed and colour. No table in the database: every
 * provider keeps its last good answer in memory.
 */

import type { Bbox } from './bbox';

export type OpenFlowSourceId = 'rennes' | 'grenoble';

export interface FlowSegment {
  /** `${source}:${upstream id}`, stable across refreshes. */
  id: string;
  source: OpenFlowSourceId;
  /** `[lon, lat]`, at least two points. */
  coordinates: [number, number][];
  /** Current speed over free-flow speed, 0..1; null when nothing was measured. */
  level: number | null;
  closed: boolean;
  speedKmh: number | null;
  limitKmh: number | null;
  /**
   * True when the measure holds for both directions of the road. Rennes draws each line in its
   * direction of travel (a `_D`/`_G` pair per two-way road); Grenoble's drawing direction is not
   * reliable, so its level applies to both directions.
   */
  bothDirections: boolean;
}

export interface ProviderSnapshot {
  segments: FlowSegment[];
  fetchedAt: Date;
  /** Served from the last good answer because the source failed. */
  stale: boolean;
}

export interface OpenFlowProvider {
  readonly id: OpenFlowSourceId;
  readonly attribution: string;
  /** The area the source covers: a view elsewhere never triggers an upstream call. */
  readonly coverage: Bbox;
  snapshot(): Promise<ProviderSnapshot>;
}

/** Keeps `[lon, lat]` pairs of finite numbers; null when fewer than two remain valid. */
export function lineCoordinates(value: unknown): [number, number][] | null {
  if (!Array.isArray(value)) return null;
  const points: [number, number][] = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length < 2) return null;
    const [lon, lat] = point as unknown[];
    if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
    points.push([lon, lat]);
  }
  return points.length >= 2 ? points : null;
}
