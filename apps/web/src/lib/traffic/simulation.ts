/**
 * Simulated road traffic: dots driving along real roads at plausible speeds.
 *
 * No public source gives the position of every car, so general traffic is simulated (as in
 * God's Eye View); what is real is the measured level of the roads that have one, which sets
 * each direction's colour, speed and density. Each circulated direction of a road is a lane
 * whose dots advance along the polyline at the road's free speed, scaled by the measured level,
 * with ±15 % per dot, and loop back to the start at the end.
 *
 * Dot counts are length × class weight × zoom factor × congestion density / 80, rounded by
 * stable dithering: OSM splits streets at every junction, so a 40 m side street expects a
 * fraction of a dot, and plain rounding would empty every short street on the map. Each lane
 * rounds up with a probability equal to that fraction, drawn from a hash of its id, so the
 * total is right on average and a lane keeps its count from one map move to the next.
 *
 * Pure and map-free: the traffic layer calls `step` each frame and draws `forEachDot`.
 */

import { flowBucket, flowDensityMult, flowSpeedScale, type FlowBucket } from './flow-level';
import type { DirectionalFlow, RoadFlow } from './flow-match';
import { lengthM, type Road } from './roads';

export interface SimulationOptions {
  maxDots?: number;
  random?: () => number;
}

const DEFAULT_MAX_DOTS = 6_000;
/** Metres of road per dot on a weight-1 road at zoom 14. */
const METRES_PER_DOT = 80;
const SPEED_JITTER_MIN = 0.85;
const SPEED_JITTER_RANGE = 0.3;

interface Dot {
  /** Distance from the start of the polyline, in drawing order. */
  offset: number;
  /** Per-dot speed factor, kept when the road's measured level changes. */
  jitter: number;
}

interface Lane {
  key: string;
  coordinates: [number, number][];
  /** Cumulative length at each vertex; the last value is the lane length. */
  cumulative: number[];
  length: number;
  /** +1 along the drawing order, -1 against it. */
  direction: 1 | -1;
  speedMs: number;
  bucket: FlowBucket | null;
  weight: number;
  dots: Dot[];
}

function cumulativeLengths(coordinates: [number, number][]): number[] {
  const cumulative = [0];
  for (let i = 1; i < coordinates.length; i++) {
    cumulative.push(cumulative[i - 1] + lengthM([coordinates[i - 1], coordinates[i]]));
  }
  return cumulative;
}

/** FNV-1a, mapped to [0, 1): a stable pseudo-random draw per lane. */
function stableFraction(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 2 ** 32;
}

function ditheredCount(expected: number, key: string): number {
  if (!(expected > 0)) return 0;
  const whole = Math.floor(expected + 1e-9);
  const fraction = expected - whole;
  return whole + (fraction > 1e-9 && stableFraction(key) < fraction ? 1 : 0);
}

function zoomFactor(zoom: number): number {
  return Math.min(2, Math.max(0.25, 2 ** (zoom - 14)));
}

function wrap(offset: number, length: number): number {
  const wrapped = offset % length;
  return wrapped < 0 ? wrapped + length : wrapped;
}

export class TrafficSimulation {
  private readonly maxDots: number;
  private readonly random: () => number;
  private lanes: Lane[] = [];
  private total = 0;

  constructor(options: SimulationOptions = {}) {
    this.maxDots = options.maxDots ?? DEFAULT_MAX_DOTS;
    this.random = options.random ?? Math.random;
  }

  get dotCount(): number {
    return this.total;
  }

  setRoads(roads: Road[], flows: Map<string, DirectionalFlow>, zoom: number): void {
    const previous = new Map(this.lanes.map((lane) => [lane.key, lane]));
    const factor = zoomFactor(zoom);
    const planned: { lane: Lane; wanted: number }[] = [];

    for (const road of roads) {
      const flow = flows.get(road.id);
      if (road.oneway !== -1) this.plan(planned, previous, road, 1, flow?.forward ?? null, factor);
      if (road.oneway !== 1) this.plan(planned, previous, road, -1, flow?.backward ?? null, factor);
    }

    // Major roads first, so the cap thins side streets before motorways.
    planned.sort((a, b) => b.lane.weight - a.lane.weight);
    let budget = this.maxDots;
    this.lanes = [];
    this.total = 0;
    for (const { lane, wanted } of planned) {
      const count = Math.min(wanted, budget);
      if (count <= 0) continue;
      budget -= count;
      if (lane.dots.length > count) lane.dots.length = count;
      while (lane.dots.length < count) {
        lane.dots.push({
          offset: this.random() * lane.length,
          jitter: SPEED_JITTER_MIN + SPEED_JITTER_RANGE * this.random(),
        });
      }
      this.lanes.push(lane);
      this.total += count;
    }
  }

  step(dtSeconds: number): void {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    for (const lane of this.lanes) {
      const distance = lane.direction * lane.speedMs * dtSeconds;
      for (const dot of lane.dots) {
        dot.offset = wrap(dot.offset + distance * dot.jitter, lane.length);
      }
    }
  }

  forEachDot(visit: (lon: number, lat: number, bucket: FlowBucket | null) => void): void {
    for (const lane of this.lanes) {
      for (const dot of lane.dots) {
        const [lon, lat] = this.positionOf(lane, dot.offset);
        visit(lon, lat, lane.bucket);
      }
    }
  }

  private plan(
    planned: { lane: Lane; wanted: number }[],
    previous: Map<string, Lane>,
    road: Road,
    direction: 1 | -1,
    flow: RoadFlow | null,
    factor: number,
  ): void {
    const key = `${road.id}:${direction === 1 ? 'f' : 'b'}`;
    const level = flow?.level ?? null;
    const wanted = flow?.closed
      ? 0
      : ditheredCount((road.lengthM * road.densityWeight * factor * flowDensityMult(level)) / METRES_PER_DOT, key);

    const kept = previous.get(key);
    const cumulative = kept?.coordinates === road.coordinates ? kept.cumulative : cumulativeLengths(road.coordinates);
    const length = cumulative[cumulative.length - 1];
    if (!(length > 0)) return;

    const dots = kept?.dots ?? [];
    if (kept && kept.length !== length) {
      for (const dot of dots) dot.offset = wrap(dot.offset, length);
    }
    planned.push({
      lane: {
        key,
        coordinates: road.coordinates,
        cumulative,
        length,
        direction,
        speedMs: (road.freeSpeedKmh / 3.6) * flowSpeedScale(level),
        bucket: flowBucket(level),
        weight: road.densityWeight,
        dots,
      },
      wanted,
    });
  }

  private positionOf(lane: Lane, offset: number): [number, number] {
    const { cumulative, coordinates } = lane;
    let low = 0;
    let high = cumulative.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (cumulative[middle] <= offset) low = middle;
      else high = middle;
    }
    const span = cumulative[high] - cumulative[low];
    const t = span > 0 ? (offset - cumulative[low]) / span : 0;
    const [lon1, lat1] = coordinates[low];
    const [lon2, lat2] = coordinates[high];
    return [lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t];
  }
}
