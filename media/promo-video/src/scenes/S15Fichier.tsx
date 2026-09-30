// src/scenes/S15Fichier.tsx — S15 · Un seul fichier, 136-148 s, light, COUPLET 4 (spec § 4 S15).
// « Et tout ça ? »: the pieces of the film (container notes, pins, sequencer cells) orbit the centre and are drawn into
// one file icon, « SCIP-Setup.exe » with its « 1 FICHIER » badge, whose four content bars they fill. On « fichier » the
// file bursts and its four bars tip into an exploded isometric stack at the angles of the logo — MOTEUR IA,
// POSTGRESQL 16 + POSTGIS, API, INTERFACE rising bottom first on the D F A D arpeggio — each slab with its pictogram and
// its install step. The steps light up one by one from « installé » (StatusMark), and the facts drop as chips on their
// words: WINDOWS, SANS DROITS ADMINISTRATEUR, BASE INTÉGRÉE (RECOMMANDÉ). Last third, on « et par défaut »: the stack
// closes into one block and settles in a PC; a dotted circle « 127.0.0.1 · PAR DÉFAUT » draws around it. Outside, the
// Wi-Fi's waves stay faint and stop at the circle; « RÉSEAU LOCAL : DÉSACTIVÉ » with its padlock, which snaps shut on
// « PC », and the caption « optionnel · Réglages ». No signal colour: the scene has no coloured cue.
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {Chip} from '../components/Chip';
import {ContainerGlyph} from '../components/ContainerGlyph';
import {IsoStack, lerpSlab, morphQuad, stackSlabs, type Box, type IsoSlabSpec, type Slab, type SlabGlyph} from '../components/IsoStack';
import {Logo} from '../components/Logo';
import {Pin} from '../components/Pin';
import {LABEL, MONO} from '../components/typography';
import {quantize, roundHalfUp, SIXTEENTH} from '../lib/beat';
import {EASE_EXIT, EASE_OUT} from '../lib/easing';
import {randRange} from '../lib/prng';
import {cueLocal, sceneDef, wordLocal} from '../lib/timeline';
import {StatusMark, type StatusMarkState} from '../rb/StatusMark';
import {palette} from '../theme/tokens';
import {clamp01, lerp, lerpPoint, pop, ramp, type Point} from './refrain';
import {WifiGlyph} from './S16HorsLigne';

const S = 'S15' as const;
const theme = sceneDef(S).theme;
const pal = palette(theme);
const linear = (t: number): number => t;

/** Voice-driven entry: on the nearest sixteenth, 2 frames early (spec § 3.5). */
const wordAt = (screen: string): number => quantize(wordLocal(S, screen).start, '16th') - 2;
/** An entry that is already visible on its cue frame (the event's sound lands on that frame). */
const enter = (f: number, at: number, frames: number): number => EASE_OUT(clamp01((f - at + 1) / frames));

export const SLABS: ReadonlyArray<{label: string; glyph: SlabGlyph}> = [
  {label: 'INTERFACE', glyph: 'window'},
  {label: 'API', glyph: 'hub'},
  {label: 'POSTGRESQL 16 + POSTGIS', glyph: 'table'},
  {label: 'MOTEUR IA', glyph: 'network'},
];

export const CHIPS: ReadonlyArray<{text: string; cue: string}> = [
  {text: 'WINDOWS', cue: 'S15.windows'},
  {text: 'SANS DROITS ADMINISTRATEUR', cue: 'S15.admin'},
  {text: 'BASE INTÉGRÉE (RECOMMANDÉ)', cue: 'S15.base'},
];

/** Pieces of the film drawn into the file (see ORBIT_KINDS). */
const ORBIT_COUNT = 14;
const ABSORB_FRAMES = 12;
const FLY_FRAMES = 12;
const PROGRESS_FRAMES = 10;
const DONE_DRAW = 14;
const PC_FRAMES = 18;

export const S15_T = (() => {
  const file = cueLocal(S, 'S15.file');
  const explode = cueLocal(S, 'S15.explode');
  const absorb = file + 2;
  // The four slabs rise bottom first (MOTEUR IA on D4 … INTERFACE on D5), one sixteenth apart; indexed top to bottom.
  const takeoff = SLABS.map((_, i) => explode + roundHalfUp((SLABS.length - 1 - i) * SIXTEENTH));
  const installe = quantize(wordLocal(S, 'installé').start, '16th');
  const lock = cueLocal(S, 'S15.lock');
  const toggle = wordAt("n'écoute");
  return {
    file,
    /** The k-th piece is drawn into the file from absorb + k. */
    absorb,
    /** The file's four bars fill in as the pieces land, the last one with the last piece. */
    barsIn: SLABS.map((_, k) => absorb + ABSORB_FRAMES + roundHalfUp(((k + 1) * (ORBIT_COUNT - 1)) / SLABS.length)),
    windows: cueLocal(S, 'S15.windows'),
    explode,
    takeoff,
    land: takeoff.map((t) => t + FLY_FRAMES),
    labelIn: takeoff.map((t) => t + 4),
    /** Install steps completed one eighth apart from « installé », in reading order. */
    done: SLABS.map((_, i) => installe + roundHalfUp(i * 2 * SIXTEENTH)),
    admin: cueLocal(S, 'S15.admin'),
    base: cueLocal(S, 'S15.base'),
    /** « et par défaut »: the last third, on a beat. */
    pc: quantize(wordLocal(S, 'et').start, 'beat'),
    circle: wordAt('défaut'),
    wifi: wordAt("l'API"),
    toggle,
    lock,
    /** The caption belongs to the switch: it follows it by an eighth. */
    caption: toggle + roundHalfUp(2 * SIXTEENTH),
  };
})();

// ---------------------------------------------------------------------------------------------------------------------
// Layout (1920 × 1080, 96 px margins)

const CHIP_Y = 136;
const FILE: Box = {x: 850, y: 322, w: 220, h: 280};
const FILE_C: Point = {x: FILE.x + FILE.w / 2, y: FILE.y + FILE.h / 2};
const EAR = 46;
const BARS: readonly Box[] = SLABS.map((_, k) => ({x: FILE.x + 28, y: FILE.y + 116 + 36 * k, w: 164, h: 22}));

/** Exploded stack: each top face shown whole (pitch > 2b + t), the column centred on the content band. */
const SLAB_A = 124;
const SLAB_T = 26;
export const EXPLODED: readonly Slab[] = stackSlabs(SLABS.length, {cx: 657, cy: 300, a: SLAB_A, t: SLAB_T, pitch: 180});
const LABEL_X = 657 + SLAB_A + 70;
const LABEL_SIZE = 30;
const MARK = 40;
const rowY = (i: number): number => EXPLODED[i].cy + SLAB_T / 2;
/** Mono advance 0.6 em plus the tracking. */
const monoWidth = (text: string, size: number, tracking: number): number => text.length * size * (0.6 + tracking) - size * tracking;
export const LABEL_BOXES: readonly Box[] = SLABS.map((s, i) => ({x: LABEL_X, y: rowY(i) - 22, w: MARK + 18 + monoWidth(s.label, LABEL_SIZE, 0.06), h: 44}));

/** The PC: a dotted circle around a monitor, the settings to its right. */
export const CIRCLE = {x: 640, y: 560, r: 280} as const;
const SCREEN: Box = {x: CIRCLE.x - 150, y: 432, w: 300, h: 190};
const PC_SCALE = 0.6;
const IN_PC_BLOCK = 2 * SLAB_A * PC_SCALE * (4.5 / 8) + 4 * SLAB_T * PC_SCALE;
export const IN_PC: readonly Slab[] = stackSlabs(SLABS.length, {
  cx: CIRCLE.x,
  cy: SCREEN.y + SCREEN.h / 2 - IN_PC_BLOCK / 2 + SLAB_A * PC_SCALE * (4.5 / 8),
  a: SLAB_A * PC_SCALE,
  t: SLAB_T * PC_SCALE,
  pitch: SLAB_T * PC_SCALE,
});
const RIGHT_X = 1040;
const WIFI: Point = {x: RIGHT_X + 40, y: 420};
const TOGGLE_Y = 560;
const CIRCLE_LABEL = '127.0.0.1 · PAR DÉFAUT';
const NETWORK_LABEL = 'RÉSEAU LOCAL : DÉSACTIVÉ';
const CAPTION = 'optionnel · Réglages';
export const PC_GROUP: readonly Box[] = [
  {x: CIRCLE.x - (monoWidth(CIRCLE_LABEL, 24, 0.08) + 32) / 2, y: CIRCLE.y + CIRCLE.r - 22, w: monoWidth(CIRCLE_LABEL, 24, 0.08) + 32, h: 44},
  {x: WIFI.x - 22, y: WIFI.y - 22, w: 44, h: 44},
  {x: RIGHT_X, y: TOGGLE_Y - 22, w: 76 + 16 + 30 + 20 + monoWidth(NETWORK_LABEL, 24, 0.08), h: 44},
  {x: RIGHT_X, y: TOGGLE_Y + 46, w: monoWidth(CAPTION, 24, 0.02), h: 28},
];

// ---------------------------------------------------------------------------------------------------------------------
// Event → state

/** Entry of chip `i` (0..1), from its cue. */
export const chipIn = (i: number, f: number): number => enter(f, cueLocal(S, CHIPS[i].cue), 8);

export const lockClosed = (f: number): boolean => f >= S15_T.lock;
/** The padlock's shackle, 0 = open, 1 = shut: it drops over the frames before the latch and is home on the lock cue (its sound). */
export const shackle = (f: number): number => ramp(f, S15_T.lock - 3, 3);

/** StatusMark of step `i`: idle while it waits, a progress arc over the frames before it is done, then done. */
export const statusAt = (i: number, f: number): {state: StatusMarkState; progress: number; drawDone: number} => {
  const d = S15_T.done[i];
  if (f < d - PROGRESS_FRAMES) return {state: 'idle', progress: 0, drawDone: 0};
  if (f < d) return {state: 'progress', progress: (f - (d - PROGRESS_FRAMES)) / PROGRESS_FRAMES, drawDone: 0};
  return {state: 'done', progress: 1, drawDone: clamp01((f - d) / DONE_DRAW)};
};

/** Slab `i`: a bar of the file, tipping into its place in the exploded stack, then closing into the PC. */
export const slabAt = (i: number, f: number): IsoSlabSpec => {
  const T = S15_T;
  const {glyph} = SLABS[i];
  const home = EXPLODED[i];
  if (f < T.takeoff[i]) {
    const e = ramp(f, T.barsIn[i], 6);
    return {slab: home, quad: morphQuad({...BARS[i], w: BARS[i].w * Math.max(e, 0.01)}, home, 0), t: 0, lit: 0, glyph, glyphOpacity: 0, opacity: e};
  }
  const fly = ramp(f, T.takeoff[i], FLY_FRAMES);
  if (fly < 1) return {slab: home, quad: morphQuad(BARS[i], home, fly), t: home.t * fly, lit: 0, glyph, glyphOpacity: 0};
  const toPc = ramp(f, T.pc, PC_FRAMES);
  return {
    slab: toPc > 0 ? lerpSlab(home, IN_PC[i], toPc) : home,
    lit: ramp(f, T.done[i], 8),
    glyph,
    glyphOpacity: ramp(f, T.land[i], 8, linear) * (1 - ramp(f, T.pc, 8, linear)),
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// « Et tout ça ? »: the film's instruments in orbit, then drawn into the file

/** One pictogram per piece of the film: the heartbeat (S01), the staff and its notes (S02), the pin (S04), the ring
 * (S06), the tuner (S06), the model bars (S12), the keys (S13), the faders (S11), the globe (S10), the code (S14). */
type OrbitKind = 'pulse' | 'staff' | 'note' | 'pin' | 'ring' | 'gauge' | 'bars' | 'keys' | 'faders' | 'globe' | 'code';
const ORBIT_KINDS: readonly OrbitKind[] = ['pulse', 'staff', 'note', 'pin', 'ring', 'gauge', 'note', 'bars', 'keys', 'faders', 'globe', 'code', 'pin', 'note'];
const ORBIT = ORBIT_KINDS.slice(0, ORBIT_COUNT).map((kind, i) => ({
  angle: i * (360 / ORBIT_COUNT) + randRange(-6, 6, 1501, i),
  rx: 650 + randRange(-30, 30, 1502, i),
  ry: 296 + randRange(-20, 20, 1503, i),
  kind,
  /** Absorption order: alternate sides of the orbit, so the file fills evenly. */
  order: (i % 2) * (ORBIT_COUNT / 2) + Math.floor(i / 2),
}));
const orbitPoint = (o: (typeof ORBIT)[number], f: number): Point => {
  const a = ((o.angle + 0.45 * f) * Math.PI) / 180;
  return {x: FILE_C.x + o.rx * Math.cos(a), y: FILE_C.y + o.ry * Math.sin(a)};
};

const ICON = 56;
const ICON_PATHS: Partial<Record<OrbitKind, string>> = {
  pulse: 'M4 30H16L20 20L24 38L29 10L33 30H44',
  staff: 'M5 14H43M5 20H43M5 26H43M5 32H43M5 38H43M31 29V9',
  ring: 'M24 8A16 16 0 1 1 23.99 8M24 24 35 13',
  gauge: 'M7 34A17 17 0 0 1 41 34M24 34 33 21',
  bars: 'M8 40H40M11 40V26H17V40M21 40V16H27V40M31 40V22H37V40',
  keys: 'M6 12H42V38H6ZM15 12V38M24 12V38M33 12V38',
  faders: 'M12 8V40M24 8V40M36 8V40',
  globe: 'M24 8A16 16 0 1 1 23.99 8M24 8C16 14 16 34 24 40C32 34 32 14 24 8M8 24H40',
  code: 'M18 13 8 24 18 35M30 13 40 24 30 35M27 11 21 37',
};

const OrbitGlyph: React.FC<{kind: OrbitKind}> = ({kind}) => {
  if (kind === 'pin') return <Pin size={ICON} stroke={2.4} color={pal.ink} />;
  if (kind === 'note') return <ContainerGlyph size={40} color={pal.ink} />;
  return (
    <svg width={ICON} height={ICON} viewBox="0 0 48 48" style={{display: 'block', overflow: 'visible'}}>
      <path d={ICON_PATHS[kind]} fill="none" stroke={pal.ink} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
      {kind === 'staff' && <ellipse cx={27} cy={29} rx={4.4} ry={3.4} transform="rotate(-20 27 29)" fill={pal.ink} />}
      {kind === 'gauge' && <circle cx={24} cy={34} r={2.6} fill={pal.ink} />}
      {kind === 'keys' && [15, 24, 33].map((x) => <rect key={x} x={x - 2.5} y={12} width={5} height={15} fill={pal.ink} />)}
      {kind === 'faders' && [[12, 30], [24, 16], [36, 24]].map(([x, y]) => <rect key={x} x={x - 5} y={y - 3} width={10} height={6} rx={1.5} fill={pal.ink} />)}
      {kind === 'ring' && <circle cx={24} cy={24} r={3} fill={pal.ink} />}
    </svg>
  );
};

// ---------------------------------------------------------------------------------------------------------------------
// Drawings

const FILE_PATH = `M${FILE.x} ${FILE.y}H${FILE.x + FILE.w - EAR}L${FILE.x + FILE.w} ${FILE.y + EAR}V${FILE.y + FILE.h}H${FILE.x}Z`;
const EAR_PATH = `M${FILE.x + FILE.w - EAR} ${FILE.y}V${FILE.y + EAR}H${FILE.x + FILE.w}`;

const Padlock: React.FC<{closed: number; color: string; hole: string}> = ({closed, color, hole}) => (
  <svg width={30} height={40} viewBox="0 0 30 40" style={{display: 'block', flex: 'none', overflow: 'visible'}}>
    <path d="M8 20V12a7 7 0 0 1 14 0v8" fill="none" stroke={color} strokeWidth={3.2} transform={`translate(0 ${-8 * (1 - closed)})`} />
    <rect x={3} y={18} width={24} height={20} rx={4} fill={color} />
    <circle cx={15} cy={27} r={2.6} fill={hole} />
    <rect x={14} y={27} width={2} height={5} fill={hole} />
  </svg>
);

const Switch: React.FC = () => (
  <div style={{position: 'relative', width: 76, height: 40, borderRadius: 20, boxSizing: 'border-box', border: `2px solid ${pal.muted}`, background: pal.surface, flex: 'none'}}>
    <div style={{position: 'absolute', left: 5, top: 5, width: 26, height: 26, borderRadius: 13, background: pal.muted}} />
  </div>
);

const CIRCLE_DOTS = 112;
/** Half-width of the circle's label chip: the dotted line stops at its edges. */
const LABEL_HALF = PC_GROUP[0].w / 2 + 10;
const WAVE_LIFE = 30;
const WAVE_EVERY = 7.5;
const WAVE_FROM = 30;
/** Just past the circle wall, seen from the Wi-Fi. */
const WAVE_TO = Math.hypot(WIFI.x - CIRCLE.x, WIFI.y - CIRCLE.y) - CIRCLE.r + 30;
/** The ripples are arcs aimed at the PC, ±34° around the direction of the circle's centre. */
const WAVE_AIM = Math.atan2(CIRCLE.y - WIFI.y, CIRCLE.x - WIFI.x);
const WAVE_SPREAD = (34 * Math.PI) / 180;
const waveArc = (r: number): string => {
  const a0 = WAVE_AIM - WAVE_SPREAD;
  const a1 = WAVE_AIM + WAVE_SPREAD;
  return `M${WIFI.x + r * Math.cos(a0)} ${WIFI.y + r * Math.sin(a0)}A${r} ${r} 0 0 1 ${WIFI.x + r * Math.cos(a1)} ${WIFI.y + r * Math.sin(a1)}`;
};

export const S15Fichier: React.FC = () => {
  const f = useCurrentFrame();
  const T = S15_T;

  // The file
  const fileIn = enter(f, T.file, 8);
  const burst = ramp(f, T.explode, 8, EASE_EXIT);
  const fileScale = (0.92 + 0.08 * fileIn) * pop(f, T.file, 1.06) * (1 + 0.12 * burst);
  const fileOpacity = fileIn * (1 - burst);
  const fileExtras = fileIn * (1 - ramp(f, T.explode, 6, linear));

  // The PC
  const toPc = ramp(f, T.pc, PC_FRAMES);
  const labelsOut = ramp(f, T.pc, 8, EASE_EXIT);
  const monitor = ramp(f, T.pc + 4, 18, linear);
  const circle = ramp(f, T.circle, 18, linear);
  const circleLabel = enter(f, T.circle + 4, 8);
  const wifiIn = enter(f, T.wifi, 8);
  const toggleIn = enter(f, T.toggle, 10);
  const closed = shackle(f);
  const captionIn = enter(f, T.caption, 10);

  // The network outside: ripples leave the Wi-Fi towards the PC, one per eighth, fading as they travel (« atténuées »),
  // and die against the dotted circle (masked inside it).
  const waves: Array<{r: number; o: number}> = [];
  if (f >= T.wifi) {
    for (let born = T.wifi; born <= f; born += WAVE_EVERY) {
      const p = (f - born) / WAVE_LIFE;
      if (p < 1) waves.push({r: WAVE_FROM + (WAVE_TO - WAVE_FROM) * p, o: 0.75 * (1 - p) ** 1.4});
    }
  }

  return (
    <AbsoluteFill style={{background: pal.bg}}>
      {/* ── « Et tout ça ? » ── */}
      {ORBIT.map((o, i) => {
        const start = T.absorb + o.order;
        if (f >= start + ABSORB_FRAMES) return null;
        const e = ramp(f, start, ABSORB_FRAMES, EASE_EXIT);
        const p = lerpPoint(orbitPoint(o, Math.min(f, start)), FILE_C, e);
        return (
          <div
            key={i}
            style={{
              position: 'absolute', left: p.x, top: p.y, transform: `translate(-50%, -50%) scale(${1 - 0.7 * e})`,
              opacity: 1 - ramp(f, start + ABSORB_FRAMES * 0.7, ABSORB_FRAMES * 0.3, linear),
            }}
          >
            <OrbitGlyph kind={o.kind} />
          </div>
        );
      })}

      {/* ── The file ── */}
      {fileOpacity > 0 && (
        <svg
          width={1920} height={1080}
          style={{position: 'absolute', left: 0, top: 0, opacity: fileOpacity, transformOrigin: `${FILE_C.x}px ${FILE_C.y}px`, transform: `scale(${fileScale})`}}
        >
          <path d={FILE_PATH} fill={pal.surface2} stroke={pal.ink} strokeWidth={3} strokeLinejoin="round" />
          <path d={EAR_PATH} fill="none" stroke={pal.ink} strokeWidth={3} strokeLinejoin="round" />
        </svg>
      )}
      {fileExtras > 0 && (
        <>
          <Logo size={56} stroke={2} color={pal.ink} style={{position: 'absolute', left: FILE.x + 24, top: FILE.y + 30, opacity: fileExtras}} />
          <div
            style={{
              ...LABEL, position: 'absolute', left: FILE.x + FILE.w - 64, top: FILE.y + FILE.h - 22, height: 44, padding: '0 14px',
              display: 'flex', alignItems: 'center', borderRadius: 6, background: pal.ink, color: pal.surface2, opacity: fileExtras,
              transform: `scale(${pop(f, T.file + 6, 1.12)})`,
            }}
          >
            1 FICHIER
          </div>
          <div
            style={{
              fontFamily: MONO, fontWeight: 500, fontSize: 36, lineHeight: 1, position: 'absolute', left: 0, width: 1920, top: FILE.y + FILE.h + 50,
              textAlign: 'center', color: pal.ink, opacity: fileExtras,
            }}
          >
            SCIP-Setup.exe
          </div>
        </>
      )}

      {/* ── The PC: dotted circle, waves outside, monitor ── */}
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
        <defs>
          <mask id="s15-outside-circle">
            <rect x={0} y={0} width={1920} height={1080} fill="white" />
            <circle cx={CIRCLE.x} cy={CIRCLE.y} r={CIRCLE.r + 10} fill="black" />
          </mask>
        </defs>
        {circle > 0 &&
          Array.from({length: CIRCLE_DOTS}, (_, k) => {
            if (k / CIRCLE_DOTS > circle) return null;
            // Clockwise from the bottom, where the label sits; the line stops at the label's edges.
            const a = Math.PI / 2 + (2 * Math.PI * k) / CIRCLE_DOTS;
            const x = CIRCLE.x + CIRCLE.r * Math.cos(a);
            const y = CIRCLE.y + CIRCLE.r * Math.sin(a);
            if (y > CIRCLE.y && Math.abs(x - CIRCLE.x) < LABEL_HALF) return null;
            return <circle key={k} cx={x} cy={y} r={2.4} fill={pal.ink} />;
          })}
        <g mask="url(#s15-outside-circle)" fill="none" stroke={pal.muted} strokeWidth={2} strokeLinecap="round">
          {waves.map((w, k) => <path key={k} d={waveArc(w.r)} opacity={w.o * wifiIn} />)}
        </g>
        {monitor > 0 && (
          <g fill="none" stroke={pal.ink} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round">
            <rect
              x={SCREEN.x} y={SCREEN.y} width={SCREEN.w} height={SCREEN.h} rx={10} fill={pal.surface} fillOpacity={clamp01((monitor - 0.6) / 0.4)}
              pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - monitor}
            />
            <path
              d={`M${CIRCLE.x - 18} ${SCREEN.y + SCREEN.h}L${CIRCLE.x - 26} ${SCREEN.y + SCREEN.h + 34}H${CIRCLE.x + 26}L${CIRCLE.x + 18} ${SCREEN.y + SCREEN.h}M${CIRCLE.x - 70} ${SCREEN.y + SCREEN.h + 36}H${CIRCLE.x + 70}`}
              pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - monitor}
            />
          </g>
        )}
      </svg>

      {/* ── The slabs ── */}
      <IsoStack theme={theme} slabs={SLABS.map((_, i) => slabAt(i, f))} stroke={lerp(2, 1.5, toPc)} />

      {/* ── Install steps ── */}
      {labelsOut < 1 &&
        SLABS.map((s, i) => {
          const e = enter(f, T.labelIn[i], 8);
          if (e <= 0) return null;
          const st = statusAt(i, f);
          const y = rowY(i);
          const lineFrom = EXPLODED[i].cx + SLAB_A + 10;
          const color = st.state === 'done' ? pal.ink : pal.muted;
          return (
            <div key={s.label} style={{position: 'absolute', inset: 0, opacity: e * (1 - labelsOut), transform: `translateX(${-16 * (1 - e) + 24 * labelsOut}px)`}}>
              <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
                <circle cx={lineFrom} cy={y} r={3} fill={color} />
                <line x1={lineFrom} x2={LABEL_X - 14} y1={y} y2={y} stroke={color} strokeWidth={1.5} />
              </svg>
              <div
                style={{
                  position: 'absolute', left: LABEL_X, top: y - 22, height: 44, display: 'flex', alignItems: 'center', gap: 18, color,
                  transformOrigin: '0 50%', transform: `scale(${i === 2 ? pop(f, T.base, 1.08) : 1})`,
                }}
              >
                <StatusMark state={st.state} progress={st.progress} drawDone={st.drawDone} size={MARK} strokeWidth={2.2} color={color} doneColor={pal.ink} fillOpacity={0.08} />
                <span style={{...LABEL, fontSize: LABEL_SIZE, letterSpacing: '0.06em'}}>{s.label}</span>
              </div>
            </div>
          );
        })}

      {/* ── Settings, outside the circle ── */}
      {circleLabel > 0 && (
        <div style={{position: 'absolute', left: 0, width: 2 * CIRCLE.x, top: CIRCLE.y + CIRCLE.r - 22, display: 'flex', justifyContent: 'center', opacity: circleLabel}}>
          <Chip theme={theme} style={{background: pal.surface2}}>{CIRCLE_LABEL}</Chip>
        </div>
      )}
      {wifiIn > 0 && (
        <div style={{position: 'absolute', left: WIFI.x - 22, top: WIFI.y - 26, opacity: wifiIn}}>
          <WifiGlyph size={44} color={pal.dim} />
        </div>
      )}
      {toggleIn > 0 && (
        <div
          style={{
            position: 'absolute', left: RIGHT_X, top: TOGGLE_Y - 22, height: 44, display: 'flex', alignItems: 'center', gap: 16,
            opacity: toggleIn, transform: `translateX(${-16 * (1 - toggleIn)}px)`,
          }}
        >
          <Switch />
          <div style={{transform: `scale(${pop(f, T.lock)})`, marginRight: 4}}>
            <Padlock closed={closed} color={pal.ink} hole={pal.bg} />
          </div>
          <span style={{...LABEL, color: pal.ink}}>{NETWORK_LABEL}</span>
        </div>
      )}
      {captionIn > 0 && (
        <div style={{...LABEL, letterSpacing: '0.02em', position: 'absolute', left: RIGHT_X, top: TOGGLE_Y + 48, color: pal.muted, opacity: captionIn}}>{CAPTION}</div>
      )}

      {/* ── The facts ── */}
      <div style={{position: 'absolute', left: 0, width: 1920, top: CHIP_Y, display: 'flex', justifyContent: 'center', gap: 16}}>
        {CHIPS.map((c, i) => {
          const e = chipIn(i, f);
          return (
            <div key={c.text} style={{opacity: e, transform: `translateY(${-10 * (1 - e)}px) scale(${pop(f, cueLocal(S, c.cue), 1.08)})`}}>
              <Chip theme={theme} style={{background: pal.surface2}}>{c.text}</Chip>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
