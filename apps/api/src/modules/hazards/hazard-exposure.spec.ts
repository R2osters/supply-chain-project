import { computeExposures, shipmentAssetPoints, type ExposureAsset } from './hazard-exposure';
import type { Hazard } from './hazard.types';

// Accra and Kumasi, ~200 km apart — the corridor used throughout the demo data.
const ACCRA = { latitude: 5.6037, longitude: -0.187 };
const KUMASI = { latitude: 6.6885, longitude: -1.6244 };

const hazard = (overrides: Partial<Hazard>): Hazard => ({
  id: 'h',
  kind: 'EARTHQUAKE',
  title: 'test hazard',
  severity: 'MEDIUM',
  severityScore: 0.5,
  latitude: ACCRA.latitude,
  longitude: ACCRA.longitude,
  radiusKm: 0,
  observedAt: '2026-09-28T00:00:00.000Z',
  source: 'test',
  url: null,
  details: {},
  track: null,
  cone: null,
  ...overrides,
});

const warehouse = (id: string, point: { latitude: number; longitude: number }): ExposureAsset => ({
  subjectType: 'WAREHOUSE',
  subjectId: id,
  subjectLabel: id,
  ...point,
});

describe('computeExposures', () => {
  it('flags an asset inside the exposure radius and ignores one outside it', () => {
    const result = computeExposures(
      [warehouse('accra', ACCRA), warehouse('kumasi', KUMASI)],
      [hazard({ id: 'q1' })],
      50,
    );
    expect(result.map((e) => e.subjectId)).toEqual(['accra']);
    expect(result[0].distanceKm).toBe(0);
  });

  it("extends the threshold by the hazard's own radius", () => {
    const assets = [warehouse('kumasi', KUMASI)];
    expect(computeExposures(assets, [hazard({ radiusKm: 0 })], 150)).toHaveLength(0);
    expect(computeExposures(assets, [hazard({ radiusKm: 100 })], 150)).toHaveLength(1);
  });

  it('matches a cyclone against its forecast track, not only its current position', () => {
    const offshore = hazard({
      id: 'storm',
      kind: 'CYCLONE',
      latitude: -5,
      longitude: -0.2,
      radiusKm: 100,
      track: [{ latitude: 5.5, longitude: -0.2, at: null }],
    });
    const [exposure] = computeExposures([warehouse('accra', ACCRA)], [offshore], 50);
    expect(exposure.hazardId).toBe('storm');
    expect(exposure.distanceKm).toBeLessThan(20);
  });

  it('reports each hazard/subject pair once, at its closest point', () => {
    const points: ExposureAsset[] = [
      { ...warehouse('s1', KUMASI), subjectType: 'SHIPMENT' },
      { ...warehouse('s1', ACCRA), subjectType: 'SHIPMENT' },
    ];
    const result = computeExposures(points, [hazard({ radiusKm: 300 })], 50);
    expect(result).toHaveLength(1);
    expect(result[0].distanceKm).toBe(0);
  });

  it('sorts by severity first, then by distance', () => {
    const near = { latitude: 5.61, longitude: -0.19 };
    const result = computeExposures(
      [warehouse('accra', ACCRA)],
      [
        hazard({ id: 'low-near', severity: 'LOW', ...near }),
        hazard({ id: 'critical-far', severity: 'CRITICAL', latitude: 5.9, longitude: -0.19 }),
        hazard({ id: 'critical-near', severity: 'CRITICAL', ...near }),
      ],
      100,
    );
    expect(result.map((e) => e.hazardId)).toEqual(['critical-near', 'critical-far', 'low-near']);
  });
});

describe('shipmentAssetPoints', () => {
  const shipment = {
    id: 'shp',
    trackingNumber: 'TRK-1',
    originName: 'Accra',
    originLatitude: ACCRA.latitude,
    originLongitude: ACCRA.longitude,
    destinationName: 'Kumasi',
    destinationLatitude: KUMASI.latitude,
    destinationLongitude: KUMASI.longitude,
  };

  it('uses the last GPS fix and the destination when a fix exists', () => {
    const points = shipmentAssetPoints(shipment, { latitude: 6, longitude: -1 });
    expect(points.map((p) => p.subjectLabel)).toEqual(['TRK-1 — last GPS fix', 'TRK-1 — destination Kumasi']);
  });

  it('falls back to both ends of the trip without a fix, and says so', () => {
    const points = shipmentAssetPoints(shipment, null);
    expect(points[0].subjectLabel).toContain('no GPS fix');
    expect(points[0].latitude).toBe(ACCRA.latitude);
    expect(points[1].latitude).toBe(KUMASI.latitude);
  });
});
