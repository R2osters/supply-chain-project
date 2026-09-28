import { describe, expect, it } from 'vitest';
import {
  deadReckon,
  glideDurationMs,
  isTrackAnimating,
  lerpPoint,
  positionAt,
  startTrack,
} from './motion';

const ACCRA = { latitude: 5.6037, longitude: -0.187 };
const TEMA = { latitude: 5.6698, longitude: -0.0166 };

describe('lerpPoint', () => {
  it('crosses the antimeridian the short way', () => {
    const mid = lerpPoint({ latitude: 0, longitude: 179 }, { latitude: 0, longitude: -179 }, 0.5);
    expect(Math.abs(mid.longitude)).toBeCloseTo(180, 5);
  });
});

describe('deadReckon', () => {
  it('moves about 1 km north in 36 s at 100 km/h', () => {
    const moved = deadReckon({ latitude: 0, longitude: 0 }, 100, 0, 36_000);
    expect(moved.latitude).toBeCloseTo(0.009, 3);
    expect(moved.longitude).toBeCloseTo(0, 6);
  });
});

describe('glideDurationMs', () => {
  it('clamps absurd intervals into a watchable glide', () => {
    expect(glideDurationMs(50)).toBe(800);
    expect(glideDurationMs(120_000)).toBe(8_000);
    expect(glideDurationMs(null)).toBe(2_000);
  });
});

describe('positionAt', () => {
  it('places a first fix immediately rather than gliding in from nowhere', () => {
    const track = startTrack(null, { ...ACCRA, speedKmh: 0, headingDegrees: 0 }, 0, null);
    expect(positionAt(track, 0)).toEqual(ACCRA);
  });

  it('glides from the drawn position and arrives on the fix', () => {
    const track = startTrack(ACCRA, { ...TEMA, speedKmh: 0, headingDegrees: 90 }, 0, 4_000);
    const halfway = positionAt(track, 2_000);
    expect(halfway.longitude).toBeGreaterThan(ACCRA.longitude);
    expect(halfway.longitude).toBeLessThan(TEMA.longitude);
    expect(positionAt(track, 4_000)).toEqual(TEMA);
  });

  it('coasts along the heading after arriving, then stops at the cap', () => {
    const track = startTrack(ACCRA, { ...TEMA, speedKmh: 60, headingDegrees: 90 }, 0, 1_000);
    const coasting = positionAt(track, 6_000);
    expect(coasting.longitude).toBeGreaterThan(TEMA.longitude);
    const capped = positionAt(track, 1_000 + 15_000);
    expect(positionAt(track, 600_000)).toEqual(capped);
  });

  it('does not creep a parked vehicle around on GPS jitter', () => {
    const track = startTrack(ACCRA, { ...TEMA, speedKmh: 1, headingDegrees: 90 }, 0, 1_000);
    expect(positionAt(track, 10_000)).toEqual(TEMA);
    expect(isTrackAnimating(track, 10_000)).toBe(false);
  });
});
