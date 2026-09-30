// src/scenes/S09-S11.test.ts — the timed logic of S09 (route, fixes, reject, dead zone), S10 (Baltic ships and pings,
// the pull-back to the world, planes only inside the view frame) and S11 (the console: unmutes, cut, stamp).
// Every frame comes from the cues; these tests pin where the spec wants something exact.
import {barToFrame, FRAMES_PER_BEAT} from '../lib/beat';
import {cue, cueLocal, sceneFrames, sceneStart, seriesLocal} from '../lib/timeline';
import {coversFrame, toScreen} from './mapView';
import {
  CHECK_ROWS, DEADZONE, DROP_FRAMES, FAILING_ROW, FIXES, GHOSTS, ISLET, MOVE_FROM, P_ZONE, REJECT, REJECTED, ZONE,
  fixDot, fixLanding, liveDots, routeAt, rowState, truckProgress, viewAt,
} from './S09Route';
import {
  BALTIC_CENTER_WORLD, CUT, ECHO_GAP, ECHOES, PINGS, PLANE_CUES, RING_FRAMES, SHIPS, WORLD_RECUL_FRAMES, WORLD_REST, balticView,
  pingRings, viewFrame, visiblePlanes, worldView,
} from './S10MerAir';
import {WORLD, project} from './crops';
import {CUT as S11_CUT, KEY_FLASH_STEP, STAMP, STAMP_FROM, STRIPS, keyFlash, stampState, stripState} from './S11Console';
import {FADER_UP} from '../components/Console';

const dist = (a: {x: number; y: number}, b: {x: number; y: number}): number => Math.hypot(a.x - b.x, a.y - b.y);
const range = (from: number, to: number): number[] => Array.from({length: to - from}, (_, i) => from + i);

describe('S09 route: fixes', () => {
  it('lands twelve fixes, one per beat from bar 39, and rejects the one on S09.reject', () => {
    expect(FIXES).toHaveLength(12);
    expect(FIXES[0]).toBe(barToFrame(39) - sceneStart('S09'));
    for (let k = 1; k < FIXES.length; k++) expect(FIXES[k] - FIXES[k - 1]).toBe(FRAMES_PER_BEAT);
    expect(REJECT).toBe(cueLocal('S09', 'S09.reject'));
    expect(REJECTED).toBe(FIXES.indexOf(REJECT));
    expect(REJECTED).toBeGreaterThan(0);
  });

  it('lands every accepted fix on the truck, at its cue, after a drop of DROP_FRAMES', () => {
    FIXES.forEach((c, k) => {
      if (k === REJECTED) return;
      const landed = fixDot(c, k);
      const truck = routeAt(truckProgress(c));
      expect(landed?.state).toBe('landed');
      expect(dist(landed!, truck)).toBeLessThan(1e-9);
      expect(dist(fixLanding(k), truck)).toBeLessThan(1e-9);
      expect(fixDot(c - 1, k)?.state).toBe('falling');
      expect(fixDot(c - DROP_FRAMES - 1, k)).toBeNull();
    });
  });

  it('sends the rejected fix to the (0, 0) islet, where it lands on S09.reject', () => {
    const d = fixDot(REJECT, REJECTED);
    expect(d?.state).toBe('rejected');
    expect(dist(d!, ISLET)).toBeLessThan(1e-9);
    expect(fixDot(REJECT - 1, REJECTED)?.state).toBe('flying');
    expect(fixDot(REJECT + 200, REJECTED)?.state).toBe('rejected');
    // It never becomes a live dot on the route.
    const onRoute = fixLanding(REJECTED);
    expect(liveDots(300).some((p) => dist(p, onRoute) < 1)).toBe(false);
  });

  it('adds a live dot on each accepted cue only', () => {
    expect(liveDots(FIXES[0] - 1)).toHaveLength(0);
    expect(liveDots(FIXES[0])).toHaveLength(1);
    expect(liveDots(REJECT)).toHaveLength(REJECTED);
    expect(liveDots(FIXES[FIXES.length - 1])).toHaveLength(11);
  });

  it('checks every position: only « pas de (0, 0) » fails, and only for the beat of the reject', () => {
    expect(CHECK_ROWS).toEqual(['coordonnées valides', 'pas de (0, 0)', 'pas dans le futur', 'vitesse < 250 km/h']);
    expect(CHECK_ROWS[FAILING_ROW]).toBe('pas de (0, 0)');
    expect(rowState(REJECT - 1, FAILING_ROW)).toBe('pass');
    expect(rowState(REJECT, FAILING_ROW)).toBe('fail');
    expect(rowState(REJECT + FRAMES_PER_BEAT - 1, FAILING_ROW)).toBe('fail');
    expect(rowState(REJECT + FRAMES_PER_BEAT, FAILING_ROW)).toBe('pass');
    CHECK_ROWS.forEach((_, r) => r !== FAILING_ROW && expect(rowState(REJECT, r)).toBe('pass'));
  });
});

describe('S09 route: truck and dead zone', () => {
  it('waits at Accra, then drives into the dead zone exactly on S09.deadzone', () => {
    expect(DEADZONE).toBe(barToFrame(42) - sceneStart('S09'));
    expect(MOVE_FROM).toBe(FIXES[0] - FRAMES_PER_BEAT);
    expect(truckProgress(0)).toBe(0);
    expect(truckProgress(MOVE_FROM)).toBe(0);
    expect(truckProgress(DEADZONE)).toBeCloseTo(P_ZONE, 9);
    for (const f of range(0, sceneFrames('S09') + 15)) {
      expect(truckProgress(f + 1)).toBeGreaterThanOrEqual(truckProgress(f));
      expect(truckProgress(f)).toBeLessThanOrEqual(1);
    }
  });

  it('draws the zone circle through the truck at the cue: outside before, inside after', () => {
    expect(Math.abs(dist(routeAt(P_ZONE), ZONE) - ZONE.r)).toBeLessThan(0.5);
    for (const f of range(0, DEADZONE)) expect(dist(routeAt(truckProgress(f)), ZONE)).toBeGreaterThan(ZONE.r - 0.5);
    for (const f of range(DEADZONE + 1, sceneFrames('S09'))) expect(dist(routeAt(truckProgress(f)), ZONE)).toBeLessThan(ZONE.r);
  });

  it('stops the positions at the dead zone: no fix after it, every live dot outside it', () => {
    expect(FIXES.every((c) => c < DEADZONE)).toBe(true);
    expect(liveDots(sceneFrames('S09') + 14)).toHaveLength(11);
    for (const p of liveDots(300)) expect(dist(p, ZONE)).toBeGreaterThan(ZONE.r);
  });

  it('keeps the rhythm with a ghost tick on every beat of the dead zone', () => {
    expect(GHOSTS).toEqual(range(0, 4).map((k) => DEADZONE + k * FRAMES_PER_BEAT));
    expect(GHOSTS[GHOSTS.length - 1]).toBeLessThan(sceneFrames('S09'));
  });

  it('puts the islet in the sea, off the route', () => {
    expect(ISLET.y).toBeGreaterThan(routeAt(0).y);
    expect(dist(ISLET, ZONE)).toBeGreaterThan(ZONE.r);
  });

  it('never shows the edge of the Ghana crop (no overscan): scale ≥ 1, frame covered', () => {
    for (const f of range(0, sceneFrames('S09') + 16)) expect(coversFrame(viewAt(f))).toBe(true);
  });
});

describe('S10 sea: the Baltic', () => {
  it('opens on a pull-back that never shows the edge of the Baltic crop', () => {
    expect(balticView(0).scale).toBeGreaterThan(balticView(18).scale);
    for (const f of range(0, CUT)) expect(coversFrame(balticView(f))).toBe(true);
  });

  it('sails twelve ships on the three ferry lanes', () => {
    expect(SHIPS).toHaveLength(12);
    expect(new Set(SHIPS.map((s) => s.lane)).size).toBe(3);
  });

  it('pings on the ten quarter notes from bar 43 beat 3, each ping gone before the next', () => {
    expect(PINGS).toHaveLength(10);
    expect(PINGS[0]).toBe(barToFrame(43, 3) - sceneStart('S10'));
    for (let k = 1; k < PINGS.length; k++) expect(PINGS[k] - PINGS[k - 1]).toBe(FRAMES_PER_BEAT);
    // The three sonar echoes of a ping all end within its beat, so a ring never outlives its info cue's beat.
    expect(ECHO_GAP * (ECHOES - 1) + RING_FRAMES).toBeLessThanOrEqual(FRAMES_PER_BEAT);
    for (const f of range(0, PINGS[0])) expect(pingRings(f)).toHaveLength(0);
    PINGS.forEach((p, k) => {
      const rings = pingRings(p);
      expect(rings.length).toBeGreaterThan(0);
      expect(rings.every((r) => r.ping === k && r.age === 0 && r.echo === 0)).toBe(true);
      for (const f of range(p, p + FRAMES_PER_BEAT)) expect(pingRings(f).every((r) => r.ping === k && r.age >= 0 && r.age < RING_FRAMES)).toBe(true);
    });
    for (const f of range(PINGS[PINGS.length - 1] + FRAMES_PER_BEAT, CUT)) expect(pingRings(f)).toHaveLength(0);
    const pinged = new Set(PINGS.flatMap((p) => pingRings(p).map((r) => r.ship)));
    expect(pinged.size).toBe(SHIPS.length);
  });
});

describe('S10 air: the view frame and the planes', () => {
  it('cuts to the world on the beat of « Et les avions », one beat before the first planes', () => {
    expect(CUT % FRAMES_PER_BEAT).toBe(0);
    expect(PLANE_CUES).toEqual(seriesLocal('S10', 'S10.planes'));
    expect(PLANE_CUES[0] - CUT).toBe(FRAMES_PER_BEAT);
    expect(CUT).toBeGreaterThan(cueLocal('S10', 'S10.baltic'));
  });

  it('pulls back from the Baltic to the world map in 18 frames (ease-out, scale only shrinking), then rests', () => {
    const start = worldView(CUT);
    expect(start.scale).toBeGreaterThan(3);
    const c = toScreen(BALTIC_CENTER_WORLD, start);
    expect(Math.abs(c.x - 960)).toBeLessThan(1e-6);
    expect(Math.abs(c.y - 540)).toBeLessThan(1e-6);
    expect(WORLD_RECUL_FRAMES).toBeGreaterThanOrEqual(18);
    expect(WORLD_RECUL_FRAMES).toBeLessThanOrEqual(20);
    for (const f of range(CUT, CUT + WORLD_RECUL_FRAMES)) expect(worldView(f + 1).scale).toBeLessThanOrEqual(worldView(f).scale);
    const rest = {x: -(WORLD_REST.focus.x - 960) * WORLD_REST.scale, y: -(WORLD_REST.focus.y - 540) * WORLD_REST.scale, scale: WORLD_REST.scale};
    for (const f of [CUT + WORLD_RECUL_FRAMES, sceneFrames('S10') + 14]) {
      const v = worldView(f);
      expect(v.x).toBeCloseTo(rest.x, 6);
      expect(v.y).toBeCloseTo(rest.y, 6);
      expect(v.scale).toBeCloseTo(rest.scale, 9);
    }
    // At rest the whole North Atlantic world is on screen: Europe and North America both inside the frame.
    for (const lonLat of [[8, 49], [-88, 39], [-10, 20]] as [number, number][]) {
      const p = toScreen(project(WORLD, lonLat), worldView(CUT + WORLD_RECUL_FRAMES));
      expect(p.x).toBeGreaterThan(96);
      expect(p.x).toBeLessThan(1824);
      expect(p.y).toBeGreaterThan(120);
      expect(p.y).toBeLessThan(980);
    }
  });

  it('starts the frame on the Baltic', () => {
    const r = viewFrame(CUT);
    expect(BALTIC_CENTER_WORLD.x).toBeGreaterThan(r.x);
    expect(BALTIC_CENTER_WORLD.x).toBeLessThan(r.x + r.w);
    expect(BALTIC_CENTER_WORLD.y).toBeGreaterThan(r.y);
    expect(BALTIC_CENTER_WORLD.y).toBeLessThan(r.y + r.h);
  });

  it('shows planes only inside the frame, loaded in four bursts on the chirps', () => {
    for (const f of range(0, PLANE_CUES[0])) expect(visiblePlanes(f)).toHaveLength(0);
    PLANE_CUES.forEach((c) => expect(visiblePlanes(c).length).toBeGreaterThan(visiblePlanes(c - 1).length));
    for (const f of range(PLANE_CUES[0], sceneFrames('S10') + 15)) {
      const r = viewFrame(f);
      for (const p of visiblePlanes(f)) {
        expect(p.x).toBeGreaterThanOrEqual(r.x);
        expect(p.x).toBeLessThanOrEqual(r.x + r.w);
        expect(p.y).toBeGreaterThanOrEqual(r.y);
        expect(p.y).toBeLessThanOrEqual(r.y + r.h);
      }
    }
    expect(visiblePlanes(sceneFrames('S10') - 1).length).toBeGreaterThan(20);
    expect(visiblePlanes(250)).toEqual(visiblePlanes(250));
  });
});

describe('S11 console', () => {
  const colored = STRIPS.filter((s) => s.cue);

  it('lists the ten strips in the order the voice names them, NAVIRES and AVIONS already up', () => {
    expect(STRIPS.map((s) => s.name)).toEqual([
      'NAVIRES', 'AVIONS', 'SÉISMES', 'CYCLONES', 'INONDATIONS', 'FEUX', 'MÉTÉO', 'CAMÉRAS', 'RADIO', 'SATELLITES',
    ]);
    expect(STRIPS[0].cue).toBeNull();
    expect(STRIPS[1].cue).toBeNull();
    expect(colored).toHaveLength(8);
    for (let i = 1; i < colored.length; i++) expect(cue(colored[i].cue!).frame).toBeGreaterThan(cue(colored[i - 1].cue!).frame);
    for (const i of [0, 1]) {
      const s = stripState(0, i);
      expect(s.muted).toBe(false);
      expect(s.fader).toBe(FADER_UP);
      expect(s.vu).toBeGreaterThan(0);
      expect(s.peak).toBeUndefined();
    }
  });

  it('unmutes each strip on its word: fader to 70 %, VU crest in the cue colour from the cue only', () => {
    STRIPS.forEach((strip, i) => {
      if (!strip.cue) return;
      const at = cueLocal('S11', strip.cue);
      const before = stripState(at - 1, i);
      expect(before).toMatchObject({muted: true, fader: 0, vu: 0});
      expect(before.peak).toBeUndefined();
      const on = stripState(at, i);
      expect(on.muted).toBe(false);
      expect(on.vu).toBe(1);
      expect(on.peak).toBe(cue(strip.cue).color);
      expect(stripState(at + 8, i).fader).toBeCloseTo(FADER_UP, 6);
      expect(stripState(at + 4, i).fader).toBeGreaterThan(0);
    });
  });

  it('cuts every VU for the beat of « Aucune », then hits them all with the stamp', () => {
    expect(S11_CUT).toBe(cueLocal('S11', 'S11.cut'));
    expect(STAMP).toBe(S11_CUT + FRAMES_PER_BEAT);
    STRIPS.forEach((_, i) => {
      for (const f of range(S11_CUT, STAMP)) expect(stripState(f, i).vu).toBe(0);
      expect(stripState(STAMP, i).vu).toBe(1);
      expect(stripState(sceneFrames('S11'), i).vu).toBe(0);
      expect(stripState(sceneFrames('S11') + 14, i).vu).toBe(0);
    });
  });

  it('blinks the « CLÉ : — » fields in a cascade during the cut beat', () => {
    for (let i = 0; i <= STRIPS.length; i++) {
      const at = S11_CUT + i * KEY_FLASH_STEP;
      expect(keyFlash(at - 1, i)).toBe(false);
      expect(keyFlash(at, i)).toBe(true);
      expect(at).toBeLessThan(STAMP);
    }
    for (const f of [...range(0, S11_CUT), ...range(STAMP, sceneFrames('S11') + 15)]) {
      for (let i = 0; i <= STRIPS.length; i++) expect(keyFlash(f, i)).toBe(false);
    }
  });

  it('lands the stamp « 0 CLÉ D\'API » on the beat after « clé », slamming down to scale 1 in 6 frames', () => {
    expect(stampState(STAMP - 1).visible).toBe(false);
    expect(stampState(STAMP)).toMatchObject({visible: true, scale: STAMP_FROM});
    // The stamp box is about 1 625 px wide: from its first frame it must fit in the 1 920 px frame.
    expect(1625 * STAMP_FROM).toBeLessThan(1920);
    expect(stampState(STAMP + 3).scale).toBeLessThan(STAMP_FROM);
    expect(stampState(STAMP + 6).scale).toBeCloseTo(1, 9);
    expect(stampState(sceneFrames('S11') + 14).visible).toBe(true);
  });
});
