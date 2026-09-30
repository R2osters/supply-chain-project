import { describe, expect, it } from 'vitest';
import type { Road } from '@/lib/traffic/roads';
import {
  flowLinesFromOpenFlow,
  flowLinesFromTomTom,
  measuredSourcesOf,
  openFlowBboxKey,
  roadsInView,
  type OpenFlowCollection,
} from './road-traffic';

const line = (coordinates: [number, number][]) => ({ type: 'LineString', coordinates });

describe('flowLinesFromOpenFlow', () => {
  it('keeps measured or closed lines with their direction rule', () => {
    const collection: OpenFlowCollection = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: line([[-1.6, 48.1], [-1.59, 48.1]]) as never, properties: { id: 'rennes:a', source: 'rennes', level: 0.4, closed: false, bothDirections: false } },
        { type: 'Feature', geometry: line([[5.7, 45.1], [5.71, 45.1]]) as never, properties: { id: 'grenoble:b', source: 'grenoble', level: 0, closed: true, bothDirections: true } },
        { type: 'Feature', geometry: line([[-1.6, 48.2], [-1.59, 48.2]]) as never, properties: { id: 'rennes:c', source: 'rennes', level: null, closed: false, bothDirections: false } },
      ],
    };
    expect(flowLinesFromOpenFlow(collection)).toEqual([
      { coordinates: [[-1.6, 48.1], [-1.59, 48.1]], level: 0.4, closed: false, bothDirections: false, source: 'rennes' },
      { coordinates: [[5.7, 45.1], [5.71, 45.1]], level: 0, closed: true, bothDirections: true, source: 'grenoble' },
    ]);
  });

  it('survives a missing or malformed answer', () => {
    expect(flowLinesFromOpenFlow(undefined)).toEqual([]);
    expect(flowLinesFromOpenFlow({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: null as never, properties: {} as never }] })).toEqual([]);
  });
});

describe('flowLinesFromTomTom', () => {
  it('reads traffic_level, closures in either spelling and both-direction coverage', () => {
    const lines = flowLinesFromTomTom([
      { properties: { traffic_level: 0.3, traffic_road_coverage: 'one_side' }, geometry: line([[0, 0], [0.01, 0]]) },
      { properties: { traffic_level: 0.9, traffic_road_coverage: 'full' }, geometry: { type: 'MultiLineString', coordinates: [[[1, 1], [1.01, 1]], [[2, 2], [2.01, 2]]] } },
      { properties: { road_closure: 'true' }, geometry: line([[3, 3], [3.01, 3]]) },
      { properties: { traffic_level: 'n/a' }, geometry: line([[4, 4], [4.01, 4]]) },
      { properties: { traffic_level: '' }, geometry: line([[5, 5], [5.01, 5]]) },
      { properties: { traffic_level: null }, geometry: line([[6, 6], [6.01, 6]]) },
      { properties: {}, geometry: line([[7, 7], [7.01, 7]]) },
    ]);
    expect(lines).toEqual([
      { coordinates: [[0, 0], [0.01, 0]], level: 0.3, closed: false, bothDirections: false, source: 'tomtom' },
      { coordinates: [[1, 1], [1.01, 1]], level: 0.9, closed: false, bothDirections: true, source: 'tomtom' },
      { coordinates: [[2, 2], [2.01, 2]], level: 0.9, closed: false, bothDirections: true, source: 'tomtom' },
      { coordinates: [[3, 3], [3.01, 3]], level: 0, closed: true, bothDirections: false, source: 'tomtom' },
    ]);
  });
});

describe('flowLinesFromTomTom bounds', () => {
  it('clamps levels into 0..1', () => {
    const [high, low] = flowLinesFromTomTom([
      { properties: { traffic_level: 1.4 }, geometry: line([[0, 0], [1, 0]]) },
      { properties: { traffic_level: -0.2 }, geometry: line([[0, 0], [1, 0]]) },
    ]);
    expect([high.level, low.level]).toEqual([1, 0]);
  });
});

describe('measuredSourcesOf', () => {
  it('lists each source once, in a stable order', () => {
    const lines = flowLinesFromTomTom([{ properties: { traffic_level: 0.5 }, geometry: line([[0, 0], [1, 0]]) }]);
    expect(
      measuredSourcesOf([
        ...lines,
        { coordinates: [[0, 0], [1, 0]], level: 0.9, closed: false, bothDirections: false, source: 'rennes' },
        { coordinates: [[0, 0], [1, 0]], level: 0.2, closed: false, bothDirections: false, source: 'rennes' },
      ]),
    ).toEqual(['rennes', 'tomtom']);
  });
});

describe('roadsInView', () => {
  const road = (id: string, coordinates: [number, number][]): Road => ({
    id,
    roadClass: 'primary',
    coordinates,
    oneway: 0,
    freeSpeedKmh: 70,
    densityWeight: 0.6,
    lengthM: 100,
  });

  it('keeps roads touching the view plus a margin', () => {
    const view = { west: 0, south: 0, east: 1, north: 1 };
    const roads = [road('in', [[0.5, 0.5], [0.6, 0.5]]), road('margin', [[1.1, 0.5], [1.15, 0.5]]), road('far', [[3, 3], [3.1, 3]])];
    expect(roadsInView(roads, view).map((r) => r.id)).toEqual(['in', 'margin']);
  });
});

describe('openFlowBboxKey', () => {
  it('rounds the view outward to 0.05° so small pans reuse the answer', () => {
    expect(openFlowBboxKey({ west: -1.712, south: 48.061, east: -1.588, north: 48.139 })).toBe('-1.75,48.05,-1.55,48.15');
  });

  it('asks nothing for a view wider than the API accepts', () => {
    expect(openFlowBboxKey({ west: -10, south: 40, east: 0, north: 50 })).toBeNull();
  });
});
