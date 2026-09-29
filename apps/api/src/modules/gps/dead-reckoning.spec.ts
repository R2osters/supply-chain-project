import { haversineKm } from '@scip/shared';
import { assumedSpeedKmh, estimatePosition, parsePolyline } from './dead-reckoning';

// Accra → Kumasi, straight enough for arithmetic: about 200 km.
const ACCRA = { latitude: 5.6037, longitude: -0.187 };
const KUMASI = { latitude: 6.6885, longitude: -1.6244 };
const PATH = [ACCRA, KUMASI];
const LENGTH_KM = haversineKm(ACCRA, KUMASI);

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 29, 8, 0) + minutes * 60_000);

describe('dead reckoning', () => {
  it('uses the corridor average when the route has a planned duration', () => {
    expect(assumedSpeedKmh({ path: PATH, nominalSpeedKmh: 60, plannedDurationMinutes: 240 })).toBeCloseTo(LENGTH_KM / 4, 1);
  });

  it('falls back to cruising speed minus a stop allowance', () => {
    expect(assumedSpeedKmh({ path: PATH, nominalSpeedKmh: 60, plannedDurationMinutes: null })).toBe(51);
  });

  it('advances from departure along the path when there has been no fix', () => {
    const estimate = estimatePosition({
      path: PATH,
      now: at(120),
      departedAt: at(0),
      lastFix: null,
      nominalSpeedKmh: 60,
      plannedDurationMinutes: 240,
    })!;
    expect(estimate.basis).toBe('departure');
    expect(estimate.progress).toBeCloseTo(0.5, 2);
    expect(haversineKm(estimate, ACCRA)).toBeCloseTo(LENGTH_KM / 2, 0);
    expect(estimate.atDestination).toBe(false);
  });

  it('starts from the last fix projected on the route, not from the depot', () => {
    const halfway = { latitude: (ACCRA.latitude + KUMASI.latitude) / 2, longitude: (ACCRA.longitude + KUMASI.longitude) / 2 };
    const estimate = estimatePosition({
      path: PATH,
      now: at(60),
      departedAt: at(-600),
      lastFix: { position: halfway, at: at(0) },
      nominalSpeedKmh: 60,
      plannedDurationMinutes: 240,
    })!;
    expect(estimate.basis).toBe('last-fix');
    expect(estimate.minutesSinceBasis).toBe(60);
    expect(estimate.progress).toBeCloseTo(0.75, 2);
  });

  it('grows the uncertainty with the distance guessed', () => {
    const base = { path: PATH, departedAt: at(0), lastFix: null, nominalSpeedKmh: 60, plannedDurationMinutes: 240 };
    const soon = estimatePosition({ ...base, now: at(10) })!;
    const later = estimatePosition({ ...base, now: at(100) })!;
    expect(later.radiusKm).toBeGreaterThan(soon.radiusKm);
    expect(soon.radiusKm).toBeGreaterThanOrEqual(1);
  });

  it('stops at the destination instead of overshooting', () => {
    const estimate = estimatePosition({
      path: PATH,
      now: at(600),
      departedAt: at(0),
      lastFix: null,
      nominalSpeedKmh: 60,
      plannedDurationMinutes: 240,
    })!;
    expect(estimate.atDestination).toBe(true);
    expect(haversineKm(estimate, KUMASI)).toBeLessThan(0.01);
  });

  it('refuses to guess after twelve hours of silence or without a path', () => {
    const base = { path: PATH, departedAt: at(0), lastFix: null, nominalSpeedKmh: 60 };
    expect(estimatePosition({ ...base, now: at(13 * 60) })).toBeNull();
    expect(estimatePosition({ ...base, path: [ACCRA], now: at(10) })).toBeNull();
  });

  it('parses the stored polyline defensively', () => {
    expect(parsePolyline([ACCRA, { latitude: 'x' }, null, KUMASI])).toEqual([ACCRA, KUMASI]);
    expect(parsePolyline('nope')).toEqual([]);
  });
});
