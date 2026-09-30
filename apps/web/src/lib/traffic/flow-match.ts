/**
 * Which OpenStreetMap roads carry a traffic measurement, and in which direction.
 *
 * Measurements (Rennes, Grenoble, TomTom) come as their own polylines, which never share
 * vertices with the OSM roads the simulation drives on. Each road is sampled every `sampleM`
 * metres; a sample takes the nearest measured segment within `radiusM` whose heading agrees
 * with the road's (forward) or opposes it (backward). A direction counts as measured when at
 * least 40 % of the road's samples found a segment, which tolerates gaps at junctions without
 * letting a measurement bleed onto the next street.
 *
 * The nearest segment is chosen per direction, not overall: on a dual carriageway published as
 * two lines 12 m apart (Rennes `_D` / `_G`), a two-way OSM road drawn down the middle takes
 * each direction's level from its own carriageway.
 *
 * Geometry runs in Web Mercator, which keeps headings true; a projected distance times
 * cos(latitude) is metres at street scale. Coordinates are always [lon, lat].
 */

import type { Road } from './roads';

export type FlowSource = 'rennes' | 'grenoble' | 'tomtom';

export interface FlowLine {
  coordinates: [number, number][];
  level: number | null;
  closed: boolean;
  /** The measurement applies to both directions, whatever the drawing order. */
  bothDirections: boolean;
  source: FlowSource;
}

export interface RoadFlow {
  level: number | null;
  closed: boolean;
  source: FlowSource;
}

/** `forward` is the road's drawing order. */
export interface DirectionalFlow {
  forward: RoadFlow | null;
  backward: RoadFlow | null;
}

export interface MatchOptions {
  sampleM?: number;
  radiusM?: number;
  maxBearingDeg?: number;
}

const DEFAULT_SAMPLE_M = 20;
const DEFAULT_RADIUS_M = 25;
const DEFAULT_MAX_BEARING_DEG = 35;
const MIN_COVERAGE = 0.4;

const MERCATOR_RADIUS_M = 6_378_137;
const MAX_LAT = 85.051129;
const DEG = Math.PI / 180;
/** Offsets that keep grid cell keys unique integers (cells are at least 10 m wide). */
const CELL_OFFSET = 2 ** 22;
const CELL_STRIDE = 2 ** 23;

interface Segment {
  ax: number;
  ay: number;
  dx: number;
  dy: number;
  len2: number;
  line: FlowLine;
}

interface Sample {
  x: number;
  y: number;
  /** Unit heading of the road at the sample, in projected coordinates. */
  ux: number;
  uy: number;
  cosLat: number;
}

function project(lon: number, lat: number): [number, number] {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  return [
    MERCATOR_RADIUS_M * lon * DEG,
    MERCATOR_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2)),
  ];
}

function isUsable(line: FlowLine): boolean {
  const hasLevel = typeof line.level === 'number' && Number.isFinite(line.level);
  return (hasLevel || line.closed) && Array.isArray(line.coordinates) && line.coordinates.length >= 2;
}

class SegmentGrid {
  private readonly cells = new Map<number, Segment[]>();

  constructor(private readonly cellSize: number) {}

  get isEmpty(): boolean {
    return this.cells.size === 0;
  }

  add(line: FlowLine): void {
    let previous: [number, number] | null = null;
    for (const [lon, lat] of line.coordinates) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const point = project(lon, lat);
      if (previous) this.addSegment(previous, point, line);
      previous = point;
    }
  }

  /** Long segments are cut to cell size, so each piece touches at most four cells. */
  private addSegment([ax, ay]: [number, number], [bx, by]: [number, number], line: FlowLine): void {
    const length = Math.hypot(bx - ax, by - ay);
    if (length === 0) return;
    const pieces = Math.ceil(length / this.cellSize);
    for (let i = 0; i < pieces; i++) {
      const x0 = ax + ((bx - ax) * i) / pieces;
      const y0 = ay + ((by - ay) * i) / pieces;
      const x1 = ax + ((bx - ax) * (i + 1)) / pieces;
      const y1 = ay + ((by - ay) * (i + 1)) / pieces;
      const segment: Segment = {
        ax: x0,
        ay: y0,
        dx: x1 - x0,
        dy: y1 - y0,
        len2: (x1 - x0) ** 2 + (y1 - y0) ** 2,
        line,
      };
      for (let cx = this.cell(Math.min(x0, x1)); cx <= this.cell(Math.max(x0, x1)); cx++) {
        for (let cy = this.cell(Math.min(y0, y1)); cy <= this.cell(Math.max(y0, y1)); cy++) {
          const key = this.key(cx, cy);
          const bucket = this.cells.get(key);
          if (bucket) bucket.push(segment);
          else this.cells.set(key, [segment]);
        }
      }
    }
  }

  /** Nearest segment going the road's way, and nearest going against it, within `radius`. */
  nearest(sample: Sample, radiusM: number, cosMax: number): { forward: FlowLine | null; backward: FlowLine | null } {
    const radius = radiusM / sample.cosLat;
    let forward: FlowLine | null = null;
    let backward: FlowLine | null = null;
    let forwardDist = radius;
    let backwardDist = radius;
    for (let cx = this.cell(sample.x - radius); cx <= this.cell(sample.x + radius); cx++) {
      for (let cy = this.cell(sample.y - radius); cy <= this.cell(sample.y + radius); cy++) {
        const bucket = this.cells.get(this.key(cx, cy));
        if (!bucket) continue;
        for (const segment of bucket) {
          const distance = distanceTo(sample, segment);
          if (distance >= forwardDist && distance >= backwardDist) continue;
          const cos = (sample.ux * segment.dx + sample.uy * segment.dy) / Math.sqrt(segment.len2);
          const along = segment.line.bothDirections ? Math.abs(cos) > cosMax : cos > cosMax;
          const against = segment.line.bothDirections ? Math.abs(cos) > cosMax : cos < -cosMax;
          if (along && distance < forwardDist) {
            forward = segment.line;
            forwardDist = distance;
          }
          if (against && distance < backwardDist) {
            backward = segment.line;
            backwardDist = distance;
          }
        }
      }
    }
    return { forward, backward };
  }

  private cell(value: number): number {
    return Math.floor(value / this.cellSize);
  }

  private key(cx: number, cy: number): number {
    return (cx + CELL_OFFSET) * CELL_STRIDE + (cy + CELL_OFFSET);
  }
}

function distanceTo(sample: Sample, segment: Segment): number {
  const t = Math.max(
    0,
    Math.min(1, ((sample.x - segment.ax) * segment.dx + (sample.y - segment.ay) * segment.dy) / segment.len2),
  );
  return Math.hypot(sample.x - (segment.ax + t * segment.dx), sample.y - (segment.ay + t * segment.dy));
}

/** Evenly spaced samples, centred in their stretch, so even a short road gets one. */
function sampleRoad(road: Road, sampleM: number): Sample[] {
  const points: [number, number][] = [];
  const cosLats: number[] = [];
  for (const [lon, lat] of road.coordinates) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    points.push(project(lon, lat));
    cosLats.push(Math.cos(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * DEG));
  }
  const steps: { from: number; metres: number }[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const projected = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    if (projected === 0) continue;
    const metres = projected * ((cosLats[i - 1] + cosLats[i]) / 2);
    steps.push({ from: i - 1, metres });
    total += metres;
  }
  if (total === 0) return [];

  const count = Math.max(1, Math.round(total / sampleM));
  const samples: Sample[] = [];
  let step = 0;
  let stepStart = 0;
  for (let k = 0; k < count; k++) {
    const target = ((k + 0.5) * total) / count;
    while (step < steps.length - 1 && stepStart + steps[step].metres < target) {
      stepStart += steps[step].metres;
      step++;
    }
    const { from, metres } = steps[step];
    const t = Math.min(1, (target - stepStart) / metres);
    const [ax, ay] = points[from];
    const [bx, by] = points[from + 1];
    const length = Math.hypot(bx - ax, by - ay);
    samples.push({
      x: ax + (bx - ax) * t,
      y: ay + (by - ay) * t,
      ux: (bx - ax) / length,
      uy: (by - ay) / length,
      cosLat: cosLats[from] + (cosLats[from + 1] - cosLats[from]) * t,
    });
  }
  return samples;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarise(hits: FlowLine[], sampleCount: number): RoadFlow | null {
  if (hits.length === 0 || hits.length < MIN_COVERAGE * sampleCount - 1e-9) return null;
  const levels: number[] = [];
  let closed = 0;
  const sources = new Map<FlowSource, number>();
  for (const hit of hits) {
    if (typeof hit.level === 'number' && Number.isFinite(hit.level)) levels.push(hit.level);
    if (hit.closed) closed++;
    sources.set(hit.source, (sources.get(hit.source) ?? 0) + 1);
  }
  let source = hits[0].source;
  for (const [candidate, count] of sources) {
    if (count > (sources.get(source) ?? 0)) source = candidate;
  }
  return { level: median(levels), closed: closed > hits.length / 2, source };
}

export function matchFlow(
  roads: Road[],
  lines: FlowLine[],
  options: MatchOptions = {},
): Map<string, DirectionalFlow> {
  const sampleM = options.sampleM ?? DEFAULT_SAMPLE_M;
  const radiusM = options.radiusM ?? DEFAULT_RADIUS_M;
  const cosMax = Math.cos((options.maxBearingDeg ?? DEFAULT_MAX_BEARING_DEG) * DEG);
  const result = new Map<string, DirectionalFlow>();

  const grid = new SegmentGrid(Math.max(10, 2 * radiusM));
  for (const line of lines) {
    if (isUsable(line)) grid.add(line);
  }
  if (grid.isEmpty) return result;

  for (const road of roads) {
    const samples = sampleRoad(road, sampleM);
    if (samples.length === 0) continue;
    const forwardHits: FlowLine[] = [];
    const backwardHits: FlowLine[] = [];
    for (const sample of samples) {
      const { forward, backward } = grid.nearest(sample, radiusM, cosMax);
      if (forward) forwardHits.push(forward);
      if (backward) backwardHits.push(backward);
    }
    const forward = summarise(forwardHits, samples.length);
    const backward = summarise(backwardHits, samples.length);
    if (forward || backward) result.set(road.id, { forward, backward });
  }
  return result;
}
