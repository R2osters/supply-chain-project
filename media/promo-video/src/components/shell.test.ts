// src/components/shell.test.ts — the pure logic of the video shell: wipes, sequences, HUD, sequencer arm, VU lanes.
import {interpolateColors} from 'remotion';
import {sceneSpans} from '../Video';
import {SCENES} from '../scenes';
import {sceneFrames, scenes} from '../lib/timeline';
import {palette} from '../theme/tokens';
import {HEX_CONTOURS, HEX_PATH, LOGO_PHASES, phaseProgress} from './Logo';
import {startsWithWipe, WIPE_FRAMES, WIPE_PLAYHEAD_GAP, wipePlayheadX, wipeProgress} from './ThemeWipe';
import {PLAYHEAD_WIDTH} from './Playhead';
import {HUD_LOGO_FROM, hudLayers, hudText, litPads, SECTIONS} from './Hud';
import {activeCell, armAngle} from './LoopSequencer';
import {litSegments, segmentStates} from './VuLane';

describe('Logo', () => {
  it('uses the exact path of spec § 3.4', () => {
    expect(HEX_PATH).toBe('M4 8.5 12 4l8 4.5v7L12 20l-8-4.5Zm8 4.2L5.6 8.9v5.4l6.4 3.6 6.4-3.6V8.9Z');
  });

  it('traces the two contours of that path separately, the inner one from its absolute start', () => {
    // m8 4.2 after the outer contour closes at (4, 8.5) moves to (12, 12.7).
    expect(HEX_CONTOURS[0] + HEX_CONTOURS[1].replace('M12 12.7', 'm8 4.2')).toBe(HEX_PATH);
  });

  it('traces the hexagon, then the ring, then the dot', () => {
    expect(phaseProgress(0.3, LOGO_PHASES.hex)).toBeCloseTo(0.5);
    expect(phaseProgress(0.3, LOGO_PHASES.ring)).toBe(0);
    expect(phaseProgress(0.75, LOGO_PHASES.hex)).toBe(1);
    expect(phaseProgress(0.75, LOGO_PHASES.ring)).toBeCloseTo(0.5);
    expect(phaseProgress(0.75, LOGO_PHASES.dot)).toBe(0);
    expect(phaseProgress(1, LOGO_PHASES.dot)).toBe(1);
  });
});

describe('theme wipes', () => {
  it('happen at S03, S09, S11, S12, S14, S15 and S17, where the theme changes', () => {
    expect(scenes.filter((s) => startsWithWipe(s.id)).map((s) => s.id)).toEqual(['S03', 'S09', 'S11', 'S12', 'S14', 'S15', 'S17']);
  });

  it('sweep left to right over one beat with an ease-out', () => {
    expect(WIPE_FRAMES).toBe(15);
    expect(wipeProgress(0)).toBe(0);
    expect(wipeProgress(7.5)).toBeGreaterThan(50);
    expect(wipeProgress(15)).toBe(100);
    expect(wipeProgress(40)).toBe(100);
  });

  it('draw the playhead inside the revealed region, with incoming background on both sides of the line', () => {
    // The line is in the incoming action colour, which is close to the outgoing background: centred on the edge it
    // would sit mostly on the outgoing side and vanish (review finding, T10 fix round 1).
    expect(PLAYHEAD_WIDTH).toBe(2);
    expect(WIPE_PLAYHEAD_GAP).toBeGreaterThanOrEqual(PLAYHEAD_WIDTH);
    for (let local = 1; local <= WIPE_FRAMES; local++) {
      const edge = (wipeProgress(local) / 100) * 1920;
      const x = wipePlayheadX(local, 1920);
      expect(x + PLAYHEAD_WIDTH / 2 + WIPE_PLAYHEAD_GAP).toBeCloseTo(edge, 9);
      expect(x - PLAYHEAD_WIDTH / 2).toBeGreaterThanOrEqual(0);
    }
    expect(wipePlayheadX(WIPE_FRAMES, 1920)).toBe(1920 - WIPE_PLAYHEAD_GAP - 1);
  });
});

describe('Video sequences', () => {
  const spans = sceneSpans();

  it('open each scene on its first frame and keep the outgoing scene 15 frames under a wipe', () => {
    expect(spans.find((s) => s.id === 'S02')).toEqual({id: 'S02', from: 180, durationInFrames: 315, wipe: false});
    expect(spans.find((s) => s.id === 'S03')).toEqual({id: 'S03', from: 480, durationInFrames: 240, wipe: true});
    expect(spans.find((s) => s.id === 'S05')).toEqual({id: 'S05', from: 1080, durationInFrames: 360, wipe: false});
    expect(spans.find((s) => s.id === 'S18')).toEqual({id: 'S18', from: 4920, durationInFrames: 180, wipe: false});
  });

  it('tile the 5100 frames without a gap', () => {
    spans.forEach((s, i) => expect(s.from).toBe(i === 0 ? 0 : spans[i - 1].from + sceneFrames(spans[i - 1].id)));
    expect(spans[spans.length - 1].from + spans[spans.length - 1].durationInFrames).toBe(5100);
  });
});

describe('scene registry', () => {
  it('maps the 18 scene ids, in order, to components', () => {
    expect(Object.keys(SCENES)).toEqual(scenes.map((s) => s.id));
    expect(Object.values(SCENES).every((c) => typeof c === 'function')).toBe(true);
  });
});

describe('Hud', () => {
  it('counts bars as « ♩ = 120 · MESURE nnn/085 », with « · FIN » on the last bar', () => {
    expect(hudText(0)).toBe('♩ = 120 · MESURE 001/085');
    expect(hudText(490)).toBe('♩ = 120 · MESURE 009/085');
    expect(hudText(1925)).toBe('♩ = 120 · MESURE 033/085');
    expect(hudText(5039)).toBe('♩ = 120 · MESURE 084/085');
    expect(hudText(5040)).toBe('♩ = 120 · MESURE 085/085 · FIN');
    expect(hudText(5099)).toBe('♩ = 120 · MESURE 085/085 · FIN');
  });

  it('lists the 13 sections of spec § 3.6 in order', () => {
    expect(SECTIONS).toEqual([
      'INTRO', 'COUPLET 1', 'PRÉ-REFRAIN', 'REFRAIN', 'DROP', 'COUPLET 2', 'CONSOLE',
      'COUPLET 3', 'PONT', 'COUPLET 4', 'HORS LIGNE', 'REPRISE', 'CODA',
    ]);
  });

  it('lights a pad for 8 frames from each coloured cue, and only then', () => {
    expect(litPads(126)).toEqual([]);
    expect(litPads(127)).toEqual(['crit']);
    expect(litPads(134)).toEqual(['crit']);
    expect(litPads(135)).toEqual([]);
    expect(litPads(1919)).toEqual([]);
    expect(litPads(1925)).toEqual(['ink']);
    expect(litPads(1928)).toEqual([]);
    expect(litPads(2385)).toEqual(['crit', 'live']);
  });

  it('shows the logo from frame 795, where the S04 logo lands', () => {
    expect(HUD_LOGO_FROM).toBe(795);
  });

  it('splits into the outgoing and incoming themes under a wipe', () => {
    const at = hudLayers(480);
    expect(at.map((l) => l.theme)).toEqual(['dark', 'light']);
    expect(at.map((l) => l.clip)).toEqual(['inset(0 0 0 0%)', 'inset(0 100% 0 0)']);
    expect(hudLayers(495)).toEqual([{theme: 'light', colors: {ink: palette('light').ink, muted: palette('light').muted, dim: palette('light').dim}}]);
  });

  it('darkens with S05 over its last 60 frames, so it never disappears into the background', () => {
    expect(hudLayers(1379)[0].colors.ink).toBe(palette('light').ink);
    expect(hudLayers(1410)[0].colors.ink).toBe(interpolateColors(0.5, [0, 1], [palette('light').ink, palette('dark').ink]));
    expect(hudLayers(1440)[0].colors.ink).toBe(palette('dark').ink);
  });
});

describe('LoopSequencer arm', () => {
  it('ratchets 22.5° per beat, each step taking 6 frames', () => {
    expect(armAngle(0)).toBe(0);
    expect(armAngle(3)).toBeGreaterThan(11.25);
    expect(armAngle(3)).toBeLessThan(22.5);
    expect(armAngle(6)).toBe(22.5);
    expect(armAngle(14)).toBe(22.5);
    expect(armAngle(15)).toBe(22.5);
    expect(armAngle(21)).toBe(45);
  });

  it('runs at double tempo with speed 2', () => {
    expect(armAngle(3, 2)).toBe(22.5);
    expect(armAngle(15, 2)).toBe(45);
  });

  it('points at the nearest of the 16 cells, wrapping after a full turn', () => {
    expect(activeCell(0)).toBe(0);
    expect(activeCell(6)).toBe(1);
    expect(activeCell(16 * 15)).toBe(0);
    expect(activeCell(16 * 15 + 6)).toBe(1);
  });
});

describe('VuLane', () => {
  it('lights value / max of the segments, rounded half up and clamped', () => {
    expect(litSegments(0.5, 1, 16)).toBe(8);
    expect(litSegments(1 / 32, 1, 16)).toBe(1);
    expect(litSegments(2, 1, 16)).toBe(16);
    expect(litSegments(-1, 1, 16)).toBe(0);
    expect(litSegments(1, 0, 16)).toBe(0);
  });

  it('paints the top two lit segments in the peak colour when one is given', () => {
    expect(segmentStates(4, 6, false)).toEqual(['on', 'on', 'on', 'on', 'off', 'off']);
    expect(segmentStates(4, 6, true)).toEqual(['on', 'on', 'peak', 'peak', 'off', 'off']);
    expect(segmentStates(1, 3, true)).toEqual(['peak', 'off', 'off']);
  });
});
