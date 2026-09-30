// src/components/Console.test.ts — the S11 console's geometry (10 strips + MASTER, 150 × 760 px, inside the 96 px
// margins) and its deterministic VU envelope (brief: 0.55 + 0.35·|sin(f·0.9 + i)|, damped by rand).
import {rand} from '../lib/prng';
import {
  CONSOLE_TOP, FADER_UP, MASTER_X, STRIP_H, STRIP_W, STRIPS_COUNT, VU_DAMP, VU_SEED, faderY, stripX, vuEnvelope,
} from './Console';

describe('Console geometry', () => {
  it('lays out 10 strips and the MASTER at 150 × 760 px inside the 96 px margins, without overlap', () => {
    expect(STRIPS_COUNT).toBe(10);
    expect(STRIP_W).toBe(150);
    expect(STRIP_H).toBe(760);
    const xs = [...Array.from({length: STRIPS_COUNT}, (_, i) => stripX(i)), MASTER_X];
    expect(xs[0]).toBe(96);
    expect(MASTER_X + STRIP_W).toBe(1824);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] + STRIP_W + 4);
    // The MASTER stands apart from the ten channels.
    expect(MASTER_X - (stripX(STRIPS_COUNT - 1) + STRIP_W)).toBeGreaterThan(stripX(1) - (stripX(0) + STRIP_W));
    expect(CONSOLE_TOP).toBeGreaterThanOrEqual(120);
    expect(CONSOLE_TOP + STRIP_H).toBeLessThanOrEqual(980);
  });

  it('moves the fader knob up the track with its level', () => {
    expect(faderY(0)).toBeGreaterThan(faderY(FADER_UP));
    expect(faderY(FADER_UP)).toBeGreaterThan(faderY(1));
    expect(FADER_UP).toBe(0.7);
  });
});

describe('Console VU envelope', () => {
  it('follows 0.55 + 0.35·|sin(f·0.9 + i)|, damped by the seeded rand', () => {
    for (const [f, i] of [[0, 0], [7, 3], [133, 9], [260, 10]]) {
      const expected = (0.55 + 0.35 * Math.abs(Math.sin(f * 0.9 + i))) * (1 - VU_DAMP * rand(VU_SEED, i, f));
      expect(vuEnvelope(f, i)).toBeCloseTo(expected, 12);
    }
  });

  it('stays in its band and is a pure function of (frame, strip)', () => {
    for (let f = 0; f < 320; f++) {
      for (let i = 0; i < 11; i++) {
        const v = vuEnvelope(f, i);
        expect(v).toBeGreaterThanOrEqual(0.55 * (1 - VU_DAMP));
        expect(v).toBeLessThanOrEqual(0.9);
        expect(vuEnvelope(f, i)).toBe(v);
      }
    }
    expect(vuEnvelope(10, 1)).not.toBe(vuEnvelope(10, 2));
  });
});
