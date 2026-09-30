// src/components/Oscilloscope.test.ts — the ETA scope of S05 (spec § 4 S05): axis, promise, the two-stage band that
// loses exactly two days, and the tone lane.
import {cueLocal, wordLocal} from '../lib/timeline';
import {
  BAND_WIDTH, bandLeft, bandTone, DAY_PX, dateX, edgeLabelX, NUDGE_FRAMES, NUDGE_PX, PROMISE_X, promiseShake, SHORTFALL,
  SLIDE_FRAMES, SLIDE_PX, slideStart, START_LEFT, TRACE, tracePitch, traceY, WARN_LEAD,
} from './Oscilloscope';

const slide = cueLocal('S05', 'S05.slide');
const warn = cueLocal('S05', 'S05.warn');
const crit = cueLocal('S05', 'S05.crit');
const T = {slide, warn, crit};
const s0 = slideStart(warn);
/** First whole frame at which the slide is over. */
const slideEnd = Math.ceil(s0 + SLIDE_FRAMES);
/** Date at an axis x, in hours after 14 August 00:00. */
const hoursAt = (x: number) => 18 + ((x - PROMISE_X) / DAY_PX) * 24;

describe('ETA axis', () => {
  it('puts the promise, 14 August 18:00, on x = 1180', () => {
    expect(PROMISE_X).toBe(1180);
    expect(dateX(14, 18)).toBeCloseTo(1180, 9);
  });

  it('spaces the days 90 px apart, so that 12 → 18 August fits the screen', () => {
    expect(DAY_PX).toBe(90);
    expect(dateX(15) - dateX(14)).toBeCloseTo(DAY_PX, 9);
  });
});

describe('ETA band: « perd deux jours »', () => {
  it('loses exactly two days over its two stages, as the voice and the « +2 J » of S01 say', () => {
    expect(SLIDE_PX + NUDGE_PX).toBe(2 * DAY_PX);
    expect(bandLeft(crit + 60, T) - bandLeft(0, T)).toBeCloseTo(2 * DAY_PX, 6);
    // Optimistic edge: 12 AOÛT 23:20 at rest, 14 AOÛT 23:20 at the end.
    expect(START_LEFT).toBe(1020);
    expect(hoursAt(bandLeft(0, T))).toBeCloseTo(-24 - 40 / 60, 6);
    expect(hoursAt(bandLeft(crit + 60, T))).toBeCloseTo(23 + 20 / 60, 6);
  });

  it('follows assessLateness: on time at rest, at risk after the slide, late only once even the optimistic edge misses', () => {
    // At rest the pessimistic edge is before the promise, on 14 AOÛT 04:40.
    expect(bandLeft(0, T) + BAND_WIDTH).toBeLessThan(PROMISE_X);
    expect(hoursAt(bandLeft(0, T) + BAND_WIDTH)).toBeCloseTo(4 + 40 / 60, 6);
    // Between the stages the ETA is past the promise but the optimistic edge is not: not certainly late.
    const hold = crit - NUDGE_FRAMES / 2;
    expect(bandLeft(hold, T) + BAND_WIDTH / 2).toBeGreaterThan(PROMISE_X);
    expect(bandLeft(hold, T)).toBeLessThan(PROMISE_X);
    // After the nudge even the optimistic edge misses the promise: EN RETARD.
    expect(bandLeft(crit + 6, T)).toBeGreaterThan(PROMISE_X);
  });
});

describe('ETA band', () => {
  it('is 110 px wide and 20 px short of the promise at rest', () => {
    expect(BAND_WIDTH).toBe(110);
    expect(SHORTFALL).toBe(20);
  });

  it('starts sliding on « perd », less than 2 frames after S05.slide, and holds still until then', () => {
    expect(WARN_LEAD).toBeGreaterThan(16);
    expect(WARN_LEAD).toBeLessThan(16.2);
    expect(s0 - slide).toBeGreaterThanOrEqual(0);
    expect(s0 - slide).toBeLessThan(2);
    expect(Math.abs(s0 - wordLocal('S05', 'perd').start)).toBeLessThan(1);
    expect(bandLeft(0, T)).toBe(START_LEFT);
    expect(bandLeft(Math.floor(s0), T)).toBe(START_LEFT);
    expect(bandLeft(Math.ceil(s0), T)).toBeGreaterThan(START_LEFT);
  });

  it('crosses the promise with its right edge exactly on S05.warn', () => {
    expect(bandLeft(warn, T) + BAND_WIDTH).toBeCloseTo(PROMISE_X, 6);
    expect(bandLeft(warn - 1, T) + BAND_WIDTH).toBeLessThan(PROMISE_X);
    expect(bandLeft(warn + 1, T) + BAND_WIDTH).toBeGreaterThan(PROMISE_X);
  });

  it('ends the slide, 36 frames after it began, with its left edge 20 px short of the promise', () => {
    expect(SLIDE_PX).toBe(140);
    expect(bandLeft(s0 + SLIDE_FRAMES, T)).toBeCloseTo(PROMISE_X - SHORTFALL, 6);
    expect(bandLeft(slideEnd, T)).toBeCloseTo(PROMISE_X - SHORTFALL, 6);
    expect(bandLeft(slideEnd - 2, T)).toBeLessThan(PROMISE_X - SHORTFALL);
    expect(bandLeft(crit - NUDGE_FRAMES / 2, T)).toBeCloseTo(PROMISE_X - SHORTFALL, 6);
  });

  it('crosses the promise with its left edge exactly on S05.crit, in a 12-frame nudge that starts 6 frames before', () => {
    expect(NUDGE_FRAMES).toBe(12);
    expect(NUDGE_PX).toBe(2 * SHORTFALL);
    expect(bandLeft(crit, T)).toBeCloseTo(PROMISE_X, 3);
    expect(bandLeft(crit - 1, T)).toBeLessThan(PROMISE_X);
    expect(bandLeft(crit - 7, T)).toBe(bandLeft(crit - 6, T));
    expect(bandLeft(crit + 6, T)).toBeCloseTo(PROMISE_X + SHORTFALL, 6);
    expect(bandLeft(crit + 60, T)).toBeCloseTo(PROMISE_X + SHORTFALL, 6);
  });

  it('uses the in-out curve: slow at both ends of the slide, fastest in the middle', () => {
    const step = (f: number) => bandLeft(f + 1, T) - bandLeft(f, T);
    const mid = Math.round(s0 + SLIDE_FRAMES / 2);
    expect(step(Math.ceil(s0))).toBeLessThan(step(mid));
    expect(step(slideEnd - 2)).toBeLessThan(step(mid));
    for (let f = Math.floor(s0); f < slideEnd; f++) expect(step(f)).toBeGreaterThanOrEqual(0);
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
    const resting = [0, slide - 1, slideEnd, crit - NUDGE_FRAMES / 2, crit, crit + NUDGE_FRAMES / 2, crit + 80];
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

describe('tone lane (the held D4 sine of the score)', () => {
  it('runs margin to margin across the strip under the scope, where the stamp lands', () => {
    expect(TRACE.x0).toBe(96);
    expect(TRACE.x1).toBe(1920 - 96);
    expect(TRACE.y - TRACE.amp).toBeGreaterThan(762 + 24);
    expect(TRACE.y + TRACE.amp).toBeLessThan(960 - 24);
  });

  it('is a flat line until S05.slide, where the score starts the sine, and swells to full height in 6 frames', () => {
    const xs = Array.from({length: 433}, (_, i) => TRACE.x0 + i * 4);
    for (const f of [0, 40, slide - 1, slide]) for (const x of xs) expect(traceY(x, f, T)).toBe(0);
    expect(TRACE.enter).toBe(6);
    const peak = (f: number) => Math.max(...xs.map((x) => Math.abs(traceY(x, f, T))));
    expect(peak(slide + 1)).toBeGreaterThan(0);
    expect(peak(slide + 1)).toBeLessThan(TRACE.amp);
    expect(peak(slide + TRACE.enter)).toBeGreaterThan(TRACE.amp * 0.99);
  });

  it('bends up one semitone over the slide, like the sine that follows the band', () => {
    expect(tracePitch(slide, T)).toBe(1);
    expect(tracePitch(0, T)).toBe(1);
    expect(tracePitch(slide + SLIDE_FRAMES, T)).toBeCloseTo(2 ** (1 / 12), 9);
    expect(tracePitch(warn, T)).toBeGreaterThan(1);
    expect(tracePitch(warn, T)).toBeLessThan(2 ** (1 / 12));
  });

  it('stays inside its amplitude, and only beats (a minor second) from S05.crit', () => {
    const xs = Array.from({length: 433}, (_, i) => TRACE.x0 + i * 4);
    for (const f of [0, warn, crit - 1, crit, crit + 20]) {
      for (const x of xs) expect(Math.abs(traceY(x, f, T))).toBeLessThanOrEqual(TRACE.amp + 1e-9);
    }
    // Before crit the envelope is flat: every peak reaches the full amplitude somewhere along the width.
    const peak = (f: number, from: number, to: number) =>
      Math.max(...xs.filter((x) => x >= from && x < to).map((x) => Math.abs(traceY(x, f, T))));
    for (let from = TRACE.x0; from + 96 <= TRACE.x1; from += 96) expect(peak(crit - 1, from, from + 96)).toBeGreaterThan(TRACE.amp * 0.95);
    // From crit, two close frequencies beat: somewhere along the width the envelope collapses.
    const windows = Array.from({length: 24}, (_, i) => peak(crit + 20, TRACE.x0 + i * 72, TRACE.x0 + (i + 1) * 72));
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
