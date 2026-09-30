// src/scenes/S18Coda.tsx — S18 · Coda, 164-170 s, dark (spec § 4 S18).
// Only the dot is left, as in S01: the reprise hands it over at the centre of the frame. The logo is built around it:
// the hexagon traces (3 px, 240 px) from the downbeat, then the ring, and on the dot cue the S01 dot lands as the
// logo's own dot (the soft ink kick). The lockup then lifts into place while « SCIP » rises letter by letter on the
// voice, over « SUPPLY CHAIN INTELLIGENCE PLATFORM » (Mono 24, +0.2 em). Four waves leave the dot on the ring cues —
// crit, warn, ok, then the action colour: every signal resolves into ink. The slogan « Entendre le retard. Jouer la
// réponse. » (Plex Sans 44) is written word by word on the voice, and the dot pulses once on the last metronome
// click (the S01 count-in, recalled). The HUD reads « MESURE 085/085 · FIN » on its own from that downbeat.
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {DOT_R, Logo, RING, VIEW} from '../components/Logo';
import {CONDENSED, LABEL, SANS} from '../components/typography';
import {quantize} from '../lib/beat';
import {EASE_OUT} from '../lib/easing';
import {cue, cueLocal, sceneDef, seriesLocal, wordLocal} from '../lib/timeline';
import {SplitText} from '../rb/SplitText';
import {palette, signal, type SignalColor} from '../theme/tokens';
import {clamp01, lerp, pop, ramp} from './refrain';

const S = 'S18' as const;
const theme = sceneDef(S).theme;
const pal = palette(theme);

/** Where the dot waits between the reprise and the coda: the centre of the frame, like the S01 dot. */
export const DOT_HOME = {x: 960, y: 540} as const;
/** The S01 dot (spec § 4 S01: « un point de 14 px »). */
const S01_DOT = 14;
const LOGO = 240;
const LOGO_STROKE = 3;
/** Centre of the logo's ring and dot inside its 240 px box. */
const RING_C = {x: (RING.cx / VIEW) * LOGO, y: (RING.cy / VIEW) * LOGO};
const RING_R = (RING.r / VIEW) * LOGO;
const LOGO_DOT = 2 * (DOT_R / VIEW) * LOGO;
/** Height of the dot once the lockup has lifted: the logo, « SCIP », the tagline and the slogan centred on the frame. */
export const LOCKUP_DOT_Y = 365;
const LIFT_FRAMES = 18;
/** The trace draws the hexagon and the ring (Logo phases 0-0.9); the dot phase belongs to the S01 dot. */
const TRACE_END = 0.9;

/** Voice-driven entry: on the nearest sixteenth, 2 frames early (spec § 3.5). */
const wordAt = (screen: string): number => quantize(wordLocal(S, screen).start, '16th') - 2;

export const S18_T = (() => {
  const hex = cueLocal(S, 'S18.hex');
  const dot = cueLocal(S, 'S18.dot');
  return {
    hex,
    dot,
    /** Hexagon and ring are traced at a constant pen speed, finished a few frames before the dot lands. */
    traceEnd: dot - 3,
    scip: wordAt('SCIP'),
    final: cueLocal(S, 'S18.final'),
  };
})();

export interface Ring { at: number; color: SignalColor }
/** The four waves, on the ring cues and in their colours (crit, warn, ok, ink). */
export const RINGS: readonly Ring[] = seriesLocal(S, 'S18.ring').map((at, i) => ({at, color: cue(`S18.ring.${i + 1}`).color as SignalColor}));

/** The slogan as shown (spec § 4 S18), each word on its spoken word. */
export const SLOGAN: ReadonlyArray<{text: string; at: number}> = [
  ['Entendre', 'Entendre'], ['le', 'le'], ['retard', 'retard.'], ['jouer', 'Jouer'], ['la', 'la'], ['réponse', 'réponse.'],
].map(([spoken, text]) => ({text, at: wordAt(spoken)}));

/** Draw progress of the logo trace (Logo drawProgress), capped before its dot phase. */
export const logoDraw = (f: number): number => TRACE_END * clamp01((f - S18_T.hex) / (S18_T.traceEnd - S18_T.hex));

/** How far the lockup has lifted, 0..1, from the dot cue. */
const lift = (f: number): number => ramp(f, S18_T.dot, LIFT_FRAMES);
const dotY = (f: number): number => lerp(DOT_HOME.y, LOCKUP_DOT_Y, lift(f));

/** The dot: the S01 dot until it lands as the logo's dot, with a trigger pop there and on the last click. */
export const dotState = (f: number): {x: number; y: number; size: number; scale: number} => ({
  x: DOT_HOME.x,
  y: dotY(f),
  size: f < S18_T.dot ? S01_DOT : LOGO_DOT,
  scale: pop(f, S18_T.dot) * pop(f, S18_T.final),
});

const WAVE_FRAMES = 26;
const WAVE_MAX = 290;

/** Wave `i`: from the logo ring outwards, thinning and fading; null outside its life. */
export const waveAt = (i: number, f: number): {radius: number; opacity: number; width: number} | null => {
  const t = f - RINGS[i].at;
  if (t < 0 || t >= WAVE_FRAMES) return null;
  const p = t / WAVE_FRAMES;
  return {radius: lerp(RING_R, WAVE_MAX, EASE_OUT(p)), opacity: (1 - p) ** 1.5, width: lerp(3, 1, p)};
};

// Vertical layout of the lockup, relative to the dot (see LOCKUP_DOT_Y): line boxes placed so the capitals of each line
// sit at the charter's rhythm under the logo (Plex ascent 1.025 em, capitals 0.698 em).
const SCIP_TOP = 118;
const TAGLINE_TOP = 292;
const SLOGAN_TOP = 363;

export const S18Coda: React.FC = () => {
  const f = useCurrentFrame();
  const dot = dotState(f);
  const logoLeft = dot.x - RING_C.x;
  const logoTop = dot.y - RING_C.y;
  const tagIn = ramp(f, S18_T.scip + 12, 10);
  return (
    <AbsoluteFill style={{background: pal.bg}}>
      {/* The waves, under everything else. */}
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
        {RINGS.map((r, i) => {
          const w = waveAt(i, f);
          return w && <circle key={i} cx={dot.x} cy={dot.y} r={w.radius} fill="none" stroke={signal(theme, r.color)} strokeWidth={w.width} opacity={w.opacity} />;
        })}
      </svg>
      {f >= S18_T.hex && (
        <Logo size={LOGO} stroke={LOGO_STROKE} color={pal.action} drawProgress={logoDraw(f)} style={{position: 'absolute', left: logoLeft, top: logoTop}} />
      )}
      <div
        style={{
          position: 'absolute', left: dot.x - dot.size / 2, top: dot.y - dot.size / 2, width: dot.size, height: dot.size,
          borderRadius: dot.size / 2, background: pal.action, transform: `scale(${dot.scale})`,
        }}
      />
      <div style={{position: 'absolute', left: 0, width: 1920, top: dot.y + SCIP_TOP, display: 'flex', justifyContent: 'center'}}>
        <SplitText
          words={[{text: 'SCIP', at: S18_T.scip}]} frame={f} mode="chars" charStagger={2} rise={60} duration={10} tag="div"
          style={{fontFamily: CONDENSED, fontWeight: 600, fontSize: 160, lineHeight: 1, letterSpacing: '-0.02em', color: pal.ink, whiteSpace: 'nowrap'}}
        />
      </div>
      <div
        style={{
          ...LABEL, letterSpacing: '0.2em', position: 'absolute', left: 0, width: 1920, top: dot.y + TAGLINE_TOP, textAlign: 'center',
          // +0.2 em tracking leaves a trailing space after the last letter: pad the start by the same amount to centre it.
          paddingLeft: '0.2em', boxSizing: 'border-box', color: pal.muted, opacity: tagIn, transform: `translateY(${(1 - tagIn) * 12}px)`,
        }}
      >
        SUPPLY CHAIN INTELLIGENCE PLATFORM
      </div>
      <div style={{position: 'absolute', left: 0, width: 1920, top: dot.y + SLOGAN_TOP, display: 'flex', justifyContent: 'center'}}>
        <SplitText
          words={SLOGAN.map((w) => ({...w}))} frame={f} rise={18} duration={8} overshoot={1} tag="div"
          style={{fontFamily: SANS, fontWeight: 400, fontSize: 44, lineHeight: 1, color: pal.ink, whiteSpace: 'nowrap'}}
        />
      </div>
    </AbsoluteFill>
  );
};
