// src/scenes/S04Relier.tsx — S04 · SCIP relie (spec § 4 S04), 24-36 s, light, COUPLET 1.
// The two questions of S03 collide: impact, a 40 % white flash for 2 frames, and the logo is born where they met. It
// traces (hexagon, ring, dot) while it glides into a lockup with « SCIP » (Condensed 400 px, letters rising on the
// voice) and « SUPPLY CHAIN INTELLIGENCE PLATFORM » (Mono 24 px, +0.2 em). On « relie » an ink route (3 px, y = 620)
// is drawn from the middle out to the supplier gate (x = 200) and the client dock (x = 1720).
// Over one beat the logo flies into the HUD and hands over to the HUD logo on absolute frame 795; the wordmark closes
// the gap it leaves. « suivre » drops the SUIVRE chip on the route; the gate opens and a 48 px container crosses the
// route in 8 hops, one per beat, each landing on its wood tick and lighting its mark. « décider » clears the top band
// and drops the OPTIMISER chip; the four stamps QUOI · CHEZ QUI · QUAND · PAR QUELLE ROUTE fall on their words, each
// attenuating the one before.
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {EASE_EXIT, EASE_OUT} from '../lib/easing';
import {FRAMES_PER_BEAT, quantize} from '../lib/beat';
import {cueLocal, sceneStart, seriesLocal, wordLocal} from '../lib/timeline';
import {palette} from '../theme/tokens';
import {SplitText} from '../rb/SplitText';
import {Chip} from '../components/Chip';
import {ContainerGlyph} from '../components/ContainerGlyph';
import {HUD_LOGO, HUD_LOGO_FROM} from '../components/Hud';
import {Logo} from '../components/Logo';
import {CONDENSED, LABEL} from '../components/typography';

const ID = 'S04';
const pal = palette('light');
/** Voice-driven entry: on the nearest sixteenth, 2 frames early (spec § 3.5). */
const wordAt = (screen: string, occurrence = 1): number => quantize(wordLocal(ID, screen, occurrence).start, '16th') - 2;

const IMPACT = cueLocal(ID, 'S04.impact');
const SUIVRE = cueLocal(ID, 'S04.suivre');
const DECIDER = cueLocal(ID, 'S04.decider');
const STAMP_CUES = ['S04.quoi', 'S04.chezqui', 'S04.quand', 'S04.route'].map((id) => cueLocal(ID, id));
const HOPS = seriesLocal(ID, 'S04.hop');

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;
const ease = (f: number, from: number, frames: number): number =>
  interpolate(f, [from, from + frames], [0, 1], {easing: EASE_OUT, extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

// ── Lockup ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const LOGO_SIZE = 280;
const LOGO_STROKE = 3;
const LOCK_GAP = 64;
/** Width of « SCIP » in Plex Sans Condensed SemiBold 400 px at −0.02 em, measured in the renderer. */
const SCIP_WIDTH = 807;
const LOCKUP_X = (1920 - (LOGO_SIZE + LOCK_GAP + SCIP_WIDTH)) / 2;
/** Top of the « SCIP » line box; its capitals then span y 190-469, the logo box's height. */
const SCIP_TOP = 119;
/** The logo's box in the lockup (top-left corner). */
export const LOCKUP_LOGO = {x: LOCKUP_X, y: 190} as const;
/** Where the collision happened: the logo is born there (centre of its box). */
const BIRTH = {x: 960, y: 460};
const GLIDE = {from: 6, frames: 18};
const DRAW_FRAMES = 27;

/** Over one beat, ending when the HUD logo appears (absolute frame 795, local 75). */
export const FLIGHT = {from: HUD_LOGO_FROM - sceneStart(ID) - FRAMES_PER_BEAT, to: HUD_LOGO_FROM - sceneStart(ID)};

export interface LogoBox { x: number; y: number; size: number; stroke: number; visible: boolean }

/** The flying logo: born at the collision, glides into the lockup, then flies onto the HUD logo and vanishes there. */
export const logoFlight = (f: number): LogoBox => {
  const g = ease(f, IMPACT + GLIDE.from, GLIDE.frames);
  const x0 = lerp(BIRTH.x - LOGO_SIZE / 2, LOCKUP_LOGO.x, g);
  const y0 = lerp(BIRTH.y - LOGO_SIZE / 2, LOCKUP_LOGO.y, g);
  const p = EASE_OUT(clamp01((f - FLIGHT.from) / (FLIGHT.to - FLIGHT.from)));
  // A quadratic Bézier with its control point below the HUD slot, on the lockup's row: the logo swings left, then rises
  // into the slot from below, never across the HUD text to the slot's right. Exact at both ends.
  const q = (a: number, c: number, b: number): number => (1 - p) * (1 - p) * a + 2 * (1 - p) * p * c + p * p * b;
  return {
    x: q(x0, HUD_LOGO.x, HUD_LOGO.x), y: q(y0, y0, HUD_LOGO.y), size: lerp(LOGO_SIZE, HUD_LOGO.size, p),
    stroke: lerp(LOGO_STROKE, HUD_LOGO.stroke, p), visible: f < FLIGHT.to,
  };
};

// ── Route ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The route (y, ends) and the container's first and last positions (centre x). */
export const ROUTE = {y: 620, from: 200, to: 1720, start: 240, end: 1680} as const;
export const HOP_FRAMES = 8;
const HOP_HEIGHT = 44;
const STEP = (ROUTE.end - ROUTE.start) / HOPS.length;
const CONTAINER = 48;

/** Container centre x and height above the route: each hop takes off HOP_FRAMES before its cue and lands on it. */
export const containerAt = (f: number): {x: number; lift: number} => {
  let landed = 0;
  for (let k = 0; k < HOPS.length; k++) {
    const take = HOPS[k] - HOP_FRAMES;
    if (f >= take && f < HOPS[k]) {
      const s = (f - take) / HOP_FRAMES;
      return {x: ROUTE.start + (k + s) * STEP, lift: 4 * HOP_HEIGHT * s * (1 - s)};
    }
    if (f >= HOPS[k]) landed = k + 1;
  }
  return {x: ROUTE.start + landed * STEP, lift: 0};
};

/** A label word: [spoken word, its occurrence in the voice-over, text on screen] (« du » is said twice). */
type LabelWord = [string, number, string];
const labelWords = (list: LabelWord[]) => list.map(([w, n, text]) => ({text, at: wordAt(w, n)}));
/** The two route labels, each word rising on its own word of the voice. */
export const ROUTE_LABELS = {
  gate: labelWords([['porte', 1, 'PORTE'], ['du', 1, 'DU'], ['fournisseur', 1, 'FOURNISSEUR']]),
  dock: labelWords([['quai', 1, 'QUAI'], ['du', 2, 'DU'], ['client', 1, 'CLIENT']]),
};

// ── Stamps ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const STAMP_WORDS = ['QUOI', 'CHEZ QUI', 'QUAND', 'PAR QUELLE ROUTE'];
const STAMP_FRAMES = 6;
const STAMP_FROM_SCALE = 1.3;

/** Each stamp: shown from its cue, scale 1.3 → 1, and attenuated (dim 0 → 1) once the next one lands. */
export const stampStates = (f: number): {visible: boolean; scale: number; dim: number}[] =>
  STAMP_CUES.map((c, i) => {
    const next = STAMP_CUES[i + 1];
    return {
      visible: f >= c,
      scale: STAMP_FROM_SCALE - (STAMP_FROM_SCALE - 1) * ease(f, c, STAMP_FRAMES),
      dim: next === undefined ? 0 : ease(f, next, STAMP_FRAMES),
    };
  });

// ── Drawings ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The supplier gate: a post and a striped boom that lifts before the first hop. */
const Gate: React.FC<{open: number; show: number}> = ({open, show}) => {
  const post = {x: ROUTE.from - 4, top: ROUTE.y - 72};
  const pivot = {x: ROUTE.from, y: ROUTE.y - 64};
  return (
    <g opacity={show}>
      <rect x={post.x} y={post.top} width={8} height={72} fill={pal.ink} />
      <rect x={post.x - 10} y={ROUTE.y - 4} width={28} height={4} fill={pal.ink} />
      <g transform={`rotate(${-80 * open} ${pivot.x} ${pivot.y})`}>
        <rect x={pivot.x} y={pivot.y - 5} width={108} height={10} rx={2} fill={pal.surface2} stroke={pal.ink} strokeWidth={3} />
        {[0, 1, 2].map((i) => (
          <rect key={i} x={pivot.x + 12 + i * 32} y={pivot.y - 5} width={16} height={10} fill={pal.ink} />
        ))}
      </g>
      <circle cx={pivot.x} cy={pivot.y} r={7} fill={pal.ink} />
    </g>
  );
};

/** The client dock: a warehouse with its loading door, standing on the end of the route. */
const Dock: React.FC<{show: number}> = ({show}) => {
  const x0 = ROUTE.to;
  const w = 96;
  const y = ROUTE.y;
  return (
    <g opacity={show} fill="none" stroke={pal.ink} strokeWidth={3} strokeLinejoin="miter">
      <path d={`M${x0} ${y}V${y - 70}L${x0 + w / 2} ${y - 100}L${x0 + w} ${y - 70}V${y}`} />
      <path d={`M${x0 + 24} ${y}V${y - 44}H${x0 + w - 24}V${y}`} />
      {[0, 1, 2].map((i) => (
        <line key={i} x1={x0 + 24} x2={x0 + w - 24} y1={y - 33 + i * 11} y2={y - 33 + i * 11} strokeWidth={2} />
      ))}
    </g>
  );
};

const stampStyle: React.CSSProperties = {
  fontFamily: CONDENSED, fontWeight: 600, fontSize: 150, lineHeight: 1, letterSpacing: '-0.02em', color: pal.ink,
  whiteSpace: 'nowrap', display: 'inline-block',
};

export const S04Relier: React.FC = () => {
  const f = useCurrentFrame();

  // Impact
  const flash = f >= IMPACT && f < IMPACT + 2 ? 0.4 : 0;
  const wave = ease(f, IMPACT, 18);
  const logo = logoFlight(f);
  // A pen trace runs at constant speed, like the tape (the ease-out would finish the hexagon in 3 frames).
  const draw = interpolate(f, [IMPACT, IMPACT + DRAW_FRAMES], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

  // Wordmark: letters rise on « SCIP », the lockup closes up behind the departing logo, and it all leaves on « décider ».
  const scipAt = wordAt('SCIP');
  const close = ease(f, FLIGHT.from, 18);
  const scipX = lerp(LOCKUP_X + LOGO_SIZE + LOCK_GAP, (1920 - SCIP_WIDTH) / 2, close);
  const leave = interpolate(f, [DECIDER - 12, DECIDER - 2], [0, 1], {easing: EASE_EXIT, extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const tagIn = ease(f, scipAt + 8, 10);

  // Route
  const relie = wordAt('relie');
  const routeIn = ease(f, relie, 18);
  const endsIn = ease(f, relie + 12, 8);
  // The gate lifts one beat before the first landing and drops again once the container is through.
  const gateOpen = ease(f, HOPS[0] - FRAMES_PER_BEAT, HOP_FRAMES) - ease(f, HOPS[1], HOP_FRAMES);
  const box = containerAt(f);
  const boxIn = ease(f, relie + 16, 8);
  const lastLanding = HOPS.filter((h) => h <= f).pop();
  const thud = lastLanding === undefined ? 0 : 1 - clamp01((f - lastLanding) / 5);
  const half = ((ROUTE.to - ROUTE.from) / 2) * routeIn;
  const mid = (ROUTE.from + ROUTE.to) / 2;

  const suivreIn = ease(f, SUIVRE, 8);
  const optimiserIn = ease(f, DECIDER, 8);
  const stamps = stampStates(f);

  return (
    <AbsoluteFill style={{background: pal.bg}}>
      {/* ── The route ── */}
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0, overflow: 'visible'}}>
        <line x1={mid - half} x2={mid + half} y1={ROUTE.y} y2={ROUTE.y} stroke={pal.ink} strokeWidth={3} />
        {HOPS.map((h, k) => {
          const x = ROUTE.start + (k + 1) * STEP;
          const hit = f >= h;
          const bump = hit ? 1 + 0.25 * Math.sin(Math.PI * clamp01((f - h) / 8)) : 1;
          return (
            <rect key={h} x={x - 1.5 * bump} y={ROUTE.y + 4} width={3 * bump} height={12 * bump} opacity={endsIn} fill={hit ? pal.ink : pal.dim} />
          );
        })}
        <Gate open={gateOpen} show={endsIn} />
        <Dock show={endsIn} />
      </svg>
      {/* The hexagon's lowest vertex is at 20/24 of the glyph box: it stands on the top of the 3 px route. */}
      <ContainerGlyph
        size={CONTAINER}
        color={pal.ink}
        style={{
          position: 'absolute', left: box.x - CONTAINER / 2, top: ROUTE.y - 1.5 - CONTAINER * (40 / 48) - box.lift,
          opacity: boxIn, transform: `scaleY(${1 - 0.16 * thud}) scaleX(${1 + 0.08 * thud})`, transformOrigin: '50% 83%',
        }}
      />

      {/* Labels under the route, on their words */}
      <div style={{position: 'absolute', left: ROUTE.from - 4, top: ROUTE.y + 40}}>
        <SplitText words={ROUTE_LABELS.gate} frame={f} rise={16} tag="div" textAlign="left" style={{...LABEL, color: pal.muted}} />
      </div>
      <div style={{position: 'absolute', right: 1920 - (ROUTE.to + 96), top: ROUTE.y + 40}}>
        <SplitText words={ROUTE_LABELS.dock} frame={f} rise={16} tag="div" textAlign="right" style={{...LABEL, color: pal.muted}} />
      </div>
      <div
        style={{
          position: 'absolute', left: mid, top: ROUTE.y + 30 - 16 * (1 - suivreIn), transform: 'translateX(-50%)', opacity: suivreIn,
        }}
      >
        <Chip theme="light">SUIVRE</Chip>
      </div>

      {/* ── Wordmark ── */}
      {leave < 1 && (
        <div style={{position: 'absolute', left: 0, top: -40 * leave, width: 1920, height: 1080, opacity: 1 - leave}}>
          <div style={{position: 'absolute', left: scipX, top: SCIP_TOP}}>
            <SplitText
              words={[{text: 'SCIP', at: scipAt}]} frame={f} mode="chars" charStagger={2} rise={80} duration={10} tag="div"
              textAlign="left"
              style={{fontFamily: CONDENSED, fontWeight: 600, fontSize: 400, lineHeight: 1, letterSpacing: '-0.02em', color: pal.ink, whiteSpace: 'nowrap'}}
            />
          </div>
          <div
            style={{
              ...LABEL, letterSpacing: '0.2em', position: 'absolute', left: scipX + SCIP_WIDTH / 2, top: SCIP_TOP + 400 - 8,
              transform: `translate(-50%, ${12 * (1 - tagIn)}px)`, opacity: tagIn, color: pal.muted,
            }}
          >
            SUPPLY CHAIN INTELLIGENCE PLATFORM
          </div>
        </div>
      )}

      {/* ── OPTIMISER and the four stamps ── */}
      <div style={{position: 'absolute', left: 960, top: 150 - 16 * (1 - optimiserIn), transform: 'translateX(-50%)', opacity: optimiserIn}}>
        <Chip theme="light">OPTIMISER</Chip>
      </div>
      {[[0, 1, 2], [3]].map((row, r) => (
        <div key={r} style={{position: 'absolute', left: 0, width: 1920, top: 226 + 140 * r, display: 'flex', justifyContent: 'center', gap: 88}}>
          {row.map((i) => (
            <div
              key={i}
              style={{
                ...stampStyle, visibility: stamps[i].visible ? 'visible' : 'hidden',
                opacity: Math.min(1, 3 * ease(f, STAMP_CUES[i], STAMP_FRAMES)) * (1 - 0.72 * stamps[i].dim),
                transform: `scale(${stamps[i].scale})`, transformOrigin: '50% 60%',
              }}
            >
              {STAMP_WORDS[i]}
            </div>
          ))}
        </div>
      ))}

      {/* ── Impact ── */}
      {wave > 0 && wave < 1 && (
        <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
          <circle cx={BIRTH.x} cy={BIRTH.y} r={60 + 300 * wave} fill="none" stroke={pal.ink} strokeWidth={4 - 3 * wave} opacity={0.6 * (1 - wave)} />
        </svg>
      )}
      {logo.visible && (
        <Logo size={logo.size} stroke={logo.stroke} color={pal.ink} drawProgress={draw} style={{position: 'absolute', left: logo.x, top: logo.y}} />
      )}
      {flash > 0 && <AbsoluteFill style={{background: '#ffffff', opacity: flash}} />}
    </AbsoluteFill>
  );
};
