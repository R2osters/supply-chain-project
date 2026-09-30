import { describe, expect, it } from 'vitest';
import { FLOATS_PER_DOT, hexToRgba, mercator, packDots, trafficColours, type DotSource } from './road-traffic-layer';

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
