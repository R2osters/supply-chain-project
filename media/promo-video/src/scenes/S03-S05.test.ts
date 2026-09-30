// src/scenes/S03-S05.test.ts — the timed logic of S03 (collision), S04 (logo flight, hops, stamps) and S05 (darkening,
// freeze). Positions come from the cues; these tests pin the frames where the spec wants something exact.
import {interpolateColors} from 'remotion';
import {cueLocal, sceneFrames, seriesLocal, sceneStart} from '../lib/timeline';
import {palette} from '../theme/tokens';
import {HUD_LOGO, HUD_LOGO_FROM, THEME_END_FRAMES} from '../components/Hud';
import {DIVIDER_X, INNER_GAP, SQUASH_FROM, squash} from './S03DeuxQuestions';
import {containerAt, FLIGHT, HOP_FRAMES, logoFlight, LOCKUP_LOGO, ROUTE, ROUTE_LABELS, stampStates} from './S04Relier';
import {bgAt, darkness, motionFrame} from './S05FausseNote';

describe('S03 collision', () => {
  const end = sceneFrames('S03');

  it('leaves both blocks whole until local frame 200', () => {
    expect(SQUASH_FROM).toBe(200);
    expect(squash(0)).toEqual({scaleX: 1, shift: 0});
    expect(squash(SQUASH_FROM)).toEqual({scaleX: 1, shift: 0});
  });

  it('crushes them to scaleX 0.2 against the divider on the downbeat of 24.0 s', () => {
    expect(end).toBe(240);
    const s = squash(end);
    expect(s.scaleX).toBeCloseTo(0.2, 9);
    // The inner edges start INNER_GAP px from the divider and meet on it.
    expect(DIVIDER_X - INNER_GAP + s.shift).toBeCloseTo(DIVIDER_X, 9);
    expect(squash(end + 15)).toEqual(s);
  });

  it('accelerates (ease-in): the second half moves more than the first', () => {
    const mid = (SQUASH_FROM + end) / 2;
    const first = squash(SQUASH_FROM).scaleX - squash(mid).scaleX;
    const second = squash(mid).scaleX - squash(end).scaleX;
    expect(second).toBeGreaterThan(first * 1.5);
    for (let f = SQUASH_FROM; f < end; f++) expect(squash(f + 1).scaleX).toBeLessThanOrEqual(squash(f).scaleX);
  });
});

describe('S04 logo flight', () => {
  const landing = HUD_LOGO_FROM - sceneStart('S04');

  it('flies over local frames 60-75 and lands when the HUD logo appears', () => {
    expect(landing).toBe(75);
    expect(FLIGHT).toEqual({from: 60, to: landing});
  });

  it('sits in the lockup at 280 px, stroke 3, when it takes off', () => {
    const f = logoFlight(FLIGHT.from);
    expect(f.visible).toBe(true);
    expect(f).toMatchObject({x: LOCKUP_LOGO.x, y: LOCKUP_LOGO.y, size: 280, stroke: 3});
  });

  it('lands exactly on the HUD logo box and hands over to it at absolute frame 795', () => {
    const f = logoFlight(landing);
    expect(f.visible).toBe(false);
    expect(f.x).toBeCloseTo(HUD_LOGO.x, 9);
    expect(f.y).toBeCloseTo(HUD_LOGO.y, 9);
    expect(f.size).toBeCloseTo(HUD_LOGO.size, 9);
    expect(f.stroke).toBeCloseTo(HUD_LOGO.stroke, 9);
    const last = logoFlight(landing - 1);
    expect(last.visible).toBe(true);
    expect(Math.abs(last.x - HUD_LOGO.x)).toBeLessThan(1);
    expect(Math.abs(last.y - HUD_LOGO.y)).toBeLessThan(1);
    expect(Math.abs(last.size - HUD_LOGO.size)).toBeLessThan(1);
    expect(logoFlight(landing + 100).visible).toBe(false);
  });
});

describe('S04 container hops', () => {
  const hops = seriesLocal('S04', 'S04.hop');

  it('makes 8 hops, one per beat', () => {
    expect(hops).toHaveLength(8);
    for (let i = 1; i < hops.length; i++) expect(hops[i] - hops[i - 1]).toBe(15);
  });

  it('waits at the supplier gate, lands on each hop cue, and ends at the client dock', () => {
    const step = (ROUTE.end - ROUTE.start) / 8;
    expect(containerAt(0)).toEqual({x: ROUTE.start, lift: 0});
    expect(containerAt(hops[0] - HOP_FRAMES)).toEqual({x: ROUTE.start, lift: 0});
    hops.forEach((h, i) => {
      const c = containerAt(h);
      expect(c.x).toBeCloseTo(ROUTE.start + (i + 1) * step, 9);
      expect(c.lift).toBe(0);
    });
    expect(containerAt(hops[7] + 200)).toEqual({x: ROUTE.end, lift: 0});
    expect(ROUTE.start).toBeGreaterThan(200);
    expect(ROUTE.end).toBeLessThan(1720);
  });

  it('is in the air between take-off and landing', () => {
    const h = hops[3];
    expect(containerAt(h - HOP_FRAMES / 2).lift).toBeGreaterThan(20);
    expect(containerAt(h - HOP_FRAMES / 2).x).toBeGreaterThan(containerAt(h - HOP_FRAMES).x);
    expect(containerAt(h - HOP_FRAMES / 2).x).toBeLessThan(containerAt(h).x);
  });
});

describe('S04 route labels', () => {
  it('raise each word on its own word of the voice, in reading order (« du » is said twice)', () => {
    // Two words may share a sixteenth (« du fournisseur »), never run backwards.
    for (const label of [ROUTE_LABELS.gate, ROUTE_LABELS.dock]) {
      for (let i = 1; i < label.length; i++) expect(label[i].at).toBeGreaterThanOrEqual(label[i - 1].at);
    }
    expect(ROUTE_LABELS.dock[0].at).toBeGreaterThan(ROUTE_LABELS.gate[2].at);
    expect(ROUTE_LABELS.dock.map((w) => w.text).join(' ')).toBe('QUAI DU CLIENT');
    expect(ROUTE_LABELS.gate.map((w) => w.text).join(' ')).toBe('PORTE DU FOURNISSEUR');
  });
});

describe('S04 stamps', () => {
  const cues = ['S04.quoi', 'S04.chezqui', 'S04.quand', 'S04.route'].map((id) => cueLocal('S04', id));

  it('drops each stamp on its word cue', () => {
    cues.forEach((c, i) => {
      expect(stampStates(c - 1)[i].visible).toBe(false);
      expect(stampStates(c)[i].visible).toBe(true);
    });
  });

  it('attenuates each stamp once the next one lands, never the last', () => {
    const last = cues[3] + 60;
    const s = stampStates(last);
    expect(s.map((x) => x.visible)).toEqual([true, true, true, true]);
    expect(s[0].dim).toBeCloseTo(1, 9);
    expect(s[2].dim).toBeCloseTo(1, 9);
    expect(s[3].dim).toBe(0);
    expect(stampStates(cues[1] - 1)[0].dim).toBe(0);
  });

  it('settles at scale 1', () => {
    for (const x of stampStates(cues[3] + 60)) expect(x.scale).toBeCloseTo(1, 9);
    expect(stampStates(cues[0])[0].scale).toBeGreaterThan(1.1);
  });
});

describe('S05 darkening and freeze', () => {
  const end = sceneFrames('S05');
  const silence = cueLocal('S05', 'S05.silence');

  it('darkens over the same last frames as the HUD cross-fade', () => {
    expect(THEME_END_FRAMES).toBe(60);
    expect(darkness(end - THEME_END_FRAMES)).toBe(0);
    expect(darkness(end - THEME_END_FRAMES / 2)).toBeCloseTo(0.5, 9);
    expect(darkness(end)).toBe(1);
    expect(darkness(end + 15)).toBe(1);
    expect(darkness(0)).toBe(0);
  });

  it('moves the background from #e3e4e6 to #121314', () => {
    const rgb = (hex: string) => interpolateColors(0, [0, 1], [hex, hex]);
    expect(bgAt(0)).toBe(rgb(palette('light').bg));
    expect(bgAt(end)).toBe(rgb(palette('dark').bg));
    expect(palette('light').bg).toBe('#e3e4e6');
    expect(palette('dark').bg).toBe('#121314');
  });

  it('freezes every movement from S05.silence', () => {
    expect(silence).toBe(345);
    expect(motionFrame(silence - 1)).toBe(silence - 1);
    expect(motionFrame(silence)).toBe(silence);
    expect(motionFrame(end + 15)).toBe(silence);
  });
});
