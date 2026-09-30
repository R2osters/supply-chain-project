// src/scenes/refrain.test.ts — the event → state logic of the refrain and the drop (S06-S08, spec § 4): timings read
// from the cues, the needle and its readout, the cameras, the click choreography, the purchase order's ride, the drop.
import {cueLocal, sceneFrames, seriesLocal, wordLocal} from '../lib/timeline';
import {FRAMES_PER_BEAT, quantize} from '../lib/beat';
import {armAngle, CELLS, RING_CENTER} from '../components/LoopSequencer';
import {zoneAt} from '../components/Gauge';
import {armDegAt, armSequencerFrame, cellBox, IDENTITY, intersects, rectCenter, STATION_DEG, STATION_RECTS, toScreen, travelTo, type ArmPath, type Rect} from './refrain';
import {S06_ARM, S06_PANEL, S06_T, s06Camera, s06NeedleValue, s06PanelRect, s06Readout} from './S06Boucle1';
import {BUTTON_RECT, clickFx, clusterNotes, holdFill, poRect, REC_CARD, S07_ARM, S07_T, s07Camera, WAVE_CLIP_Y} from './S07Boucle2';
import {DROP_WORDS, dropCellColors, dropWordAt, dropWordRise, ringTurn} from './S08Drop';

const MARGIN = 96;
const inFrame = (r: Rect) => r.x >= MARGIN && r.y >= MARGIN && r.x + r.w <= 1920 - MARGIN && r.y + r.h <= 1080 - MARGIN;
const HUB: Rect = {x: RING_CENTER.x - 60, y: RING_CENTER.y - 60, w: 120, h: 120};
/** The arm's angle wrapped to 0..360. */
const armAt = (f: number, path: ArmPath) => ((armDegAt(f, path) % 360) + 360) % 360;
/** A notch path moves one 22.5° step per beat in 6 frames, on beats, and rests otherwise. */
const expectNotches = (path: ArmPath, frames: number) => {
  path.notches.forEach((s, k) => {
    expect(s % FRAMES_PER_BEAT).toBe(0);
    if (k > 0) expect(s - path.notches[k - 1]).toBeGreaterThanOrEqual(FRAMES_PER_BEAT);
  });
  for (let f = 1; f <= frames + 15; f++) {
    const d = armDegAt(f, path) - armDegAt(f - 1, path);
    const moving = path.notches.some((s) => f > s && f <= s + 6);
    if (moving) expect(d).toBeGreaterThan(0);
    else expect(d).toBe(0);
  }
  for (const s of path.notches) expect(armDegAt(s + 6, path) - armDegAt(s, path)).toBe(22.5);
};

describe('refrain world', () => {
  it('keeps the four stations inside the margins, clear of every cell and of the hub', () => {
    expect(STATION_RECTS).toHaveLength(4);
    for (const r of STATION_RECTS) {
      expect(inFrame(r)).toBe(true);
      expect(intersects(r, HUB)).toBe(false);
      for (let i = 0; i < 16; i++) expect(intersects(r, cellBox(i))).toBe(false);
    }
  });

  it('drives the sequencer arm along a notch path: rest, one notch per beat in 6 frames, rest', () => {
    const path: ArmPath = {fromDeg: 90, notches: travelTo(60)};
    expect(path.notches).toEqual([15, 30, 45, 60]);
    expect(armDegAt(0, path)).toBe(90);
    expect(armDegAt(14, path)).toBe(90);
    expect(armDegAt(15, path)).toBe(90);
    expect(armDegAt(18, path)).toBeGreaterThan(90);
    expect(armDegAt(21, path)).toBe(112.5);
    expect(armDegAt(66, path)).toBe(180);
    expect(armDegAt(500, path)).toBe(180);
    // The sequencer frame always lands on the free-running arm's own curve.
    expect(armAngle(armSequencerFrame(40, path))).toBe(armDegAt(40, path));
    expect(armDegAt(0, {fromDeg: 0, notches: []})).toBe(0);
    expectNotches(path, 80);
  });

  it('maps the camera focus to the centre of the frame', () => {
    expect(toScreen({x: 123, y: 456}, IDENTITY)).toEqual({x: 123, y: 456});
    const cam = {scale: 2.2, focus: {x: 1534, y: 540}};
    expect(toScreen(cam.focus, cam)).toEqual({x: 960, y: 540});
  });
});

describe('S06 · the loop (1)', () => {
  it('reads its timings from the cues and the voice', () => {
    expect(S06_T.drop).toBe(cueLocal('S06', 'S06.drop'));
    expect(S06_T.dbWrite).toBe(cueLocal('S06', 'S06.dbWrite'));
    expect(S06_T.needle).toBe(cueLocal('S06', 'S06.needle'));
    expect(S06_T.warn60).toBe(S06_T.needle + 8); // Ruling R12
    expect(S06_T.risk).toBe(S06_T.needle + 15);
    expect(S06_T.push).toBe(quantize(wordLocal('S06', "L'optimisation").start, 'beat'));
    // Three SKUs recalculated one beat apart, the last one on the needle cue, all after the panel has opened.
    expect(S06_T.skus).toEqual([S06_T.needle - 30, S06_T.needle - 15, S06_T.needle]);
    for (const at of S06_T.skus) {
      expect(at % FRAMES_PER_BEAT).toBe(0);
      expect(at).toBeGreaterThan(S06_T.pushEnd);
    }
    expect(S06_T.recoilEnd).toBe(sceneFrames('S06'));
    expect(S06_T.recoil).toBe(S06_T.recoilEnd - 15); // spec: « recul … sur les images 285-300 »
  });

  it('springs the needle 0 → 68, crossing 60 exactly on the warn cue and settling in the crit zone', () => {
    expect(s06NeedleValue(S06_T.needle - 1)).toBe(0);
    expect(s06NeedleValue(S06_T.needle)).toBe(0);
    for (let f = S06_T.needle; f < S06_T.warn60; f++) expect(s06NeedleValue(f)).toBeLessThanOrEqual(60);
    expect(s06NeedleValue(S06_T.warn60)).toBeGreaterThan(60);
    expect(zoneAt(s06NeedleValue(S06_T.warn60))).toBe('warn');
    expect(zoneAt(s06NeedleValue(S06_T.risk))).toBe('crit');
    const peak = Math.max(...Array.from({length: 40}, (_, k) => s06NeedleValue(S06_T.needle + k)));
    expect(peak).toBeGreaterThan(72); // « dépasse jusque vers 74 »
    expect(peak).toBeLessThan(75);
  });

  it('shows the readout from the needle, in ink, then « 68 % » in crit from the risk cue to the end of the tail', () => {
    expect(s06Readout(S06_T.needle - 1)).toBeNull();
    expect(s06Readout(S06_T.needle)?.tone).toBe('ink');
    expect(s06Readout(S06_T.risk - 1)?.tone).toBe('ink');
    for (let f = S06_T.risk; f <= sceneFrames('S06') + 15; f++) expect(s06Readout(f)).toEqual({text: '68 %', tone: 'crit'});
  });

  it('pushes onto OPTIMISER and recoils to the whole ring by the last frame', () => {
    expect(s06Camera(0)).toEqual(IDENTITY);
    expect(s06Camera(S06_T.push)).toEqual(IDENTITY);
    expect(s06Camera(S06_T.pushEnd).scale).toBeGreaterThan(1.5);
    expect(s06Camera(S06_T.recoilEnd)).toEqual(IDENTITY);
    expect(s06Camera(S06_T.recoilEnd + 15)).toEqual(IDENTITY);
    expect(s07Camera(0)).toEqual(IDENTITY); // the cut to S07 is seamless
  });

  it('rests the arm on the station at work and moves it between stations a notch per beat', () => {
    expectNotches(S06_ARM, sceneFrames('S06'));
    // SUIVRE from the drop until the event is written.
    for (let f = S06_T.drop; f <= S06_T.dbWrite; f++) expect(armAt(f, S06_ARM)).toBe(STATION_DEG[0]);
    // On OPTIMISER before the camera pushes onto it, and while it opens.
    for (let f = S06_T.push - 3; f < S06_T.pushEnd; f++) expect(armAt(f, S06_ARM)).toBe(STATION_DEG[1]);
    // Passed to RECOMMANDATION by the end of the recoil, where S07 picks it up.
    expect(armAt(S06_T.recoil - 1, S06_ARM)).toBeLessThan(STATION_DEG[2]);
    for (let f = S06_T.recoil + 6; f <= sceneFrames('S06') + 15; f++) expect(armAt(f, S06_ARM)).toBe(STATION_DEG[2]);
    expect(armAt(sceneFrames('S06'), S06_ARM)).toBe(armAt(0, S07_ARM));
  });

  it('opens the OPTIMISER station into the gauge panel and closes it back', () => {
    expect(s06PanelRect(S06_T.push - 1)).toBeNull();
    expect(s06PanelRect(S06_T.push)).toEqual(STATION_RECTS[1]);
    expect(s06PanelRect(S06_T.pushEnd)).toEqual(S06_PANEL);
    expect(inFrame(S06_PANEL)).toBe(true);
    expect(s06PanelRect(S06_T.recoilEnd)).toBeNull();
  });
});

describe('S07 · the loop (2)', () => {
  it('reads its timings from the cues', () => {
    expect(S07_T.resolve).toBe(cueLocal('S07', 'S07.resolve'));
    expect(S07_T.rows).toEqual(seriesLocal('S07', 'S07.rows'));
    expect(S07_T.hold).toBe(cueLocal('S07', 'S07.hold'));
    expect(S07_T.click).toBe(180);
    expect(S07_T.click).toBe(cueLocal('S07', 'S07.click'));
    expect(S07_T.po).toBe(cueLocal('S07', 'S07.po'));
    expect(S07_T.live).toEqual(seriesLocal('S07', 'S07.live'));
  });

  it('starts the arm on RECOMMANDATION as the camera pushes there, and brings the button in when it reaches 9 o’clock', () => {
    expectNotches(S07_ARM, sceneFrames('S07'));
    for (let f = S07_T.push; f <= S07_T.pushEnd; f++) expect(armAt(f, S07_ARM)).toBe(STATION_DEG[2]);
    const at = S07_T.buttonIn;
    expect(armAt(at, S07_ARM)).toBe(STATION_DEG[3]);
    for (let f = 0; f < at; f++) expect(armAt(f, S07_ARM)).not.toBe(STATION_DEG[3]);
    expect(at).toBeGreaterThan(S07_T.resolve);
    expect(at).toBeLessThan(S07_T.hold);
    // On HUMAIN through the hold, the click and the recoil.
    for (let f = at; f < S07_T.steps[0] - FRAMES_PER_BEAT; f++) expect(armAt(f, S07_ARM)).toBe(STATION_DEG[3]);
  });

  it('carries the purchase order round to SUIVRE with the arm, back at 12 h before the first live cue', () => {
    // The arm joins the order at its first rest, then both step on the same beats.
    const joined = S07_T.steps[0] - FRAMES_PER_BEAT + 6;
    for (let f = joined; f <= S07_T.ringTo; f++) {
      const r = poRect(f)!;
      const c = rectCenter(r);
      const deg = ((Math.atan2(c.x - RING_CENTER.x, RING_CENTER.y - c.y) * 180) / Math.PI + 360) % 360;
      expect(Math.abs(((deg - armAt(f, S07_ARM) + 540) % 360) - 180)).toBeLessThan(0.5);
    }
    for (let f = S07_T.ringTo; f <= sceneFrames('S07') + 15; f++) expect(armAt(f, S07_ARM)).toBe(STATION_DEG[0]);
    expect(S07_T.ringTo).toBeLessThan(S07_T.live[0]);
  });

  it('fills the button over the beat before the click', () => {
    expect(holdFill(S07_T.hold - 1)).toBe(0);
    expect(holdFill(S07_T.hold)).toBe(0);
    for (let f = S07_T.hold + 1; f <= S07_T.click; f++) expect(holdFill(f)).toBeGreaterThan(holdFill(f - 1));
    expect(holdFill(S07_T.click)).toBe(1);
    expect(holdFill(S07_T.click + 30)).toBe(1);
  });

  it('lands the press, the shockwave and the punch zoom on the click frame', () => {
    const before = clickFx(S07_T.click - 1);
    expect(before.pressed).toBe(0);
    expect(before.zoom).toBe(1);
    expect(before.wave).toBeNull();
    const hit = clickFx(S07_T.click);
    expect(hit.pressed).toBe(1);
    expect(hit.zoom).toBeCloseTo(1.03, 9);
    expect(hit.wave?.radius).toBe(0);
    expect(clickFx(S07_T.click + 1).wave!.radius).toBeGreaterThan(0);
    expect(clickFx(S07_T.click + 18).wave?.radius).toBe(700);
    expect(clickFx(S07_T.click + 19).wave).toBeNull();
    expect(clickFx(S07_T.click + 12).zoom).toBe(1);
    expect(clickFx(S07_T.click + 12).pressed).toBe(0);
    // The wave stops above the HUD's section tape.
    expect(WAVE_CLIP_Y).toBeLessThanOrEqual(1080 - MARGIN);
  });

  it('resolves the crit cluster into a vertical ok chord on « C »', () => {
    expect(clusterNotes(S07_T.resolve - 1).color).toBe('crit');
    expect(clusterNotes(S07_T.resolve).color).toBe('ok');
    const chord = clusterNotes(S07_T.resolve + 12).notes;
    expect(new Set(chord.map((n) => n.x)).size).toBe(1);
    expect(chord[1].y - chord[0].y).toBeCloseTo(chord[2].y - chord[1].y, 9);
  });

  it('lays the card and the button out inside the margins, the button under the card', () => {
    expect(inFrame(REC_CARD)).toBe(true);
    expect(inFrame(BUTTON_RECT)).toBe(true);
    expect(BUTTON_RECT.y).toBeGreaterThan(REC_CARD.y + REC_CARD.h);
    expect(BUTTON_RECT.w).toBe(560);
    expect(BUTTON_RECT.h).toBe(120);
  });

  it('brings the purchase order out of the button on its cue and rides it round the ring to the SUIVRE station', () => {
    expect(poRect(S07_T.po - 1)).toBeNull();
    expect(poRect(S07_T.po)).not.toBeNull();
    // It ratchets one cell per beat, in 6 frames (spec § 3.5); wherever it rests it hides neither the station it is
    // heading for nor the hub, and stays inside the frame.
    const moving = (f: number) => S07_T.steps.some((s) => f >= s && f < s + 6);
    for (let f = S07_T.ringFrom; f <= S07_T.ringTo; f++) {
      const r = poRect(f)!;
      expect(r.y).toBeGreaterThanOrEqual(36);
      expect(r.x).toBeGreaterThanOrEqual(MARGIN);
      expect(intersects(r, HUB)).toBe(false);
      if (!moving(f)) expect(intersects(r, STATION_RECTS[0])).toBe(false);
    }
    for (const s of S07_T.steps) expect(s % FRAMES_PER_BEAT).toBe(0);
    const end = poRect(S07_T.ringTo)!;
    expect(end.x + end.w / 2).toBeCloseTo(960, 6);
    expect(S07_T.ringTo).toBeLessThanOrEqual(S07_T.live[0]);
  });
});

describe('S08 · drop', () => {
  it('rotates the five words on the beat cues, with the colour of each cue', () => {
    expect(DROP_WORDS.map((w) => w.text)).toEqual(['OBSERVER', 'RECALCULER', 'RECOMMANDER', 'ACCEPTER', 'EXÉCUTER']);
    expect(DROP_WORDS.map((w) => w.color)).toEqual(['crit', 'warn', 'ok', 'ink', 'live']);
    expect(DROP_WORDS.map((w) => w.marker)).toEqual(['dot', 'dot', 'dot', 'square', 'dot']);
    expect(DROP_WORDS.map((w) => w.at)).toEqual(seriesLocal('S08', 'S08.word'));
    DROP_WORDS.forEach((w, i) => expect(dropWordAt(w.at)).toBe(i));
    expect(dropWordAt(sceneFrames('S08') + 15)).toBe(4);
  });

  it('hands each word over to the next on one frame, never through an empty or a dim frame', () => {
    const last = sceneFrames('S08') + 15;
    for (let f = 0; f <= last; f++) {
      expect(dropWordAt(f)).not.toBeNull();
      expect(dropWordRise(f)).toBeGreaterThan(0.5);
    }
    for (const w of DROP_WORDS.slice(1)) {
      const first = w.at - 2; // the word appears 2 frames before its beat (spec § 3.5)
      const i = DROP_WORDS.indexOf(w);
      expect(dropWordAt(first - 1)).toBe(i - 1);
      expect(dropWordRise(first - 1)).toBe(1);
      expect(dropWordAt(first)).toBe(i);
      for (let f = first + 1; f <= first + 4; f++) expect(dropWordRise(f)).toBeGreaterThan(dropWordRise(f - 1));
      expect(dropWordRise(w.at + 3)).toBe(1);
    }
  });

  it('sweeps each word’s colour over the ring from its cue, over the colour of the word before', () => {
    expect(dropCellColors(-1).every((c) => c === null)).toBe(true);
    DROP_WORDS.forEach((w, i) => {
      const under = i === 0 ? null : DROP_WORDS[i - 1].color;
      // Until the cue, the whole ring keeps the previous colour, through the frames the new word is already up.
      for (let f = w.at - 3; f < w.at; f++) if (i > 0) expect(dropCellColors(f)).toEqual(Array(CELLS).fill(under));
      const onCue = dropCellColors(w.at);
      expect(onCue[0]).toBe(w.color);
      expect(onCue[CELLS - 1]).toBe(under);
      for (let f = w.at; f < w.at + 8; f++) {
        const cells = dropCellColors(f);
        const lit = cells.filter((c) => c === w.color).length;
        expect(cells.slice(0, lit).every((c) => c === w.color)).toBe(true);
        expect(cells.slice(lit).every((c) => c === under)).toBe(true);
      }
      expect(dropCellColors(w.at + 8)).toEqual(Array(CELLS).fill(w.color));
    });
  });

  it('spins the ring one turn per bar, continuously', () => {
    expect(ringTurn(0)).toBe(0);
    expect(ringTurn(30)).toBe(180);
    expect(ringTurn(60)).toBe(360);
    expect(ringTurn(61)).toBeCloseTo(366, 9);
  });
});
