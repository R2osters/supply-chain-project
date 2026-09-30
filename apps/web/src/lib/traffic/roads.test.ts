import { describe, expect, it } from 'vitest';
import { lengthM, roadsFromFeatures, type TransportationFeature } from './roads';

function line(
  cls: string,
  coordinates: [number, number][],
  extra: Record<string, unknown> = {},
): TransportationFeature {
  return { properties: { class: cls, ...extra }, geometry: { type: 'LineString', coordinates } };
}

const A: [number, number] = [-0.187, 5.6037];
const B: [number, number] = [-0.186, 5.6037];
const C: [number, number] = [-0.186, 5.6047];

describe('lengthM', () => {
  it('measures about 111 m per thousandth of a degree of latitude', () => {
    expect(lengthM([[0, 0], [0, 0.001]])).toBeCloseTo(111.2, 0);
  });

  it('sums every segment and is 0 for a single point', () => {
    expect(lengthM([[0, 0], [0, 0.001], [0, 0.002]])).toBeCloseTo(222.4, 0);
    expect(lengthM([[0, 0]])).toBe(0);
  });
});

describe('roadsFromFeatures', () => {
  it('keeps drivable classes with their free speed and density weight', () => {
    const classes = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor'];
    const roads = roadsFromFeatures(
      classes.map((cls, i) => line(cls, [A, [B[0], B[1] + i * 0.001]])),
      14,
    );
    expect(roads.map((road) => [road.roadClass, road.freeSpeedKmh, road.densityWeight])).toEqual([
      ['motorway', 110, 1],
      ['trunk', 90, 0.8],
      ['primary', 70, 0.6],
      ['secondary', 60, 0.45],
      ['tertiary', 50, 0.3],
      ['minor', 40, 0.12],
    ]);
  });

  it('adds service roads only from zoom 15', () => {
    const service = [line('service', [A, B])];
    expect(roadsFromFeatures(service, 14.9)).toEqual([]);
    expect(roadsFromFeatures(service, 15)).toHaveLength(1);
    expect(roadsFromFeatures(service, 15)[0]).toMatchObject({ freeSpeedKmh: 20, densityWeight: 0.05 });
  });

  it('drops paths, rail, ferries and anything it does not know', () => {
    const excluded = ['path', 'track', 'rail', 'transit', 'ferry', 'raceway', 'busway', 'bridleway', 'pier', 'aerialway', 'toString', 'constructor', undefined];
    expect(roadsFromFeatures(excluded.map((cls) => line(cls as string, [A, B])), 18)).toEqual([]);
    expect(roadsFromFeatures([{ properties: null, geometry: { type: 'LineString', coordinates: [A, B] } }], 18)).toEqual([]);
  });

  it('reads one-way roads in both directions and treats anything else as two-way', () => {
    const roads = roadsFromFeatures(
      [
        line('primary', [A, B], { oneway: 1 }),
        line('primary', [B, C], { oneway: -1 }),
        line('primary', [A, C], { oneway: 0 }),
        line('primary', [C, A]),
      ],
      14,
    );
    expect(roads.map((road) => road.oneway)).toEqual([1, -1, 0, 0]);
  });

  it('splits a MultiLineString into one road per line and skips degenerate lines', () => {
    const roads = roadsFromFeatures(
      [
        {
          properties: { class: 'secondary' },
          geometry: { type: 'MultiLineString', coordinates: [[A, B], [B, C], [C]] },
        },
        { properties: { class: 'secondary' }, geometry: { type: 'Point', coordinates: A } },
        line('secondary', [A, A]),
      ],
      14,
    );
    expect(roads.map((road) => road.coordinates)).toEqual([[A, B], [B, C]]);
  });

  it('removes the copies of a road that several tiles return, with a stable id', () => {
    const first = roadsFromFeatures([line('primary', [A, B, C]), line('primary', [A, B, C])], 14);
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe('primary:-0.187000,5.603700:-0.186000,5.604700:3');
    const again = roadsFromFeatures([line('primary', [A, B, C])], 16);
    expect(again[0].id).toBe(first[0].id);
  });

  it('ignores invalid coordinates and repeated points', () => {
    const roads = roadsFromFeatures(
      [line('minor', [A, A, [Number.NaN, 1] as [number, number], B, B, C])],
      14,
    );
    expect(roads[0].coordinates).toEqual([A, B, C]);
    expect(roads[0].lengthM).toBeCloseTo(lengthM([A, B, C]), 6);
  });
});
