/**
 * Map-free helpers of the live map's road traffic: turning the measurement sources into
 * `FlowLine`s, keeping the roads of the current view, and the box the measurements are asked for.
 */

import type { FlowLine, FlowSource } from '@/lib/traffic/flow-match';
import type { Road } from '@/lib/traffic/roads';

/** Dots from here (a city); below, a region would mean tens of thousands of roads. */
export const DOTS_MIN_ZOOM = 12;
/** Measured lines from here. */
export const LINES_MIN_ZOOM = 10;
/** The API refuses wider boxes (`/traffic/open-flow`). */
const MAX_BBOX_SPAN_DEG = 5;
const BBOX_STEP_DEG = 0.05;

export interface View {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface OpenFlowCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: string; coordinates: unknown } | null;
    properties: {
      id?: string;
      source?: string;
      level?: number | null;
      closed?: boolean;
      bothDirections?: boolean;
    } | null;
  }>;
}

/** A vector-tile feature as `querySourceFeatures` returns it, without importing maplibre-gl. */
export interface TileFeature {
  properties: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown } | null;
}

function linesOf(geometry: TileFeature['geometry']): [number, number][][] {
  if (!geometry) return [];
  const raw = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (candidate): candidate is [number, number][] =>
      Array.isArray(candidate) &&
      candidate.length >= 2 &&
      candidate.every((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])),
  );
}

const isSource = (value: unknown): value is 'rennes' | 'grenoble' => value === 'rennes' || value === 'grenoble';

/** `/traffic/open-flow` answer → lines that carry a measure (a level, or a closure). */
export function flowLinesFromOpenFlow(collection: OpenFlowCollection | undefined): FlowLine[] {
  const lines: FlowLine[] = [];
  for (const feature of collection?.features ?? []) {
    const properties = feature.properties;
    if (!properties || !isSource(properties.source)) continue;
    const level = typeof properties.level === 'number' && Number.isFinite(properties.level) ? properties.level : null;
    const closed = properties.closed === true;
    if (level === null && !closed) continue;
    for (const coordinates of linesOf(feature.geometry)) {
      lines.push({ coordinates, level, closed, bothDirections: properties.bothDirections === true, source: properties.source });
    }
  }
  return lines;
}

/**
 * TomTom "Traffic flow" features → lines. `traffic_level` is current / free-flow speed; a closed
 * road may come without a level; `full` coverage describes both directions of the road, `one_side`
 * the direction the line is drawn in. Adapted from God's Eye View (MIT), layers/traffic/flowDecode.js.
 */
export function flowLinesFromTomTom(features: TileFeature[]): FlowLine[] {
  const lines: FlowLine[] = [];
  for (const feature of features) {
    const properties = feature.properties ?? {};
    const closed = properties.road_closure === true || properties.road_closure === 'true';
    const raw = Number(properties.traffic_level);
    const level = closed ? 0 : properties.traffic_level !== undefined && Number.isFinite(raw) ? raw : null;
    if (level === null) continue;
    const bothDirections = properties.traffic_road_coverage === 'full';
    for (const coordinates of linesOf(feature.geometry)) {
      lines.push({ coordinates, level, closed, bothDirections, source: 'tomtom' });
    }
  }
  return lines;
}

const SOURCE_ORDER: FlowSource[] = ['rennes', 'grenoble', 'tomtom'];

/** The sources that measured something among `lines`, each once. */
export function measuredSourcesOf(lines: FlowLine[]): FlowSource[] {
  const seen = new Set(lines.map((line) => line.source));
  return SOURCE_ORDER.filter((source) => seen.has(source));
}

/** Roads with a vertex in the view grown by `margin` of its size: tiles also hold roads far off-screen. */
export function roadsInView(roads: Road[], view: View, margin = 0.2): Road[] {
  const dx = (view.east - view.west) * margin;
  const dy = (view.north - view.south) * margin;
  const west = view.west - dx;
  const east = view.east + dx;
  const south = view.south - dy;
  const north = view.north + dy;
  return roads.filter((road) => road.coordinates.some(([lon, lat]) => lon >= west && lon <= east && lat >= south && lat <= north));
}

const round = (value: number, towards: 'down' | 'up') =>
  Number(((towards === 'down' ? Math.floor(value / BBOX_STEP_DEG) : Math.ceil(value / BBOX_STEP_DEG)) * BBOX_STEP_DEG).toFixed(2));

/** The measurement request box: the view rounded outward to 0.05°, or null when too wide. */
export function openFlowBboxKey(view: View): string | null {
  const west = Math.max(-180, round(view.west, 'down'));
  const south = Math.max(-90, round(view.south, 'down'));
  const east = Math.min(180, round(view.east, 'up'));
  const north = Math.min(90, round(view.north, 'up'));
  if (east - west > MAX_BBOX_SPAN_DEG || north - south > MAX_BBOX_SPAN_DEG) return null;
  return `${west},${south},${east},${north}`;
}
