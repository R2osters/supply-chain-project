// src/scenes/refrain.tsx — the world the two refrain scenes share (spec § 4 S06-S07): the sequencer ring, its four
// station cards (SUIVRE at 12 h, OPTIMISER at 3 h, RECOMMANDATION at 6 h, HUMAIN at 9 h), the domain_events cylinder,
// the arm's path from station to station, and a camera that pushes into a station and recoils (spec § 3.5,
// transition 3: scale, ease-out, never a blur).
// S06 hands the world over to S07 in the state it leaves it, so the cut between them is seamless.
import type {CSSProperties, ReactNode} from 'react';
import {AbsoluteFill} from 'remotion';
import {armAngle, LoopSequencer, RING_CENTER, RING_RADIUS, ringPoint, STEP_DEG, type LoopHighlight} from '../components/LoopSequencer';
import {DemoPill} from '../components/DemoPill';
import {ExamplePill} from '../components/ExamplePill';
import {LABEL} from '../components/typography';
import {FRAMES_PER_BEAT, roundHalfUp} from '../lib/beat';
import {EASE_OUT} from '../lib/easing';
import {frInt, frPercent} from '../lib/format';
import {sceneDef} from '../lib/timeline';
import {palette, SHADOW, signal, type SignalColor, type Theme} from '../theme/tokens';

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export const THEME: Theme = sceneDef('S06').theme;
export const SCREEN_CENTER: Point = {x: 960, y: 540};

// ---------------------------------------------------------------------------------------------------------------------
// Maths

export const lerp = (a: number, b: number, p: number): number => a * (1 - p) + b * p;
export const lerpPoint = (a: Point, b: Point, p: number): Point => ({x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p)});
export const lerpRect = (a: Rect, b: Rect, p: number): Rect => ({x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), w: lerp(a.w, b.w, p), h: lerp(a.h, b.h, p)});
export const rectCenter = (r: Rect): Point => ({x: r.x + r.w / 2, y: r.y + r.h / 2});
export const rectAround = (c: Point, w: number, h: number): Rect => ({x: c.x - w / 2, y: c.y - h / 2, w, h});
export const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Eased progress of a move that starts at `from` and lasts `frames` frames, clamped to 0..1. */
export const ramp = (f: number, from: number, frames: number, easing: (t: number) => number = EASE_OUT): number =>
  easing(clamp01((f - from) / frames));

/** The playhead's trigger pop (spec § 2): scale 1 → 1.25 → 1 over 8 frames from `at`; 1 outside. */
export const pop = (f: number, at: number, peak = 1.25): number => {
  const t = f - at;
  if (t < 0 || t >= 8) return 1;
  return 1 + (peak - 1) * Math.sin((Math.PI * t) / 8);
};

// ---------------------------------------------------------------------------------------------------------------------
// Geometry of the world (1920 × 1080 world units = screen pixels when the camera rests)

export const STATION_W = 352;
export const STATION_H = 132;
/** From the ring line to a station hung inside the ring (12 h, 6 h): clear of the neighbouring cells, and of the
 * purchase order riding outside the ring in S07. */
const INSET = 72;
/** From the ring line to a station outside the ring (3 h, 9 h). */
const OUTSET = 44;

/** Station cards at 12, 3, 6 and 9 o'clock (SUIVRE, OPTIMISER, RECOMMANDATION, HUMAIN). */
export const STATION_RECTS: readonly Rect[] = [
  {x: RING_CENTER.x - STATION_W / 2, y: RING_CENTER.y - RING_RADIUS + INSET, w: STATION_W, h: STATION_H},
  {x: RING_CENTER.x + RING_RADIUS + OUTSET, y: RING_CENTER.y - STATION_H / 2, w: STATION_W, h: STATION_H},
  {x: RING_CENTER.x - STATION_W / 2, y: RING_CENTER.y + RING_RADIUS - INSET - STATION_H, w: STATION_W, h: STATION_H},
  {x: RING_CENTER.x - RING_RADIUS - OUTSET - STATION_W, y: RING_CENTER.y - STATION_H / 2, w: STATION_W, h: STATION_H},
];

/** The sequencer's cells are 28 × 12 px, tangential (spec § 4 S06); their axis-aligned box, for layout checks. */
export const cellBox = (i: number): Rect => {
  const a = (i * STEP_DEG * Math.PI) / 180;
  const w = Math.abs(28 * Math.cos(a)) + Math.abs(12 * Math.sin(a));
  const h = Math.abs(28 * Math.sin(a)) + Math.abs(12 * Math.cos(a));
  return rectAround(ringPoint(i * STEP_DEG), w, h);
};

/** The domain_events cylinder sits outside the ring at 2 o'clock, between SUIVRE and OPTIMISER, its label to the right. */
export const DB_CENTER: Point = ringPoint(60, 470);

// ---------------------------------------------------------------------------------------------------------------------
// The arm: the playhead of the loop follows the story (spec § 4 S07: « le bras passe à 6 h, puis poussée »). It rests on
// the station at work and travels to the next one a notch per beat, 22.5° in 6 frames (spec § 3.5).

/** Angles of the stations, clockwise from 12 o'clock: SUIVRE, OPTIMISER, RECOMMANDATION, HUMAIN. */
export const STATION_DEG = [0, 90, 180, 270] as const;
const NOTCHES_PER_STATION = roundHalfUp(90 / STEP_DEG);

export interface ArmPath {
  /** Where the arm rests when the scene starts (degrees clockwise from 12 o'clock, a multiple of a notch). */
  fromDeg: number;
  /** The frames a notch starts on (local frames, on beats, at least a beat apart). */
  notches: readonly number[];
}

/** The notches of a move to the next station, the last one starting on `last`: one per beat. */
export const travelTo = (last: number): number[] =>
  Array.from({length: NOTCHES_PER_STATION}, (_, k) => last - (NOTCHES_PER_STATION - 1 - k) * FRAMES_PER_BEAT);

/** LoopSequencer drives its arm from a frame, one notch per beat from frame 0. This is the frame at which that
 * free-running arm shows the angle `path` gives at `f`: notches done so far, plus the one in progress. */
export const armSequencerFrame = (f: number, path: ArmPath): number => {
  const started = path.notches.filter((s) => f >= s);
  const n = roundHalfUp(path.fromDeg / STEP_DEG) + started.length;
  if (n === 0) return 0;
  const since = started.length === 0 ? Infinity : f - started[started.length - 1];
  // Frames 0-5 of a beat move the free-running arm by one notch; frames 6-14 hold it there.
  return FRAMES_PER_BEAT * (n - 1) + Math.min(since, FRAMES_PER_BEAT - 1);
};

/** The arm's angle at `f` (degrees clockwise from 12 o'clock, not wrapped). */
export const armDegAt = (f: number, path: ArmPath): number => armAngle(armSequencerFrame(f, path));

// ---------------------------------------------------------------------------------------------------------------------
// Camera: the world point `focus` is shown at the centre of the frame, magnified `scale` times.

export interface Camera { scale: number; focus: Point }
export const IDENTITY: Camera = {scale: 1, focus: SCREEN_CENTER};

export const toScreen = (p: Point, cam: Camera): Point => ({
  x: SCREEN_CENTER.x + cam.scale * (p.x - cam.focus.x),
  y: SCREEN_CENTER.y + cam.scale * (p.y - cam.focus.y),
});
export const rectToScreen = (r: Rect, cam: Camera): Rect => {
  const o = toScreen({x: r.x, y: r.y}, cam);
  return {x: o.x, y: o.y, w: r.w * cam.scale, h: r.h * cam.scale};
};
/** The world fades out over the first frames of a push, before its magnified fragments could clutter the frame. */
export const WORLD_FADE = 10;
export const lerpCamera = (a: Camera, b: Camera, p: number): Camera => ({scale: lerp(a.scale, b.scale, p), focus: lerpPoint(a.focus, b.focus, p)});
/** A camera pushed onto a world point. */
export const pushOn = (focus: Point, scale: number): Camera => ({scale, focus});

const worldTransform = (cam: Camera): CSSProperties => ({
  transformOrigin: '0 0',
  transform: `translate(${SCREEN_CENTER.x - cam.scale * cam.focus.x}px, ${SCREEN_CENTER.y - cam.scale * cam.focus.y}px) scale(${cam.scale})`,
});

// ---------------------------------------------------------------------------------------------------------------------
// Station cards

const pal = palette(THEME);
const ROW: CSSProperties = {...LABEL, letterSpacing: 0, display: 'flex', alignItems: 'center', gap: 10, height: 30};
/** Pills inside a station row: the charter pill at 30 px (room for the accent of DÉMO), so a row stays 30 px high. */
export const SMALL_PILL: CSSProperties = {height: 30, padding: '0 8px'};

export const Dot: React.FC<{color: SignalColor; scale?: number; size?: number}> = ({color, scale = 1, size = 12}) => (
  <span style={{width: size, height: size, borderRadius: size / 2, background: signal(THEME, color), flex: 'none', transform: `scale(${scale})`}} />
);

export interface StationProps {
  title: ReactNode;
  /** Content lines under the title (up to two). */
  rows?: ReactNode[];
  /** Right end of the title line (a status dot). */
  titleEnd?: ReactNode;
  style?: CSSProperties;
}

export const StationCard: React.FC<StationProps> = ({title, rows = [], titleEnd, style}) => (
  <div
    style={{
      position: 'relative', boxSizing: 'border-box', width: STATION_W, height: STATION_H, padding: '14px 16px',
      display: 'flex', flexDirection: 'column', gap: 8, borderRadius: 10, background: pal.surface,
      border: `1px solid ${pal.line}`, boxShadow: SHADOW[THEME].md, color: pal.ink, ...style,
    }}
  >
    <div style={{...ROW, height: 24, marginBottom: 6, letterSpacing: '0.04em', color: pal.muted, justifyContent: 'space-between'}}>
      <span>{title}</span>
      {titleEnd}
    </div>
    {rows.map((r, i) => (
      <div key={i} style={ROW}>{r}</div>
    ))}
  </div>
);

/** A skeleton bar (no invented figure): a neutral bar with a highlight sweeping across it linearly (tape logic). */
export const Skeleton: React.FC<{frame: number; width: number; height?: number; delay?: number; radius?: number}> = ({frame, width, height = 12, delay = 0, radius}) => {
  const period = 45;
  const x = (((frame + delay) % period) / period) * (width + 160) - 160;
  return (
    <span
      style={{
        position: 'relative', display: 'inline-block', width, height, borderRadius: radius ?? height / 2, overflow: 'hidden', flex: 'none',
        background: pal.line,
      }}
    >
      <span style={{position: 'absolute', top: 0, bottom: 0, left: x, width: 160, background: `linear-gradient(90deg, transparent, ${pal.surface2} 50%, transparent)`, opacity: 0.9}} />
    </span>
  );
};

/** The HUMAIN station's decision, in miniature: outlined while pending, filled with the action colour once taken. */
export const MiniButton: React.FC<{filled: number}> = ({filled}) => (
  <span
    style={{
      ...ROW, position: 'relative', height: 32, padding: '0 10px', borderRadius: 6, boxSizing: 'border-box', overflow: 'hidden',
      border: `1.5px solid ${pal.action}`, color: pal.ink,
    }}
  >
    <span style={{position: 'absolute', inset: 0, background: pal.action, opacity: filled}} />
    <span style={{position: 'relative', color: filled >= 0.5 ? pal.actionText : pal.ink}}>ACCEPTER ET EXÉCUTER</span>
  </span>
);

// Station contents, in the states the two scenes show.
export const stationSuivreObserve = (dotScale: number): StationProps => ({
  title: 'SUIVRE · OBSERVE',
  rows: [
    <>
      <Dot color="crit" scale={dotScale} />
      <span>SHP-0142 · EN RETARD</span>
    </>,
    <DemoPill theme={THEME} style={SMALL_PILL} />,
  ],
});

const stationPending = (title: string, frame: number, widths: [number, number], delay = 0): StationProps => ({
  title,
  rows: [<Skeleton frame={frame} width={widths[0]} delay={delay} />, <Skeleton frame={frame} width={widths[1]} delay={delay + 8} />],
});
/** OPTIMISER and RECOMMANDATION before they have run: skeleton rows (no invented figure). */
export const stationOptimiserPending = (frame: number): StationProps => stationPending('OPTIMISER · RISQUE', frame, [210, 130]);
export const stationRecommandationPending = (frame: number): StationProps => stationPending('RECOMMANDATION', frame, [180, 240], 12);

export const stationOptimiserDone = (): StationProps => ({
  title: 'OPTIMISER · RISQUE',
  rows: [
    <>
      <span style={{color: signal(THEME, 'crit')}}>{frPercent(68)}</span>
      <ExamplePill theme={THEME} style={SMALL_PILL} />
    </>,
    <span style={{color: pal.muted}}>RISQUE DE RUPTURE</span>,
  ],
});

export const stationRecommandationDone = (): StationProps => ({
  title: 'RECOMMANDATION',
  rows: [
    <>
      <span>{frInt(3000)} UNITÉS</span>
      <ExamplePill theme={THEME} style={SMALL_PILL} />
    </>,
    <>
      <span>FOURNISSEUR C</span>
      <DemoPill theme={THEME} style={SMALL_PILL} />
    </>,
  ],
});

export const stationHumain = (filled: number): StationProps => ({title: 'HUMAIN · DÉCIDE', rows: [<MiniButton filled={filled} />]});

/** The live dot that beats on every live cue (spec § 4 S07: « un point live qui bat »): a pop and a fading ripple. */
export const LiveDot: React.FC<{frame: number; beats: readonly number[]}> = ({frame, beats}) => {
  const last = [...beats].reverse().find((b) => frame >= b);
  if (last === undefined) return null;
  const t = frame - last;
  const ripple = clamp01(t / 12);
  return (
    <span style={{position: 'relative', width: 14, height: 14, flex: 'none'}}>
      {t < 12 && (
        <span
          style={{
            position: 'absolute', left: 7 - 7 * (1 + 1.6 * ripple), top: 7 - 7 * (1 + 1.6 * ripple), width: 14 * (1 + 1.6 * ripple),
            height: 14 * (1 + 1.6 * ripple), borderRadius: '50%', boxSizing: 'border-box', border: `2px solid ${signal(THEME, 'live')}`,
            opacity: 1 - ripple,
          }}
        />
      )}
      <span style={{position: 'absolute', inset: 0, borderRadius: 7, background: signal(THEME, 'live'), transform: `scale(${pop(frame, last)})`}} />
    </span>
  );
};

export const stationSuivreSuivi = (title: ReactNode, liveDot: ReactNode): StationProps => ({
  title,
  titleEnd: liveDot,
  rows: [
    <>
      <span>PO-2026-0418</span>
      <DemoPill theme={THEME} style={SMALL_PILL} />
    </>,
    <span style={{color: pal.muted}}>BROUILLON</span>,
  ],
});

// ---------------------------------------------------------------------------------------------------------------------
// The domain_events cylinder (spec § 4 S06: « un cylindre de base de données domain_events · durable, qui clignote »)

export interface DbCylinderProps {
  frame: number;
  /** Frame it appears at; always there when omitted. */
  appear?: number;
  /** Frames of the blinks (the dbBlip sound). */
  writes?: readonly number[];
  /** Frame the event is written at (« ÉCRIT » appears); already written when omitted. */
  written?: number;
}

export const DbCylinder: React.FC<DbCylinderProps> = ({frame, appear, writes = [], written}) => {
  const a = appear === undefined ? 1 : ramp(frame, appear, 8);
  const writtenIn = written === undefined ? 1 : ramp(frame, written, 6);
  if (a <= 0) return null;
  const blink = writes.some((w) => frame >= w && frame < w + 3);
  const W = 68;
  const H = 84;
  const RY = 11;
  const records = written === undefined || frame >= written ? 3 : 2;
  return (
    <div style={{position: 'absolute', left: DB_CENTER.x - W / 2, top: DB_CENTER.y - H / 2, opacity: a, transform: `translateY(${(1 - a) * 10}px)`}}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{display: 'block', overflow: 'visible'}}>
        <path d={`M1 ${RY} V${H - RY} A${W / 2 - 1} ${RY} 0 0 0 ${W - 1} ${H - RY} V${RY}`} fill={pal.surface} stroke={pal.muted} strokeWidth={2} />
        {Array.from({length: records}, (_, k) => (
          <path key={k} d={`M1 ${RY + 20 + k * 18} A${W / 2 - 1} ${RY} 0 0 0 ${W - 1} ${RY + 20 + k * 18}`} fill="none" stroke={k === 2 ? pal.action : pal.line} strokeWidth={2} />
        ))}
        <ellipse cx={W / 2} cy={RY} rx={W / 2 - 1} ry={RY - 1} fill={blink ? pal.action : pal.surface2} stroke={pal.muted} strokeWidth={2} />
      </svg>
      <div style={{...LABEL, letterSpacing: '0.04em', position: 'absolute', left: W + 20, top: 6, color: pal.ink}}>
        domain_events <span style={{color: pal.muted}}>· durable</span>
      </div>
      <div
        style={{
          ...LABEL, position: 'absolute', left: W + 20, top: 44, color: pal.ink, display: 'flex', alignItems: 'center', gap: 10,
          opacity: writtenIn, transform: `translateY(${(1 - writtenIn) * 8}px)`,
        }}
      >
        <span style={{width: 10, height: 10, background: pal.action, flex: 'none'}} />
        ÉCRIT
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------------------------------------------------
// The ring world

export interface RingWorldProps {
  /** The scene's frame. */
  frame: number;
  /** Where the arm rests and when it travels (it ends S06 where S07 picks it up). */
  arm: ArmPath;
  camera: Camera;
  /** Opacity of the whole world (it recedes behind a card opened from a station). */
  opacity?: number;
  revealFrom?: number;
  highlight?: LoopHighlight;
  /** Station cards at 12, 3, 6, 9 h, each with its entry (0..1); null hides one (while it is open in front of the world). */
  stations: ReadonlyArray<{props: StationProps; opacity?: number} | null>;
  /** Anything else placed in world coordinates (the DB cylinder, the event pill). */
  children?: ReactNode;
}

/** Offset a station slides in from, towards the ring centre (it settles outwards onto its slot). */
const ENTER_FROM: readonly Point[] = [{x: 0, y: 16}, {x: -16, y: 0}, {x: 0, y: -16}, {x: 16, y: 0}];

export const RingWorld: React.FC<RingWorldProps> = ({frame, arm, camera, opacity = 1, revealFrom, highlight, stations, children}) => {
  const armFrame = armSequencerFrame(frame, arm);
  // LoopSequencer reads one frame for its arm and for its cell reveal: the reveal is shifted by the same amount, so the
  // cells keep the scene's time.
  const reveal = revealFrom === undefined ? undefined : revealFrom + armFrame - frame;
  return (
    <AbsoluteFill style={{...worldTransform(camera), opacity}}>
      <LoopSequencer theme={THEME} frame={armFrame} stations={[null, null, null, null]} highlight={highlight} revealFrom={reveal} />
      {children}
      {stations.map((s, i) => {
        if (!s) return null;
        const e = s.opacity ?? 1;
        const r = STATION_RECTS[i];
        return (
          <div
            key={i}
            style={{
              position: 'absolute', left: r.x, top: r.y, opacity: e,
              transform: `translate(${ENTER_FROM[i].x * (1 - e)}px, ${ENTER_FROM[i].y * (1 - e)}px)`,
            }}
          >
            <StationCard {...s.props} />
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

/** A box that morphs between a station and a card in front of the world (spec § 3.5, transition 4). */
export const MorphBox: React.FC<{rect: Rect; radius: number; shadow: 'md' | 'lg'; children?: ReactNode; style?: CSSProperties}> = ({rect, radius, shadow, children, style}) => (
  <div
    style={{
      position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h, boxSizing: 'border-box', borderRadius: radius,
      background: pal.surface, border: `1px solid ${pal.line}`, boxShadow: SHADOW[THEME][shadow], overflow: 'hidden', ...style,
    }}
  >
    {children}
  </div>
);
