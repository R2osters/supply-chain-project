// src/components/Oscilloscope.test.ts — the ETA scope of S05 (spec § 4 S05): axis, promise and the two-stage band.
import {cueLocal} from '../lib/timeline';
import {
  BAND_WIDTH, bandLeft, bandTone, DAY_PX, dateX, edgeLabelX, NUDGE_FRAMES, PROMISE_X, promiseShake, SHORTFALL, SLIDE_FRAMES, TRACE,
  tracePitch, traceY,
} from './Oscilloscope';

const slide = cueLocal('S05', 'S05.slide');
const warn = cueLocal('S05', 'S05.warn');
const crit = cueLocal('S05', 'S05.crit');
const T = {slide, crit};

describe('ETA axis', () => {
  it('puts the promise, 14 August 18:00, on x = 1180', () => {
    expect(PROMISE_X).toBe(1180);
    expect(dateX(14, 18)).toBeCloseTo(1180, 9);
  });

  it('spaces the days so that the band slides by exactly two of them', () => {
    // Right edge on the promise halfway through the slide, left edge 20 px short at its end:
    // (L0 + W + D) - (L0 + 2D) = W - D = 20, so one day is the band width minus the shortfall.
    expect(DAY_PX).toBe(BAND_WIDTH - SHORTFALL);
    expect(DAY_PX).toBe(90);
    expect(dateX(15) - dateX(14)).toBeCloseTo(DAY_PX, 9);
    expect(bandLeft(slide + SLIDE_FRAMES, T) - bandLeft(slide, T)).toBeCloseTo(2 * DAY_PX, 6);
  });
});

describe('ETA band', () => {
  it('is 110 px wide and 20 px short of the promise at rest', () => {
    expect(BAND_WIDTH).toBe(110);
    expect(SHORTFALL).toBe(20);
  });

  it('holds still until the slide cue', () => {
    expect(bandLeft(0, T)).toBe(bandLeft(slide, T));
    expect(bandLeft(slide - 1, T)).toBe(bandLeft(slide, T));
  });

  it('crosses the promise with its right edge exactly on S05.warn', () => {
    expect(warn - slide).toBe(SLIDE_FRAMES / 2);
    expect(bandLeft(warn, T) + BAND_WIDTH).toBeCloseTo(PROMISE_X, 3);
    expect(bandLeft(warn - 1, T) + BAND_WIDTH).toBeLessThan(PROMISE_X);
  });

  it('ends the slide with its left edge 20 px short of the promise', () => {
    expect(bandLeft(slide + SLIDE_FRAMES, T)).toBeCloseTo(PROMISE_X - SHORTFALL, 6);
    expect(bandLeft(crit - NUDGE_FRAMES / 2, T)).toBeCloseTo(PROMISE_X - SHORTFALL, 6);
  });

  it('crosses the promise with its left edge exactly on S05.crit, in a 12-frame nudge that starts 6 frames before', () => {
    expect(NUDGE_FRAMES).toBe(12);
    expect(bandLeft(crit, T)).toBeCloseTo(PROMISE_X, 3);
    expect(bandLeft(crit - 1, T)).toBeLessThan(PROMISE_X);
    expect(bandLeft(crit - 7, T)).toBe(bandLeft(crit - 6, T));
    expect(bandLeft(crit + 6, T)).toBeCloseTo(PROMISE_X + SHORTFALL, 6);
    expect(bandLeft(crit + 60, T)).toBeCloseTo(PROMISE_X + SHORTFALL, 6);
  });

  it('uses the in-out curve: slow at both ends of the slide, fastest in the middle', () => {
    const step = (f: number) => bandLeft(f + 1, T) - bandLeft(f, T);
    expect(step(slide)).toBeLessThan(step(warn - 1));
    expect(step(slide + SLIDE_FRAMES - 1)).toBeLessThan(step(warn));
    for (let f = slide; f < slide + SLIDE_FRAMES; f++) expect(step(f)).toBeGreaterThanOrEqual(0);
  });

  it('is neutral before S05.warn, warn from it, crit from S05.crit', () => {
    const tones = {warn, crit};
    expect(bandTone(warn - 1, tones)).toBe('neutral');
    expect(bandTone(warn, tones)).toBe('warn');
    expect(bandTone(crit - 1, tones)).toBe('warn');
    expect(bandTone(crit, tones)).toBe('crit');
    expect(bandTone(crit + 200, tones)).toBe('crit');
  });
});

describe('band edge labels', () => {
  it('stay clear of the promise line (and its 3 px shake) whenever the band rests, and on S05.crit itself', () => {
    const LABEL_W = 24;
    const clear = (x: number) => x + LABEL_W < PROMISE_X - 3 || x > PROMISE_X + 3;
    const resting = [0, slide - 1, slide + SLIDE_FRAMES, crit - NUDGE_FRAMES / 2, crit, crit + NUDGE_FRAMES / 2, crit + 80];
    for (const f of resting) {
      const {optimiste, pessimiste} = edgeLabelX(f, T);
      expect(clear(optimiste)).toBe(true);
      expect(clear(pessimiste)).toBe(true);
    }
  });

  it('hang each label on its own edge: OPTIMISTE by the left edge, PESSIMISTE by the right one', () => {
    for (const f of [0, warn, crit + 20]) {
      const {optimiste, pessimiste} = edgeLabelX(f, T);
      const left = bandLeft(f, T);
      expect(Math.abs(optimiste + 12 - left)).toBeLessThan(40);
      expect(Math.abs(pessimiste + 12 - (left + BAND_WIDTH))).toBeLessThan(40);
    }
  });
});

describe('scope trace (the held D4 sine of the score)', () => {
  it('bends up one semitone over the slide, like the sine that follows the band', () => {
    expect(tracePitch(slide, T)).toBe(1);
    expect(tracePitch(0, T)).toBe(1);
    expect(tracePitch(slide + SLIDE_FRAMES, T)).toBeCloseTo(2 ** (1 / 12), 9);
    expect(tracePitch(warn, T)).toBeGreaterThan(1);
    expect(tracePitch(warn, T)).toBeLessThan(2 ** (1 / 12));
  });

  it('stays inside its amplitude, and only beats (a minor second) from S05.crit', () => {
    const xs = Array.from({length: 200}, (_, i) => 900 + i * 3.5);
    for (const f of [0, warn, crit - 1, crit, crit + 20]) {
      for (const x of xs) expect(Math.abs(traceY(x, f, T))).toBeLessThanOrEqual(TRACE.amp + 1e-9);
    }
    // Before crit the envelope is flat: every peak reaches the full amplitude somewhere along the width.
    const peak = (f: number, from: number, to: number) =>
      Math.max(...xs.filter((x) => x >= from && x < to).map((x) => Math.abs(traceY(x, f, T))));
    expect(peak(crit - 1, 900, 1100)).toBeGreaterThan(TRACE.amp * 0.95);
    expect(peak(crit - 1, 1400, 1600)).toBeGreaterThan(TRACE.amp * 0.95);
    // From crit, two close frequencies beat: somewhere along the width the envelope collapses.
    const windows = Array.from({length: 12}, (_, i) => peak(crit + 20, 900 + i * 58, 958 + i * 58));
    expect(Math.min(...windows)).toBeLessThan(TRACE.amp * 0.5);
  });
});

describe('promise vibration', () => {
  it('shakes by up to 3 px at 12 Hz for 10 frames from S05.crit, and only then', () => {
    expect(promiseShake(crit - 1, crit)).toBe(0);
    expect(promiseShake(crit + 10, crit)).toBe(0);
    const inside = Array.from({length: 10}, (_, i) => promiseShake(crit + i, crit));
    for (const x of inside) expect(Math.abs(x)).toBeLessThanOrEqual(3 + 1e-9);
    expect(Math.max(...inside.map(Math.abs))).toBeGreaterThan(2.5);
    // 12 Hz at 30 fps: one period every 2.5 frames, so the pattern repeats every 5 frames.
    expect(promiseShake(crit + 5, crit)).toBeCloseTo(promiseShake(crit, crit), 9);
    expect(promiseShake(crit + 1, crit)).not.toBeCloseTo(promiseShake(crit, crit), 3);
  });
});
