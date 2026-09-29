import { LiveVesselIndex } from './live-vessels';
import type { VesselFix } from './vessel-provider';

const fix = (mmsi: string, latitude: number, longitude: number, extra: Partial<VesselFix> = {}): VesselFix => ({
  mmsi,
  latitude,
  longitude,
  speedKnots: 12,
  courseDegrees: 90,
  headingDegrees: 88,
  draughtM: null,
  navStatus: 'UNDER_WAY',
  ...extra,
} as VesselFix);

const WORLD = { minLat: -90, minLon: -180, maxLat: 90, maxLon: 180 };

describe('LiveVesselIndex', () => {
  it('keeps the latest fix per ship and filters by view', () => {
    const index = new LiveVesselIndex();
    index.record(fix('1', 5, 0), 1000);
    index.record(fix('1', 5.1, 0.1), 2000);
    index.record(fix('2', 40, 10), 2000);
    const gulf = index.inBox({ minLat: 0, minLon: -5, maxLat: 10, maxLon: 5 }, 3000);
    expect(gulf).toHaveLength(1);
    expect(gulf[0]).toMatchObject({ mmsi: '1', latitude: 5.1, longitude: 0.1 });
  });

  it('remembers the name from an earlier static report', () => {
    const index = new LiveVesselIndex();
    index.record(fix('1', 5, 0, { name: 'MAERSK KOLKATA', destination: 'TEMA' }), 1000);
    index.record(fix('1', 5.1, 0), 2000);
    expect(index.inBox(WORLD, 3000)[0]).toMatchObject({ name: 'MAERSK KOLKATA', destination: 'TEMA' });
  });

  it('drops ships silent for more than half an hour', () => {
    const index = new LiveVesselIndex();
    index.record(fix('1', 5, 0), 0);
    expect(index.inBox(WORLD, 31 * 60_000)).toHaveLength(0);
  });

  it('flags vessels this install follows', () => {
    const index = new LiveVesselIndex();
    index.record(fix('1', 5, 0), 0);
    index.markTracked('1');
    index.record(fix('2', 5, 0), 0);
    expect(index.inBox(WORLD, 1).map((v) => [v.mmsi, v.tracked])).toEqual([
      ['1', true],
      ['2', false],
    ]);
  });
});
