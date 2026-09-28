import { assessFixQuality, computeLookAngle, findVisible } from './look-angles';
import { parseTle } from './tle';

const ISS = {
  line1: '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927',
  line2: '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
};
const GEO = {
  line1: '1 90001U 26001A   26100.50000000  .00000000  00000-0  00000-0 0  9993',
  line2: '2 90001   0.0500  80.0000 0002000 100.0000 180.0000  1.00270000  1008',
};
const ISS_AT = new Date('2008-09-20T12:26:00Z');
const GEO_AT = new Date('2026-04-10T12:00:00Z');

// Plausible ranges, not exact values: the point is that the pipeline (SGP4, frame rotation,
// horizon transform) is wired correctly, not to re-test satellite.js to the metre.
describe('computeLookAngle', () => {
  it('puts a geostationary satellite near the zenith of its sub-point (about 18.7 W)', () => {
    const angle = computeLookAngle(GEO, { latitude: 0, longitude: -18.7 }, GEO_AT)!;
    expect(angle.elevationDeg).toBeGreaterThan(85);
    expect(angle.rangeKm).toBeGreaterThan(35_700);
    expect(angle.rangeKm).toBeLessThan(35_900);
  });

  it('sees the same satellite lower and further away from Accra', () => {
    const angle = computeLookAngle(GEO, { latitude: 5.6, longitude: -0.19 }, GEO_AT)!;
    expect(angle.elevationDeg).toBeGreaterThan(40);
    expect(angle.elevationDeg).toBeLessThan(80);
    expect(angle.rangeKm).toBeGreaterThan(35_800);
    expect(angle.rangeKm).toBeLessThan(41_700);
    // West of Accra and near the equator: roughly west-south-west.
    expect(angle.azimuthDeg).toBeGreaterThan(220);
    expect(angle.azimuthDeg).toBeLessThan(290);
  });

  it('places the ISS overhead of its ground track and below the horizon from Accra', () => {
    const overhead = computeLookAngle(ISS, { latitude: 51.3, longitude: 162.1 }, ISS_AT)!;
    expect(overhead.elevationDeg).toBeGreaterThan(80);
    expect(overhead.rangeKm).toBeGreaterThan(300);
    expect(overhead.rangeKm).toBeLessThan(450);

    const accra = computeLookAngle(ISS, { latitude: 5.6, longitude: -0.19 }, ISS_AT)!;
    expect(accra.elevationDeg).toBeLessThan(0);
  });

  it('returns null rather than throwing for elements SGP4 cannot use', () => {
    const broken = { line1: ISS.line1, line2: ISS.line2.replace('0006703', '9996703') };
    expect(computeLookAngle(broken, { latitude: 0, longitude: 0 }, new Date('2009-09-20T12:00:00Z'))).toBeNull();
  });
});

describe('findVisible', () => {
  it('applies the elevation mask and sorts highest first', () => {
    const records = parseTle(`ISS\n${ISS.line1}\n${ISS.line2}\nGEO\n${GEO.line1}\n${GEO.line2}`);
    const visible = findVisible(records, { latitude: 0, longitude: -18.7 }, GEO_AT, 10);
    expect(visible.map((s) => s.name)).toContain('GEO');
    for (let i = 1; i < visible.length; i += 1) {
      expect(visible[i - 1].elevationDeg).toBeGreaterThanOrEqual(visible[i].elevationDeg);
    }
    expect(findVisible(records, { latitude: 0, longitude: -18.7 }, GEO_AT, 89.99)).toHaveLength(0);
  });
});

describe('assessFixQuality', () => {
  const sky = (...elevations: number[]) => elevations.map((elevationDeg) => ({ elevationDeg }));

  it('is POOR below the four satellites a fix needs', () => {
    expect(assessFixQuality(sky(80, 60, 45))).toEqual({ count: 3, above30Deg: 3, quality: 'POOR' });
  });

  it('is FAIR with enough satellites but too few high ones, or too few overall', () => {
    expect(assessFixQuality(sky(12, 14, 18, 20, 22, 25, 28, 35)).quality).toBe('FAIR');
    expect(assessFixQuality(sky(70, 50, 40, 35)).quality).toBe('FAIR');
  });

  it('is GOOD with eight or more and at least four above 30 degrees', () => {
    expect(assessFixQuality(sky(80, 65, 50, 32, 25, 20, 15, 11))).toEqual({ count: 8, above30Deg: 4, quality: 'GOOD' });
  });
});
