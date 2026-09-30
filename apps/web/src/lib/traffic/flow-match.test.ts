import { describe, expect, it } from 'vitest';
import { matchFlow, type FlowLine, type FlowSource } from './flow-match';
import { lengthM, type Road } from './roads';

// Local frame near Rennes: metres east / north of an origin, converted to [lon, lat].
const ORIGIN_LON = -1.68;
const ORIGIN_LAT = 48.11;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((ORIGIN_LAT * Math.PI) / 180);

function at(eastM: number, northM: number): [number, number] {
  return [ORIGIN_LON + eastM / M_PER_DEG_LON, ORIGIN_LAT + northM / M_PER_DEG_LAT];
}

function road(id: string, coordinates: [number, number][], oneway: 0 | 1 | -1 = 0): Road {
  return {
    id,
    roadClass: 'primary',
    coordinates,
    oneway,
    freeSpeedKmh: 70,
    densityWeight: 0.6,
    lengthM: lengthM(coordinates),
  };
}

function flow(
  coordinates: [number, number][],
  level: number | null,
  extra: Partial<Pick<FlowLine, 'closed' | 'bothDirections' | 'source'>> = {},
): FlowLine {
  return {
    coordinates,
    level,
    closed: extra.closed ?? false,
    bothDirections: extra.bothDirections ?? false,
    source: extra.source ?? ('rennes' as FlowSource),
  };
}

// A 200 m two-way road drawn west → east.
const EAST = road('east', [at(0, 0), at(200, 0)]);

describe('matchFlow', () => {
  it('gives a road the level of a measurement drawn along it, in the same direction', () => {
    const flows = matchFlow([EAST], [flow([at(0, 5), at(200, 5)], 0.4)]);
    expect(flows.get('east')).toEqual({
      forward: { level: 0.4, closed: false, source: 'rennes' },
      backward: null,
    });
  });

  it('puts a measurement drawn the other way on the backward direction', () => {
    const flows = matchFlow([EAST], [flow([at(200, -5), at(0, -5)], 0.7)]);
    expect(flows.get('east')).toEqual({
      forward: null,
      backward: { level: 0.7, closed: false, source: 'rennes' },
    });
  });

  it('applies a measurement covering both directions to both', () => {
    const flows = matchFlow(
      [EAST],
      [flow([at(200, 3), at(0, 3)], 0.9, { bothDirections: true, source: 'grenoble' })],
    );
    expect(flows.get('east')).toEqual({
      forward: { level: 0.9, closed: false, source: 'grenoble' },
      backward: { level: 0.9, closed: false, source: 'grenoble' },
    });
  });

  it('splits a dual carriageway: each direction takes the nearest line going its way', () => {
    // Rennes publishes `_D` and `_G` as two lines about 12 m apart, each drawn in its own
    // direction; OSM may draw the same street once, down the middle.
    const flows = matchFlow(
      [EAST],
      [flow([at(0, -6), at(200, -6)], 0.3), flow([at(200, 6), at(0, 6)], 0.95)],
    );
    expect(flows.get('east')?.forward?.level).toBe(0.3);
    expect(flows.get('east')?.backward?.level).toBe(0.95);
  });

  it('ignores a crossing street and a parallel line too far away', () => {
    const flows = matchFlow(
      [EAST],
      [flow([at(100, -150), at(100, 150)], 0.2), flow([at(0, 40), at(200, 40)], 0.2)],
    );
    expect(flows.has('east')).toBe(false);
  });

  it('accepts a slight bend but not a turn beyond the heading tolerance', () => {
    const bent = matchFlow([EAST], [flow([at(0, -10), at(200, 10)], 0.5)]);
    expect(bent.get('east')?.forward?.level).toBe(0.5);
    // 45° off, crossing the road: close to it only near the crossing, and at the wrong heading.
    const turned = matchFlow([EAST], [flow([at(80, -20), at(120, 20)], 0.5)]);
    expect(turned.has('east')).toBe(false);
  });

  it('measures a direction only when at least 40 % of its samples match', () => {
    // Samples every 20 m (10, 30 … 190); the 25 m radius reaches one sample past each end.
    const threeOfTen = matchFlow([EAST], [flow([at(0, 2), at(40, 2)], 0.5)]);
    expect(threeOfTen.has('east')).toBe(false);
    const fourOfTen = matchFlow([EAST], [flow([at(0, 2), at(60, 2)], 0.5)]);
    expect(fourOfTen.get('east')?.forward?.level).toBe(0.5);
  });

  it('takes the median level and the majority source along the road', () => {
    const flows = matchFlow(
      [EAST],
      [
        flow([at(0, 2), at(66, 2)], 0.2, { source: 'tomtom' }),
        flow([at(67, 2), at(133, 2)], 0.9, { source: 'rennes' }),
        flow([at(134, 2), at(200, 2)], 0.6, { source: 'rennes' }),
      ],
    );
    expect(flows.get('east')?.forward).toEqual({ level: 0.6, closed: false, source: 'rennes' });
  });

  it('marks a direction closed when most of it is closed, even without a level', () => {
    const flows = matchFlow(
      [EAST],
      [flow([at(0, 2), at(150, 2)], null, { closed: true }), flow([at(151, 2), at(200, 2)], 0.8)],
    );
    expect(flows.get('east')?.forward).toEqual({ level: 0.8, closed: true, source: 'rennes' });
  });

  it('skips lines with neither a level nor a closure, and unusable levels', () => {
    const flows = matchFlow(
      [EAST],
      [flow([at(0, 2), at(200, 2)], null), flow([at(0, 3), at(200, 3)], Number.NaN)],
    );
    expect(flows.has('east')).toBe(false);
  });

  it('matches a short road with a single sample, and several roads at once', () => {
    const short = road('short', [at(0, 0), at(8, 0)]);
    const north = road('north', [at(500, 0), at(500, 200)], 1);
    const flows = matchFlow(
      [short, north, EAST],
      [flow([at(-10, 1), at(20, 1)], 0.5), flow([at(502, 0), at(502, 200)], 0.1)],
    );
    expect(flows.get('short')?.forward?.level).toBe(0.5);
    expect(flows.get('north')?.forward?.level).toBe(0.1);
    expect(flows.has('east')).toBe(false);
  });

  it('honours custom radius, sampling and heading options', () => {
    const lines = [flow([at(0, 30), at(200, 30)], 0.5)];
    expect(matchFlow([EAST], lines).has('east')).toBe(false);
    expect(matchFlow([EAST], lines, { radiusM: 35 }).get('east')?.forward?.level).toBe(0.5);
    const skew = [flow([at(0, -30), at(200, 30)], 0.5)]; // about 17° off
    expect(matchFlow([EAST], skew, { radiusM: 35, maxBearingDeg: 10 }).has('east')).toBe(false);
    expect(matchFlow([EAST], skew, { radiusM: 35, sampleM: 5 }).get('east')?.forward?.level).toBe(0.5);
  });

  it('returns nothing when there are no measurements', () => {
    expect(matchFlow([EAST], []).size).toBe(0);
  });
});
