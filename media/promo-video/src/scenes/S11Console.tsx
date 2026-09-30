// src/scenes/S11Console.tsx — S11 · La table de mixage (spec § 4 S11), 94-104 s, dark, CONSOLE.
// A full-frame console: ten strips and a MASTER (components/Console). NAVIRES and AVIONS are already up. Each source the
// voice names unmutes on its word (its cue): the « M » goes out, the fader rises to 70 % over 8 frames, the icon pops,
// the VU slams to the top and then follows the envelope, its two top segments in the colour of that cue (the colour's
// layer keeps playing in the score until the end of the scene, so does the crest). On « Aucune » (S11.cut) everything
// is cut for a beat: the meters drop and the « CLÉ : — » fields blink in a cascade, left to right, ending on the
// MASTER. On the next beat (S11.stamp) the whole band hits, the console jolts and dims, and the stamp « 0 CLÉ D'API »
// (Plex Condensed 300 px, with the typographic apostrophe: at 300 px the straight one reads as a block) lands,
// scale 1.1 → 1. The layers stop with the scene; the meters fall to zero under S12's wipe.
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {Console, FADER_UP, vuEnvelope, type IconName, type MasterView, type StripView} from '../components/Console';
import {CONDENSED} from '../components/typography';
import {cue, cueLocal, sceneDef, sceneFrames} from '../lib/timeline';
import {palette, type SignalColor} from '../theme/tokens';
import {clamp01, pop, ramp} from './refrain';

const ID = 'S11' as const;
const THEME = sceneDef(ID).theme;
const pal = palette(THEME);
const FRAMES = sceneFrames(ID);

export interface StripDef { name: string; source: readonly string[]; icon: IconName; cue: string | null }

/** The ten channels, in the order the voice names them (spec § 4 S11). A strip is 150 px wide, so a two-part source
 * (NOAA·GDACS, EONET·GDACS, RADIO BROWSER) sets one part per line, the line break standing for the separator. */
export const STRIPS: readonly StripDef[] = [
  {name: 'NAVIRES', source: ['DIGITRAFFIC'], icon: 'ship', cue: null},
  {name: 'AVIONS', source: ['OPENSKY'], icon: 'plane', cue: null},
  {name: 'SÉISMES', source: ['USGS'], icon: 'quake', cue: 'S11.seismes'},
  {name: 'CYCLONES', source: ['NOAA', 'GDACS'], icon: 'cyclone', cue: 'S11.cyclones'},
  {name: 'INONDATIONS', source: ['GDACS'], icon: 'flood', cue: 'S11.inondations'},
  {name: 'FEUX', source: ['EONET', 'GDACS'], icon: 'fire', cue: 'S11.feux'},
  {name: 'MÉTÉO', source: ['OPEN-METEO'], icon: 'weather', cue: 'S11.meteo'},
  {name: 'CAMÉRAS', source: ['PUBLIQUES'], icon: 'camera', cue: 'S11.cameras'},
  {name: 'RADIO', source: ['RADIO', 'BROWSER'], icon: 'radio', cue: 'S11.radio'},
  {name: 'SATELLITES', source: ['CELESTRAK'], icon: 'satellite', cue: 'S11.satellites'},
];

export const CUT = cueLocal(ID, 'S11.cut');
export const STAMP = cueLocal(ID, 'S11.stamp');
/** Frames between two key fields of the cascade, and how long each one stays lit. */
export const KEY_FLASH_STEP = 1;
const KEY_FLASH_ON = 4;
/** A hit (the unmute, the stamp) puts the VU at the top, then it falls back to the envelope over this many frames. */
const HIT_FRAMES = 8;
const FADER_FRAMES = 8;

/** The strip's unmute frame; already-open strips were unmuted before the scene. */
export const unmuteAt = (i: number): number => {
  const id = STRIPS[i].cue;
  return id ? cueLocal(ID, id) : -Infinity;
};

const hit = (f: number, at: number): number => (f >= at ? clamp01(1 - (f - at) / HIT_FRAMES) : 0);

export interface StripState { muted: boolean; fader: number; vu: number; peak?: SignalColor; pulse: number }

export const stripState = (f: number, i: number): StripState => {
  const at = unmuteAt(i);
  const muted = f < at;
  const fader = muted ? 0 : at === -Infinity ? FADER_UP : FADER_UP * ramp(f, at, FADER_FRAMES);
  const silent = muted || f >= FRAMES || (f >= CUT && f < STAMP);
  const vu = silent ? 0 : Math.max(vuEnvelope(f, i), hit(f, at), hit(f, STAMP));
  const id = STRIPS[i].cue;
  const peak = id && vu > 0 ? (cue(id).color as SignalColor) : undefined;
  return {muted, fader, vu, peak, pulse: at === -Infinity ? 1 : pop(f, at)};
};

/** Whether the i-th « CLÉ : — » field (10 = MASTER) is lit: once each, in a cascade across the cut beat. */
export const keyFlash = (f: number, i: number): boolean => {
  const at = CUT + i * KEY_FLASH_STEP;
  return f >= at && f < at + KEY_FLASH_ON && f < STAMP;
};

/** The stamp slams from 1.1: its box (about 1 625 px) then stays inside the frame from the first frame. */
export const STAMP_FROM = 1.1;
export const stampState = (f: number): {visible: boolean; scale: number; opacity: number} => ({
  visible: f >= STAMP,
  scale: STAMP_FROM - (STAMP_FROM - 1) * ramp(f, STAMP, 6),
  opacity: clamp01((f - STAMP + 1) / 2),
});

const masterState = (f: number): MasterView => {
  const side = (parity: number) => Math.max(0, ...STRIPS.map((_, i) => (i % 2 === parity ? stripState(f, i).vu : 0)));
  return {fader: FADER_UP + 0.1, vuL: side(0), vuR: side(1), keyFlash: keyFlash(f, STRIPS.length)};
};

export const S11Console: React.FC = () => {
  const f = useCurrentFrame();
  const strips: StripView[] = STRIPS.map((s, i) => {
    const st = stripState(f, i);
    return {name: s.name, source: s.source, icon: s.icon, ...st, keyFlash: keyFlash(f, i)};
  });
  const stamp = stampState(f);
  // The band's hit: the console jolts (a damped bounce over 10 frames) and dims behind the stamp.
  const t = clamp01((f - STAMP) / 10);
  const jolt = f >= STAMP ? 10 * (1 - t) * Math.cos(Math.PI * 3 * t) : 0;
  const dim = 1 - 0.72 * ramp(f, STAMP, 6);
  // During the cut beat the console holds its breath.
  const hush = f >= CUT && f < STAMP ? 0.9 : 1;
  return (
    <AbsoluteFill style={{background: pal.bg}}>
      <AbsoluteFill style={{transform: `translateY(${jolt}px)`, opacity: dim * hush}}>
        <Console theme={THEME} strips={strips} master={masterState(f)} />
      </AbsoluteFill>
      {stamp.visible && (
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
          <div
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', padding: '64px 64px 40px',
              border: `8px solid ${pal.action}`, borderRadius: 14, opacity: stamp.opacity, transform: `scale(${stamp.scale})`,
              background: 'rgb(18 19 20 / 0.55)',
            }}
          >
            <span style={{fontFamily: CONDENSED, fontWeight: 600, fontSize: 300, lineHeight: 1, letterSpacing: '-0.02em', color: pal.action, whiteSpace: 'nowrap'}}>
              0 CLÉ D’API
            </span>
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
