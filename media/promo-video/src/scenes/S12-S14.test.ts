// src/scenes/S12-S14.test.ts — the timed logic of S12 (model race), S13 (supplier keyboard) and S14 (bridge).
// Every frame comes from a cue or a word; these tests pin the frames and values the spec wants exact.
import {frDecimal} from '../lib/format';
import {cueLocal, sceneFrames, sceneStart, seriesLocal} from '../lib/timeline';
import {digitPosition} from '../rb/Counter';
import {
  FINAL_RANKING, FLIP_FRAMES, foldAt, levelOf, meterLevel, MODELS, noteFrames, rowOpacity, rowSlot, S12_T, wapeAt, winnerOk,
} from './S12Modeles';
import {CAP_SHARE, keyStates, S13_T, SHARES, SUPPLIERS, timerText} from './S13Clavier';
import {
  CODE_LINES, codeLineText, mixHex, pluckDisplacement, pluckEnvelope, S14_T, STRING_NAMES, stringTint, THREADS_UNIT, threadsAmplitude,
  typedSegments, violetWobble,
} from './S14Pont';

const FINAL: Record<string, string> = {
  HOLT_WINTERS: '24,13', GRADIENT_BOOSTING: '24,72', SEASONAL_NAIVE: '25,74',
  MOVING_AVERAGE: '27,07', EXPONENTIAL_SMOOTHING: '28,11', NAIVE: '29,38',
};

describe('S12 · la bataille des modèles', () => {
  const frames = sceneFrames('S12');
  const idx = (m: string): number => MODELS.indexOf(m as (typeof MODELS)[number]);

  it('reads its frames from the cues: three walk-forward steps, the sort on « précis », the dim on « compliqué »', () => {
    expect(S12_T.steps).toEqual(seriesLocal('S12', 'S12.step'));
    expect(S12_T.steps).toEqual([30, 90, 150]);
    expect(S12_T.sort).toBe(cueLocal('S12', 'S12.sort'));
    expect(S12_T.sort).toBe(150);
    expect(S12_T.dim).toBe(cueLocal('S12', 'S12.dim'));
    expect(S12_T.dim).toBe(195);
  });

  it('lists the six models in the spec order', () => {
    expect([...MODELS]).toEqual(['NAIVE', 'SEASONAL_NAIVE', 'MOVING_AVERAGE', 'EXPONENTIAL_SMOOTHING', 'HOLT_WINTERS', 'GRADIENT_BOOSTING']);
  });

  it('shows 00,00 until the first step, then rolls the running WAPE at every step', () => {
    for (let i = 0; i < 6; i++) expect(wapeAt(i, S12_T.steps[0] - 1)).toBe(0);
    for (let i = 0; i < 6; i++) expect(wapeAt(i, S12_T.steps[0] + 1)).toBeGreaterThan(0);
    // Between two steps the value holds.
    for (let i = 0; i < 6; i++) expect(wapeAt(i, S12_T.steps[1] - 1)).toBe(wapeAt(i, S12_T.steps[0] + 40));
  });

  it('lands exactly on the spec WAPE values by the end of the sort, and holds them to frames + 15', () => {
    for (const f of [S12_T.sort + FLIP_FRAMES, frames - 1, frames + 15]) {
      for (const m of MODELS) {
        const v = wapeAt(idx(m), f);
        expect(frDecimal(v, 2)).toBe(FINAL[m]);
        // The odometer lands on the exact digits too (no 24,12999…).
        expect(digitPosition(v, 0.01, 0.01) % 10).toBe(Number(FINAL[m].slice(-1)));
      }
    }
  });

  it('ranks the winner first: HOLT_WINTERS, then GRADIENT_BOOSTING … NAIVE (CONCEPT.fr.md)', () => {
    expect(FINAL_RANKING).toEqual(['HOLT_WINTERS', 'GRADIENT_BOOSTING', 'SEASONAL_NAIVE', 'MOVING_AVERAGE', 'EXPONENTIAL_SMOOTHING', 'NAIVE']);
  });

  it('keeps the rows in spec order until the sort, then FLIPs them into the ranking over 18 frames, ease-out', () => {
    expect(FLIP_FRAMES).toBe(18);
    for (let i = 0; i < 6; i++) expect(rowSlot(i, S12_T.sort)).toBe(i);
    for (const m of MODELS) expect(rowSlot(idx(m), S12_T.sort + FLIP_FRAMES)).toBe(FINAL_RANKING.indexOf(m));
    for (const m of MODELS) expect(rowSlot(idx(m), frames + 15)).toBe(FINAL_RANKING.indexOf(m));
    const hw = idx('HOLT_WINTERS');
    const mid = S12_T.sort + FLIP_FRAMES / 2;
    const first = rowSlot(hw, S12_T.sort) - rowSlot(hw, mid);
    const second = rowSlot(hw, mid) - rowSlot(hw, S12_T.sort + FLIP_FRAMES);
    expect(first).toBeGreaterThan(second);
  });

  it('meters stay dark until their lane plays, then read the precision: the winner longest', () => {
    for (let i = 0; i < 6; i++) expect(meterLevel(i, noteFrames(i)[0] - 1)).toBe(0);
    const settled = S12_T.sort + 40;
    const levels = FINAL_RANKING.map((m) => meterLevel(idx(m), settled));
    for (let k = 1; k < levels.length; k++) expect(levels[k]).toBeLessThan(levels[k - 1]);
    expect(levelOf(24.13)).toBeGreaterThan(levelOf(29.38));
  });

  it('plays the six lanes one sixteenth apart at every step, like the modelRun arpeggio', () => {
    for (let i = 0; i < 6; i++) {
      expect(noteFrames(i)).toEqual(S12_T.steps.map((s) => s + Math.floor(i * 3.75 + 0.5)));
    }
  });

  it('flashes the winner ok only from the sort cue, and at most twice', () => {
    expect(winnerOk(S12_T.sort - 1)).toBe(false);
    expect(winnerOk(S12_T.sort)).toBe(true);
    let onsets = 0;
    for (let f = S12_T.sort - 5; f < S12_T.sort + 30; f++) if (winnerOk(f) && !winnerOk(f - 1)) onsets++;
    expect(onsets).toBe(2);
    expect(winnerOk(S12_T.sort + 30)).toBe(true);
    expect(winnerOk(frames + 15)).toBe(true);
  });

  it('dims GRADIENT_BOOSTING on « compliqué » and nothing else', () => {
    const gb = idx('GRADIENT_BOOSTING');
    expect(rowOpacity(gb, S12_T.dim - 1)).toBe(1);
    expect(rowOpacity(gb, S12_T.dim + 12)).toBeLessThan(0.5);
    for (let i = 0; i < 6; i++) if (i !== gb) expect(rowOpacity(i, frames + 15)).toBe(1);
  });

  it('walks the test window forward one fold per step while the training zone grows', () => {
    expect(foldAt(S12_T.steps[0] - 1)).toBeNull();
    const folds = S12_T.steps.map((s) => foldAt(s + 12)!);
    for (let k = 1; k < folds.length; k++) {
      expect(folds[k].trainEnd).toBeGreaterThan(folds[k - 1].trainEnd);
      expect(folds[k].testX).toBeCloseTo(folds[k - 1].testX + folds[k - 1].testW, 6);
      expect(folds[k].testW).toBeCloseTo(folds[0].testW, 6);
    }
    for (const fold of folds) expect(fold.testX).toBeCloseTo(fold.trainEnd, 6);
  });
});

describe('S13 · le clavier des fournisseurs', () => {
  const frames = sceneFrames('S13');

  it('reads its frames from the cues', () => {
    expect(S13_T.keys).toBe(cueLocal('S13', 'S13.keys'));
    expect(S13_T.timer).toBe(cueLocal('S13', 'S13.timer'));
    expect(S13_T.chord).toBe(cueLocal('S13', 'S13.chord'));
    expect(S13_T.strike).toBe(cueLocal('S13', 'S13.strike'));
    expect([S13_T.keys, S13_T.timer, S13_T.chord, S13_T.strike]).toEqual([0, 60, 90, 173]);
  });

  it('has five suppliers SUP-A … SUP-E', () => {
    expect([...SUPPLIERS]).toEqual(['SUP-A', 'SUP-B', 'SUP-C', 'SUP-D', 'SUP-E']);
  });

  it('runs the stopwatch on the counterTicks rhythm and settles on « < 10 ms » on the last tick', () => {
    expect(timerText(S13_T.timer - 1)).toBeNull();
    expect(timerText(S13_T.timer)).toMatch(/^\d,\d ms$/);
    // 16 ticks per second for one second: the last (settling) tick is 15/16 s after the cue.
    expect(S13_T.settle).toBe(S13_T.timer + Math.floor((15 * 30) / 16 + 0.5));
    expect(timerText(S13_T.settle - 1)).not.toBe('< 10 ms');
    expect(timerText(S13_T.settle)).toBe('< 10 ms');
    expect(timerText(frames + 15)).toBe('< 10 ms');
    // Running values only climb, and stay under 10 ms.
    let last = -1;
    for (let f = S13_T.timer; f < S13_T.settle; f++) {
      const v = Number(timerText(f)!.replace(' ms', '').replace(',', '.'));
      expect(v).toBeGreaterThanOrEqual(last);
      expect(v).toBeLessThan(10);
      last = v;
    }
  });

  it('presses SUP-A, SUP-C and SUP-D as a chord rolled upward in 32nds from S13.chord, never B or E', () => {
    const before = keyStates(S13_T.chord - 1);
    for (const k of before) expect(k.press).toBe(0);
    const firstDown = (id: string): number => {
      for (let f = 0; f < frames; f++) if (keyStates(f).find((k) => k.label === id)!.press > 0) return f;
      return Infinity;
    };
    expect(firstDown('SUP-A')).toBe(S13_T.chord);
    expect(firstDown('SUP-C')).toBe(S13_T.chord + 2);
    expect(firstDown('SUP-D')).toBe(S13_T.chord + 4);
    expect(firstDown('SUP-E')).toBe(Infinity);
    // B only takes the dead note on the strike, never a fill.
    for (let f = 0; f <= frames + 15; f++) {
      const b = keyStates(f).find((k) => k.label === 'SUP-B')!;
      const e = keyStates(f).find((k) => k.label === 'SUP-E')!;
      expect(b.fill).toBe(0);
      expect(e.fill).toBe(0);
      expect(e.press).toBe(0);
    }
  });

  it('fills the chosen keys to their share, all under the 50 % cap, the whole order placed', () => {
    expect(CAP_SHARE).toBe(0.5);
    const total = Object.values(SHARES).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 9);
    for (let f = 0; f <= frames + 15; f++) for (const k of keyStates(f)) expect(k.fill).toBeLessThanOrEqual(CAP_SHARE);
    const settled = keyStates(S13_T.chord + 40);
    for (const [id, share] of Object.entries(SHARES)) expect(settled.find((k) => k.label === id)!.fill).toBeCloseTo(share, 6);
  });

  it('strikes SUP-B on « cher » (crit cue) and only then', () => {
    const b = (f: number) => keyStates(f).find((k) => k.label === 'SUP-B')!;
    expect(b(S13_T.strike - 1).strike).toBe(0);
    expect(b(S13_T.strike).strike).toBeGreaterThan(0);
    expect(b(S13_T.strike + 6).strike).toBe(1);
    expect(b(frames + 15).strike).toBe(1);
    for (const id of ['SUP-A', 'SUP-C', 'SUP-D', 'SUP-E']) expect(keyStates(frames + 15).find((k) => k.label === id)!.strike).toBe(0);
  });
});

describe('S14 · pont', () => {
  const frames = sceneFrames('S14');

  it('reads its frames from the cues: three plucks on their words, the split on « données »', () => {
    expect(S14_T.plucks).toEqual([cueLocal('S14', 'S14.pluck1'), cueLocal('S14', 'S14.pluck2'), cueLocal('S14', 'S14.pluck3')]);
    expect(S14_T.plucks).toEqual([38, 105, 176]);
    expect(S14_T.split).toBe(cueLocal('S14', 'S14.split'));
    expect(S14_T.split).toBe(210);
  });

  it('names the strings résumé, raisons, hypothèses', () => {
    expect([...STRING_NAMES]).toEqual(['résumé', 'raisons', 'hypothèses']);
  });

  it('plucks with an envelope of 14·e^(−(f−cue)/20) px', () => {
    const c = S14_T.plucks[1];
    expect(pluckEnvelope(c - 1, c)).toBe(0);
    expect(pluckEnvelope(c, c)).toBe(14);
    expect(pluckEnvelope(c + 20, c)).toBeCloseTo(14 / Math.E, 9);
    expect(pluckEnvelope(c + 60, c)).toBeCloseTo(14 * Math.exp(-3), 9);
  });

  it('vibrates as a 6 Hz standing wave: one period every 5 frames, peak on the pluck', () => {
    const c = S14_T.plucks[0];
    expect(pluckDisplacement(c, c)).toBe(14);
    for (let t = 0; t < 30; t++) {
      const a = pluckDisplacement(c + t, c) / pluckEnvelope(c + t, c);
      const b = pluckDisplacement(c + t + 5, c) / pluckEnvelope(c + t + 5, c);
      expect(a).toBeCloseTo(b, 9);
      expect(a).toBeCloseTo(Math.cos((2 * Math.PI * 6 * t) / 30), 9);
    }
  });

  it('converts px into the Threads shader units (≈ ±0.175 · amplitude canvas heights)', () => {
    expect(THREADS_UNIT).toBe(0.175);
    expect(threadsAmplitude(14, 200)).toBeCloseTo(14 / (0.175 * 200), 12);
    expect(threadsAmplitude(-7, 200)).toBeCloseTo(-0.2, 12);
  });

  it('mixes the string colour in hex, the only format ogl parses', () => {
    expect(mixHex('#9a9ea3', '#6fb58a', 0)).toBe('#9a9ea3');
    expect(mixHex('#9a9ea3', '#6fb58a', 1)).toBe('#6fb58a');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#000000', '#ffffff', 3)).toBe('#ffffff');
  });

  it('tints a string ok only from its pluck', () => {
    const c = S14_T.plucks[2];
    expect(stringTint(c - 1, c)).toBe(0);
    expect(stringTint(c, c)).toBe(1);
    expect(stringTint(c + 20, c)).toBeLessThan(0.5);
  });

  it('types the code panel verbatim (spec § 4 S14)', () => {
    expect(CODE_LINES.map((_, i) => codeLineText(i))).toEqual([
      '@dataclass',
      'class Recommendation:',
      '    reasons: list[str]   # obligatoire',
      'def test_…(): assert rec.reasons   # vérifié',
    ]);
  });

  it('finishes « # vérifié » by the third pluck and everything before the split', () => {
    const segments = typedSegments();
    const last = segments[segments.length - 1];
    expect(last.text).toBe('   # vérifié');
    expect(last.end).toBeLessThan(S14_T.plucks[2]);
    for (const s of segments) {
      expect(s.end).toBeGreaterThanOrEqual(s.start);
      expect(s.end).toBeLessThan(S14_T.split);
    }
    for (let k = 1; k < segments.length; k++) expect(segments[k].start).toBeGreaterThan(segments[k - 1].start);
  });

  it('wobbles the violet track at 5 Hz, ±1.5 px, only once the demo is on screen', () => {
    expect(violetWobble(400, S14_T.split - 1)).toBe(0);
    let peak = 0;
    for (let f = S14_T.split + 3; f < frames + 15; f++) {
      for (let x = 0; x < 800; x += 37) {
        const y = violetWobble(x, f);
        peak = Math.max(peak, Math.abs(y));
        // 5 Hz at 30 fps: the same shape every 6 frames.
        expect(y).toBeCloseTo(violetWobble(x, f + 6), 9);
      }
    }
    expect(peak).toBeLessThanOrEqual(1.5 + 1e-9);
    expect(peak).toBeGreaterThan(1.2);
  });

  it('keeps the wobble in phase with the pad vibrato (film clock)', () => {
    // score.py: bend = 15 · sin(2π · 5 · s / SR), s the absolute sample; one frame = 1600 samples.
    const f = S14_T.split + 20;
    const absolute = sceneStart('S14') + f;
    expect(violetWobble(0, f)).toBeCloseTo(1.5 * Math.sin((2 * Math.PI * 5 * absolute) / 30), 9);
  });
});
