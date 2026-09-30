import { describe, expect, it } from 'vitest';
import { FLOATS_PER_DOT, hexToRgba, mercator, packDots, trafficColours, translateMatrix, type DotSource } from './road-traffic-layer';

const COLOURS = {
  none: [0.5, 0.5, 0.5, 0.5],
  free: [0, 1, 0, 1],
  slow: [1, 0.5, 0, 1],
  jam: [1, 0, 0, 1],
} as const;

function source(dots: Array<[number, number, 'free' | 'slow' | 'jam' | null]>): DotSource {
  return {
    step: () => undefined,
    forEachDot: (visit) => dots.forEach(([lon, lat, bucket]) => visit(lon, lat, bucket)),
  };
}

describe('mercator', () => {
  it('maps lon/lat to the 0..1 world square', () => {
    expect(mercator(0, 0)).toEqual([0.5, 0.5]);
    expect(mercator(180, 0)[0]).toBe(1);
    expect(mercator(-180, 0)[0]).toBe(0);
    const [, north] = mercator(0, 60);
    expect(north).toBeLessThan(0.5);
  });
});

describe('hexToRgba', () => {
  it('reads #rrggbb and #rgb', () => {
    expect(hexToRgba('#ff0000', 0.5)).toEqual([1, 0, 0, 0.5]);
    expect(hexToRgba('#0f0', 1)).toEqual([0, 1, 0, 1]);
  });

  it('falls back to grey on anything else', () => {
    expect(hexToRgba('oklch(50% 0.1 20)', 1)).toEqual([0.5, 0.5, 0.5, 1]);
  });
});

describe('trafficColours', () => {
  it('uses the charter colours: muted for estimated roads, ok/warn/crit for measured ones', () => {
    const colours = trafficColours({ muted: '#000000', ok: '#00ff00', warn: '#ffff00', crit: '#ff0000' });
    expect(colours.none.slice(0, 3)).toEqual([0, 0, 0]);
    expect(colours.free.slice(0, 3)).toEqual([0, 1, 0]);
    expect(colours.slow.slice(0, 3)).toEqual([1, 1, 0]);
    expect(colours.jam.slice(0, 3)).toEqual([1, 0, 0]);
    expect(colours.none[3]).toBeLessThan(colours.jam[3]);
  });
});

describe('packDots', () => {
  it('packs position and premultiplied colour per dot', () => {
    const { data, count } = packDots(source([[0, 0, null], [180, 0, 'jam']]), COLOURS);
    expect(count).toBe(2);
    expect(Array.from(data.subarray(0, FLOATS_PER_DOT))).toEqual([0.5, 0.5, 0.25, 0.25, 0.25, 0.5]);
    expect(Array.from(data.subarray(FLOATS_PER_DOT, 2 * FLOATS_PER_DOT))).toEqual([1, 0.5, 1, 0, 0, 1]);
  });

  it('reuses a large enough buffer and grows a small one', () => {
    const big = new Float32Array(100 * FLOATS_PER_DOT);
    expect(packDots(source([[0, 0, 'free']]), COLOURS, big).data).toBe(big);
    const small = new Float32Array(FLOATS_PER_DOT);
    const grown = packDots(source([[0, 0, 'free'], [1, 1, 'slow']]), COLOURS, small);
    expect(grown.data).not.toBe(small);
    expect(grown.count).toBe(2);
  });
});

describe('packing relative to the view centre', () => {
  it('stores offsets from the origin, exact where absolute float32 values would round', () => {
    const origin = mercator(-1.6778, 48.1173); // Rennes
    const [x, y] = mercator(-1.6777, 48.1174); // ~10 m away
    const { data } = packDots(source([[-1.6777, 48.1174, null]]), COLOURS, undefined, origin);
    expect(data[0]).toBeCloseTo(x - origin[0], 12);
    expect(data[1]).toBeCloseTo(y - origin[1], 12);
    expect(Math.abs(data[0])).toBeLessThan(1e-5);
  });

  it('moves the translation into the matrix: M × T(ox, oy) applied to an offset equals M applied to the point', () => {
    const matrix = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 5, 7, 0, 1];
    const [ox, oy] = [0.25, 0.5];
    const out = translateMatrix(matrix, ox, oy);
    // Column-major: x' = m0*x + m4*y + m12, y' = m1*x + m5*y + m13.
    const apply = (m: ArrayLike<number>, x: number, y: number) => [m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13]];
    const [px, py] = [0.3, 0.55];
    expect(apply(out, px - ox, py - oy)[0]).toBeCloseTo(apply(matrix, px, py)[0], 6);
    expect(apply(out, px - ox, py - oy)[1]).toBeCloseTo(apply(matrix, px, py)[1], 6);
  });
});
