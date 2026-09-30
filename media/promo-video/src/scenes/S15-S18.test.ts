// src/scenes/S15-S18.test.ts — the event → state logic of the last four scenes (spec § 4 S15-S18): every timed event
// read from the cues and the voice, the layout kept inside the 96 px margins, and the hand-over of the dot from the
// reprise to the coda.
import {armAngle} from '../components/LoopSequencer';
import {stackBox, topFace} from '../components/IsoStack';
import {FRAMES_PER_BEAT, quantize, roundHalfUp, SIXTEENTH} from '../lib/beat';
import {cue, cueLocal, sceneFrames, sceneStart, seriesLocal, wordLocal} from '../lib/timeline';
import geo from '../../generated/geo.json';
import {
  CHIPS, chipIn, CIRCLE, circleDots, EXPLODED, IN_PC, LABEL_BOXES, lockClosed, PC_GROUP, S15_T, shackle, SLABS, slabAt, statusAt,
} from './S15Fichier';
import {
  CAPTION_BOX, CAPTION_LINES, COAST_CLIP_Y, POLE_Y, S16_T, TILE, TILE_COLS, TILE_ROWS, tileFall, tileState, wifiStrike,
} from './S16HorsLigne';
import {ARRIVALS, clickFx17, holdFill17, lineAt, LINES, litStation, S17_T, s17ArmFrame, SHIPMENTS, STATIONS, tokenAt} from './S17Reprise';
import {DOT_HOME, dotState, logoDraw, RINGS, S18_T, SLOGAN, waveAt} from './S18Coda';

const MARGIN = 96;
interface Box { x: number; y: number; w: number; h: number }
const inside = (r: Box) => r.x >= MARGIN - 1e-9 && r.y >= MARGIN - 1e-9 && r.x + r.w <= 1920 - MARGIN + 1e-9 && r.y + r.h <= 1080 - MARGIN + 1e-9;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const w16 = (screen: string, scene: 'S15' | 'S16' | 'S17' | 'S18') => quantize(wordLocal(scene, screen).start, '16th') - 2;

describe('S15 · un seul fichier', () => {
  it('reads its events from the cues and the voice', () => {
    expect(S15_T.file).toBe(cueLocal('S15', 'S15.file'));
    expect(S15_T.explode).toBe(cueLocal('S15', 'S15.explode'));
    expect(S15_T.windows).toBe(cueLocal('S15', 'S15.windows'));
    expect(S15_T.admin).toBe(cueLocal('S15', 'S15.admin'));
    expect(S15_T.base).toBe(cueLocal('S15', 'S15.base'));
    expect(S15_T.lock).toBe(cueLocal('S15', 'S15.lock'));
    // « et par défaut » opens the last third on a beat: local 240, the downbeat of bar 73.
    expect(S15_T.pc).toBe(quantize(wordLocal('S15', 'et').start, 'beat'));
    expect(S15_T.pc).toBe(240);
  });

  it('explodes the file into four slabs rising bottom first, one sixteenth apart (the D F A D arpeggio)', () => {
    expect(SLABS.map((s) => s.label)).toEqual(['INTERFACE', 'API', 'POSTGRESQL 16 + POSTGIS', 'MOTEUR IA']);
    const {explode, takeoff} = S15_T;
    for (let k = 0; k < 4; k++) expect(takeoff[3 - k]).toBe(explode + roundHalfUp(k * SIXTEENTH));
    // Before the explosion the four slabs are the four bars of the file icon; after it, they sit in the exploded stack.
    for (let i = 0; i < 4; i++) {
      expect(slabAt(i, takeoff[i] - 1).t).toBe(0);
      const landed = slabAt(i, S15_T.pc - 1);
      expect(landed.quad).toBeUndefined();
      expect(landed.slab).toEqual(EXPLODED[i]);
    }
  });

  it('lights the install steps one by one from « installé », in reading order', () => {
    const {done} = S15_T;
    expect(done[0]).toBe(quantize(wordLocal('S15', 'installé').start, '16th'));
    for (let i = 1; i < 4; i++) expect(done[i]).toBeGreaterThan(done[i - 1]);
    for (let i = 0; i < 4; i++) {
      expect(statusAt(i, done[i] - 1).state).not.toBe('done');
      expect(statusAt(i, done[i]).state).toBe('done');
      expect(slabAt(i, done[i] - 1).lit).toBe(0);
      expect(slabAt(i, done[i] + 30).lit).toBe(1);
    }
    // All four are installed before the last third starts.
    expect(done[3] + 14).toBeLessThan(S15_T.pc);
  });

  it('drops each chip on its word', () => {
    expect(CHIPS.map((c) => c.text)).toEqual(['WINDOWS', 'SANS DROITS ADMINISTRATEUR', 'BASE INTÉGRÉE (RECOMMANDÉ)']);
    const at = [S15_T.windows, S15_T.admin, S15_T.base];
    at.forEach((f, i) => {
      expect(chipIn(i, f - 1)).toBe(0);
      expect(chipIn(i, f)).toBeGreaterThan(0);
      expect(chipIn(i, f + 12)).toBe(1);
    });
  });

  it('closes the lock on « PC » and not before', () => {
    expect(lockClosed(S15_T.lock - 1)).toBe(false);
    expect(lockClosed(S15_T.lock)).toBe(true);
    expect(lockClosed(sceneFrames('S15') + 15)).toBe(true);
    // The shackle is home on the cue frame, where the latch sounds.
    expect(shackle(S15_T.lock - 3)).toBe(0);
    expect(shackle(S15_T.lock - 1)).toBeLessThan(1);
    expect(shackle(S15_T.lock)).toBe(1);
  });

  it('keeps the exploded stack and its labels, then the PC group, inside the margins', () => {
    const stack = stackBox(EXPLODED);
    expect(inside(stack)).toBe(true);
    for (const b of LABEL_BOXES) {
      expect(inside(b)).toBe(true);
      expect(overlaps(b, stack)).toBe(false);
    }
    for (let i = 0; i < LABEL_BOXES.length - 1; i++) expect(overlaps(LABEL_BOXES[i], LABEL_BOXES[i + 1])).toBe(false);
    for (const b of PC_GROUP) expect(inside(b)).toBe(true);
    expect(inside({x: CIRCLE.x - CIRCLE.r, y: CIRCLE.y - CIRCLE.r, w: 2 * CIRCLE.r, h: 2 * CIRCLE.r})).toBe(true);
    // The assembled stack fits in the PC screen, inside the dotted circle.
    const block = stackBox(IN_PC);
    expect(Math.hypot(block.x - CIRCLE.x, block.y - CIRCLE.y)).toBeLessThan(CIRCLE.r);
    expect(Math.hypot(block.x + block.w - CIRCLE.x, block.y + block.h - CIRCLE.y)).toBeLessThan(CIRCLE.r);
    // In the exploded view no slab hides the pictogram of the one below it.
    for (let i = 0; i < 3; i++) expect(topFace(EXPLODED[i])[2].y + EXPLODED[i].t).toBeLessThanOrEqual(topFace(EXPLODED[i + 1])[0].y);
  });

  it('closes the dotted circle on its label chip: only the dots behind the chip are left out', () => {
    const chip = PC_GROUP[0];
    const all = circleDots(1);
    const pitch = (2 * Math.PI * CIRCLE.r) / 112;
    // Every other dot is drawn, and none of them touches the chip.
    expect(all.length).toBeGreaterThan(112 - 20);
    for (const p of all) expect(p.y + 2.4 <= chip.y || Math.abs(p.x - CIRCLE.x) >= chip.w / 2).toBe(true);
    // The arc runs down to the chip's top edge on both sides, symmetrically (the old gap stopped ~70 px above it).
    const lowest = (side: number) => Math.max(...all.filter((p) => Math.sign(p.x - CIRCLE.x) === side).map((p) => p.y));
    for (const side of [-1, 1]) {
      expect(lowest(side)).toBeGreaterThan(chip.y - 2.4 - 4 - pitch);
      expect(lowest(side)).toBeLessThan(chip.y);
    }
    expect(lowest(-1)).toBeCloseTo(lowest(1), 6);
    // Drawn clockwise from the bottom: a partial circle is a prefix of the whole one.
    expect(circleDots(0.5)).toEqual(all.slice(0, circleDots(0.5).length));
    expect(circleDots(0.5).length).toBeLessThan(all.length);
  });
});

describe('S16 · hors ligne', () => {
  it('reads its events from the cues', () => {
    expect(S16_T.offline).toBe(cueLocal('S16', 'S16.offline'));
    expect(S16_T.tiles).toBe(cueLocal('S16', 'S16.tiles'));
    expect(cue('S16.offline').color).toBe('crit');
  });

  it('covers the whole frame with square tiles', () => {
    expect(TILE_COLS * TILE).toBe(1920);
    expect(TILE_ROWS * TILE).toBe(1080);
  });

  it('drops the tiles in a diagonal wave on the sixteenths of the tile clicks (28 clicks over 105 frames)', () => {
    const start = sceneStart('S16');
    expect(tileFall(0, 0)).toBe(S16_T.tiles);
    const last = tileFall(TILE_COLS - 1, TILE_ROWS - 1);
    expect(last).toBe(S16_T.tiles + roundHalfUp(27 * SIXTEENTH));
    for (let c = 0; c < TILE_COLS; c++) {
      for (let r = 0; r < TILE_ROWS; r++) {
        const f = tileFall(c, r);
        const abs = start + f;
        expect(Math.abs(abs - quantize(abs, '16th'))).toBeLessThanOrEqual(0.5);
        // Same diagonal, same frame; further down the diagonal, later.
        if (c > 0 && r < TILE_ROWS - 1) expect(tileFall(c - 1, r + 1)).toBe(f);
        if (c > 0) expect(tileFall(c - 1, r)).toBeLessThanOrEqual(f);
        expect(tileState(c, r, f - 1)).toEqual({y: 0, rotate: 0, scale: 1, opacity: 1});
      }
    }
    // Every tile is gone before the scene ends; the map below never moves.
    for (let c = 0; c < TILE_COLS; c++) for (let r = 0; r < TILE_ROWS; r++) expect(tileState(c, r, S16_T.clear)).toBeNull();
    expect(S16_T.clear).toBeLessThan(sceneFrames('S16'));
  });

  it('strikes the Wi-Fi in crit from the offline cue only', () => {
    expect(wifiStrike(S16_T.offline - 1)).toBe(0);
    expect(wifiStrike(S16_T.offline)).toBeGreaterThan(0);
    expect(wifiStrike(S16_T.offline + 8)).toBe(1);
  });

  it('shows the caption on « carte »', () => {
    expect(S16_T.caption).toBe(w16('carte', 'S16'));
  });

  // The map's vertices (land rings) and city dots, from the same generated/geo.json the scene draws.
  const landPoints = geo.world.land
    .split('Z')
    .flatMap((ring) => [...ring.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({x: Number(m[1]), y: Number(m[2])})));

  it('sets the caption on open water, inside the margins, clear of every coast and city', () => {
    expect(CAPTION_LINES.join(' · ')).toBe('FOND DE CARTE EMBARQUÉ · NATURAL EARTH');
    expect(inside(CAPTION_BOX)).toBe(true);
    const gap = (p: {x: number; y: number}) =>
      Math.hypot(Math.max(CAPTION_BOX.x - p.x, 0, p.x - CAPTION_BOX.x - CAPTION_BOX.w), Math.max(CAPTION_BOX.y - p.y, 0, p.y - CAPTION_BOX.y - CAPTION_BOX.h));
    for (const p of landPoints) expect(gap(p)).toBeGreaterThan(60);
    for (const c of geo.world.cities) expect(gap(c)).toBeGreaterThan(60);
  });

  it('draws every coast but not the straight pole edge that closes Antarctica', () => {
    const coastStroke = 1.4 / 2;
    expect(Math.max(...landPoints.map((p) => p.y))).toBe(POLE_Y);
    // Every vertex is either on the pole edge (clipped whole) or a coast whose stroke stays above the clip.
    for (const p of landPoints) {
      if (p.y === POLE_Y) expect(POLE_Y - coastStroke).toBeGreaterThan(COAST_CLIP_Y);
      else expect(p.y + coastStroke).toBeLessThan(COAST_CLIP_Y);
    }
  });
});

describe('S17 · reprise', () => {
  const colorsByStation = ['crit', 'warn', 'ok', 'live'];

  it('sends three demo shipments round the four stations, one arrival per station cue', () => {
    const series = seriesLocal('S17', 'S17.station');
    expect(series).toHaveLength(12);
    // The spec's demo IDs; they share the prefix the stations keep still while the digits roll.
    expect(SHIPMENTS).toEqual(['SHP-0217', 'SHP-0309', 'SHP-0388']);
    expect(STATIONS.map((s) => s.title)).toEqual(['SUIVRE · OBSERVE', 'OPTIMISER · RISQUE', 'RECOMMANDATION', 'HUMAIN · DÉCIDE']);
    ARRIVALS.forEach((a, i) => {
      expect(a.at).toBe(series[i]);
      expect(a.station).toBe(i % 4);
      expect(a.shipment).toBe(Math.floor(i / 4));
      expect(a.color).toBe(cue(`S17.station.${i + 1}`).color);
      // One colour per station: the delay is observed (crit), the risk rises (warn), the answer is ready (ok), it runs (live).
      expect(a.color).toBe(colorsByStation[a.station]);
    });
  });

  it('lands each shipment exactly on its station at its cue', () => {
    for (const a of ARRIVALS) {
      const p = tokenAt(a.shipment, a.at);
      expect(p).not.toBeNull();
      expect(p!.x).toBeCloseTo(STATIONS[a.station].anchor.x, 6);
      expect(p!.y).toBeCloseTo(STATIONS[a.station].anchor.y, 6);
    }
  });

  it('lights one station at a time, for one beat from each arrival', () => {
    for (let f = 0; f <= sceneFrames('S17') + 15; f++) {
      const lit = litStation(f);
      const a = [...ARRIVALS].reverse().find((x) => f >= x.at && f < x.at + FRAMES_PER_BEAT);
      if (!a) expect(lit).toBeNull();
      else expect(lit).toEqual({station: a.station, shipment: a.shipment, color: a.color, since: a.at});
    }
  });

  it('cuts to each kinetic line on its cue, each word on its voice word', () => {
    expect(LINES.map((l) => l.words.map((w) => w.text).join(' '))).toEqual(['LE SUIVI ENTEND.', 'L’OPTIMISATION PROPOSE.', 'VOUS DÉCIDEZ.']);
    const cues = ['S17.line1', 'S17.line2', 'S17.line3'].map((id) => cueLocal('S17', id));
    const spoken = [['Le', 'suivi', 'entend'], ["L'optimisation", 'propose'], ['vous', 'décidez']];
    LINES.forEach((line, k) => {
      line.words.forEach((w, j) => {
        expect(w.at).toBe(Math.max(w16(spoken[k][j], 'S17'), cues[k] - 2));
      });
      expect(line.from).toBe(line.words[0].at);
      expect(lineAt(line.from - 1)).toBe(k === 0 ? null : k - 1);
      expect(lineAt(line.from)).toBe(k);
    });
  });

  it('fills the button over the beat before the click, which lands on frame 4860', () => {
    expect(S17_T.click).toBe(cueLocal('S17', 'S17.click'));
    expect(sceneStart('S17') + S17_T.click).toBe(4860);
    expect(S17_T.hold).toBe(cueLocal('S17', 'S17.hold'));
    expect(holdFill17(S17_T.hold)).toBe(0);
    expect(holdFill17(S17_T.click)).toBe(1);
    expect(clickFx17(S17_T.click - 1)).toEqual({pressed: 0, zoom: 1, wave: null});
    const at = clickFx17(S17_T.click);
    expect(at.pressed).toBe(1);
    expect(at.zoom).toBeCloseTo(1.03, 9);
    expect(at.wave?.radius).toBe(0);
    expect(clickFx17(S17_T.click + 1).wave!.radius).toBeGreaterThan(0);
  });

  it('runs the arm at double tempo and stops it at 12 o’clock on the click', () => {
    expect(armAngle(s17ArmFrame(S17_T.click), 2) % 360).toBe(0);
    expect(s17ArmFrame(S17_T.click + 40)).toBe(s17ArmFrame(S17_T.click));
    expect(armAngle(s17ArmFrame(15), 2)).toBe(45);
  });

  it('retires everything on the last beat, down to the dot the coda starts from', () => {
    expect(S17_T.retire).toBe(sceneFrames('S17') - FRAMES_PER_BEAT);
    expect(S17_T.retire).toBeGreaterThan(S17_T.click);
    expect(DOT_HOME).toEqual({x: 960, y: 540});
    expect(dotState(0)).toMatchObject({x: DOT_HOME.x, y: DOT_HOME.y, size: 14});
  });
});

describe('S18 · coda', () => {
  it('reads its events from the cues and the voice', () => {
    expect(S18_T.hex).toBe(cueLocal('S18', 'S18.hex'));
    expect(S18_T.dot).toBe(cueLocal('S18', 'S18.dot'));
    expect(S18_T.final).toBe(cueLocal('S18', 'S18.final'));
    expect(RINGS.map((r) => r.at)).toEqual(seriesLocal('S18', 'S18.ring'));
    expect(RINGS.map((r) => r.color)).toEqual(['crit', 'warn', 'ok', 'ink']);
    expect(S18_T.scip).toBe(w16('SCIP', 'S18'));
  });

  it('traces the hexagon, then the ring, around the dot before the dot lands', () => {
    expect(logoDraw(S18_T.hex - 1)).toBe(0);
    expect(logoDraw(S18_T.hex)).toBe(0);
    expect(logoDraw(S18_T.dot - 1)).toBeCloseTo(0.9, 9);
    // The logo's own dot phase is never drawn by the trace: the dot is the S01 dot that lands.
    expect(logoDraw(sceneFrames('S18') + 15)).toBeCloseTo(0.9, 9);
    for (let f = S18_T.hex; f < S18_T.dot; f++) expect(logoDraw(f + 1)).toBeGreaterThanOrEqual(logoDraw(f));
  });

  it('keeps the S01 dot until the dot cue, then the logo dot, which pulses on the last click', () => {
    const before = dotState(S18_T.dot - 1);
    expect(before.size).toBe(14);
    expect(before.scale).toBe(1);
    const at = dotState(S18_T.dot);
    expect(at.size).toBe(22);
    expect(dotState(S18_T.dot + 4).scale).toBeGreaterThan(1.2);
    expect(dotState(S18_T.final - 1).scale).toBe(1);
    expect(dotState(S18_T.final + 4).scale).toBeGreaterThan(1.2);
    expect(dotState(sceneFrames('S18') + 15).scale).toBe(1);
  });

  it('sends one wave per ring cue from the logo ring outwards', () => {
    RINGS.forEach((r, i) => {
      expect(waveAt(i, r.at - 1)).toBeNull();
      const w = waveAt(i, r.at)!;
      expect(w.radius).toBeCloseTo(24, 9); // the logo ring at 240 px: 2.4 / 24 × 240
      expect(w.opacity).toBe(1);
      expect(waveAt(i, r.at + 10)!.radius).toBeGreaterThan(w.radius);
    });
  });

  it('writes the slogan word by word on the voice', () => {
    expect(SLOGAN.map((w) => w.text).join(' ')).toBe('Entendre le retard. Jouer la réponse.');
    const spoken = ['Entendre', 'le', 'retard', 'jouer', 'la', 'réponse'];
    SLOGAN.forEach((w, i) => expect(w.at).toBe(w16(spoken[i], 'S18')));
  });
});
