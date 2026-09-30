// src/scenes/refrain.test.ts — the event → state logic of the refrain and the drop (S06-S08, spec § 4): timings read
// from the cues, the needle and its readout, the cameras, the click choreography, the purchase order's ride, the drop.
import {cueLocal, sceneFrames, seriesLocal, wordLocal} from '../lib/timeline';
import {FRAMES_PER_BEAT, quantize} from '../lib/beat';
import {armAngle, RING_CENTER} from '../components/LoopSequencer';
import {zoneAt} from '../components/Gauge';
import {cellBox, IDENTITY, intersects, STATION_RECTS, toScreen, type Rect} from './refrain';
import {S06_PANEL, S06_T, s06Camera, s06NeedleValue, s06PanelRect, s06Readout} from './S06Boucle1';
import {BUTTON_RECT, clickFx, clusterNotes, holdFill, poRect, REC_CARD, S07_T, s07ArmFrame, s07Camera} from './S07Boucle2';
import {DROP_WORDS, dropWordAt, ringTurn} from './S08Drop';

const MARGIN = 96;
const inFrame = (r: Rect) => r.x >= MARGIN && r.y >= MARGIN && r.x + r.w <= 1920 - MARGIN && r.y + r.h <= 1080 - MARGIN;
const HUB: Rect = {x: RING_CENTER.x - 60, y: RING_CENTER.y - 60, w: 120, h: 120};

describe('refrain world', () => {
  it('keeps the four stations inside the margins, clear of every cell and of the hub', () => {
    expect(STATION_RECTS).toHaveLength(4);
    for (const r of STATION_RECTS) {
      expect(inFrame(r)).toBe(true);
      expect(intersects(r, HUB)).toBe(false);
      for (let i = 0; i < 16; i++) expect(intersects(r, cellBox(i))).toBe(false);
    }
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

  it('continues the S06 arm and brings the button in when the arm reaches 9 o’clock', () => {
    expect(s07ArmFrame(0)).toBe(sceneFrames('S06'));
    const at = S07_T.buttonIn;
    expect(((armAngle(s07ArmFrame(at)) % 360) + 360) % 360).toBe(270);
    for (let f = 0; f < at; f++) expect(((armAngle(s07ArmFrame(f)) % 360) + 360) % 360).not.toBe(270);
    expect(at).toBeGreaterThan(S07_T.resolve);
    expect(at).toBeLessThan(S07_T.hold);
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

  it('spins the ring one turn per bar, continuously', () => {
    expect(ringTurn(0)).toBe(0);
    expect(ringTurn(30)).toBe(180);
    expect(ringTurn(60)).toBe(360);
    expect(ringTurn(61)).toBeCloseTo(366, 9);
  });
});
