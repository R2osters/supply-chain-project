// src/scenes/S09Route.tsx — S09 · Les instruments : la route (spec § 4 S09), 74-84 s, light, COUPLET 2.
// The Ghana corridor from geo.ghana, pushed in (scale 1.7 → 1.76, never below 1: the crop has no overscan), under the
// signpost « ACCRA → KUMASI » (Condensed 128 px, the arrow drawn: Ruling R13), over a hairline graticule. A top-down
// container truck drives from Accra towards Kumasi at a constant speed. On every beat from bar 39 a position falls down
// a dotted thread and lands on the truck as an 8 px live dot (S09.fix.1-12), while the truck's beacon blinks. On
// « balise » the instrument card « BALISE GPS GT06 · DÈS 15 € » pops in with its chip « RÉSEAU LOCAL ACTIVÉ »; on
// « Positions » the CONTRÔLES card lists the four checks, which tick on every fix. The fix on S09.reject flies off to an
// islet « (0, 0) » at the foot of the dashed 0° meridian (Null Island really is due south, in the Gulf of Guinea) and
// gets the crit strike « REJETÉ »; the « pas de (0, 0) » check fails for that beat. On « sans signal » a hatched
// « ZONE SANS RÉSEAU » opens over the road short of Kumasi; from S09.deadzone the truck is gone, the fixes have stopped,
// and a hollow ink ring goes on along a dotted line « SIGNAL MUET → POSITION ESTIMÉE », dropping a hollow ghost
// position on every beat (the ghost ticks of the score). No driver's phone (spec § 8).
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import geo from '../../generated/geo.json';
import {Card} from '../components/Card';
import {Chip} from '../components/Chip';
import {Arrow, Check} from '../components/Glyphs';
import type {MapView} from '../components/WorldMap';
import {CONDENSED, LABEL, SANS} from '../components/typography';
import {FRAMES_PER_BEAT, quantize} from '../lib/beat';
import {EASE_EXIT, EASE_OUT} from '../lib/easing';
import {cueLocal, sceneDef, sceneFrames, seriesLocal, wordLocal} from '../lib/timeline';
import {palette, signal} from '../theme/tokens';
import {GHANA, project} from './crops';
import {toScreen, viewTransform, type Point} from './mapView';
import {clamp01, lerp, pop, ramp} from './refrain';

const ID = 'S09' as const;
const THEME = sceneDef(ID).theme;
const pal = palette(THEME);
const LIVE = signal(THEME, 'live');
const CRIT = signal(THEME, 'crit');
const FRAMES = sceneFrames(ID);

/** Voice-driven entry: on the nearest sixteenth, 2 frames early (spec § 3.5). */
const wordAt = (screen: string, n = 1): number => quantize(wordLocal(ID, screen, n).start, '16th') - 2;

// ── Timing ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const WIPE = cueLocal(ID, 'S09.wipe');
export const CARD_AT = cueLocal(ID, 'S09.card');
/** The twelve positions, one per beat from bar 39. */
export const FIXES = seriesLocal(ID, 'S09.fix');
export const REJECT = cueLocal(ID, 'S09.reject');
/** Index of the fix that lands on S09.reject: it goes to (0, 0) instead of the road. */
export const REJECTED = FIXES.indexOf(REJECT);
export const DEADZONE = cueLocal(ID, 'S09.deadzone');
/** The truck sets off one beat before the first fix. */
export const MOVE_FROM = FIXES[0] - FRAMES_PER_BEAT;
/** The ghost ticks of the dead zone (score: every beat from S09.deadzone to the end of the scene). */
export const GHOSTS: readonly number[] = Array.from({length: Math.ceil((FRAMES - DEADZONE) / FRAMES_PER_BEAT)}, (_, k) => DEADZONE + k * FRAMES_PER_BEAT);
export const CHECKS_AT = wordAt('Positions');
export const ZONE_AT = wordAt('sans');

// ── Camera: a push-in on the crop (Accra at about (1060, 850)), drifting slowly (tape logic). Both ends cover the
// frame, so every frame between does (the coverage bounds are linear in the view).
const VIEW_FROM: MapView = {x: -270.6, y: -103.1, scale: 1.7};
const VIEW_TO: MapView = {x: -262, y: -95, scale: 1.76};
export const viewAt = (f: number): MapView => {
  const t = clamp01(f / FRAMES);
  return {x: lerp(VIEW_FROM.x, VIEW_TO.x, t), y: lerp(VIEW_FROM.y, VIEW_TO.y, t), scale: lerp(VIEW_FROM.scale, VIEW_TO.scale, t)};
};

// ── The road (map coordinates of the Ghana crop) ─────────────────────────────────────────────────────────────────────
const CORRIDOR: Point[] = (geo.ghana.corridor as number[][]).map(([x, y]) => ({x, y}));
const SEG = CORRIDOR.slice(1).map((p, i) => Math.hypot(p.x - CORRIDOR[i].x, p.y - CORRIDOR[i].y));
const ROUTE_LEN = SEG.reduce((a, b) => a + b, 0);

/** The point at arc-length fraction `p` of the road from Accra (0) to Kumasi (1), with the direction of travel. */
export const routeAt = (p: number): Point & {angle: number} => {
  let d = clamp01(p) * ROUTE_LEN;
  for (let i = 0; i < SEG.length; i++) {
    if (d <= SEG[i] || i === SEG.length - 1) {
      const a = CORRIDOR[i];
      const b = CORRIDOR[i + 1];
      const t = Math.min(1, d / SEG[i]);
      return {x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), angle: Math.atan2(b.y - a.y, b.x - a.x)};
    }
    d -= SEG[i];
  }
  const last = CORRIDOR[CORRIDOR.length - 1];
  return {...last, angle: 0};
};

/** Map points of the road between fractions p0 and p1 (the vertices in between included). */
const roadBetween = (p0: number, p1: number): Point[] => {
  if (p1 <= p0) return [];
  const pts: Point[] = [routeAt(p0)];
  let acc = 0;
  for (let i = 0; i < SEG.length; i++) {
    acc += SEG[i];
    const q = acc / ROUTE_LEN;
    if (q > p0 && q < p1) pts.push(CORRIDOR[i + 1]);
  }
  pts.push(routeAt(p1));
  return pts;
};

/** Where the truck enters the dead zone, as a fraction of the road. */
export const P_ZONE = 0.6;
/** Constant speed: at Accra until MOVE_FROM, at the dead zone's edge exactly on S09.deadzone. */
export const truckProgress = (f: number): number => clamp01((P_ZONE * (f - MOVE_FROM)) / (DEADZONE - MOVE_FROM));

/** The dead zone: a circle over the road, short of Kumasi, whose edge the truck crosses on S09.deadzone (map pixels). */
const ZONE_P = 0.76;
const ZONE_CENTER = routeAt(ZONE_P);
/** Where the road leaves the zone again (the road is all but straight, so the circle cuts it symmetrically). */
const P_FAR = 2 * ZONE_P - P_ZONE;
export const ZONE = {x: ZONE_CENTER.x, y: ZONE_CENTER.y, r: Math.hypot(routeAt(P_ZONE).x - ZONE_CENTER.x, routeAt(P_ZONE).y - ZONE_CENTER.y)};

/** The 0° meridian on the crop: it runs down past Accra towards (0°, 0°), far south in the Gulf of Guinea. */
const MERIDIAN_0 = project(GHANA, [0, 6]).x;
/** Null Island, stylised: on the 0° meridian, in the sea off Accra (map pixels). */
export const ISLET: Point = {x: MERIDIAN_0, y: 817};

/** The graticule shown under the signpost: meridians 2° W to 0°, the 6th parallel (map pixels). */
const MERIDIANS = [-2, -1, 0].map((lon) => ({lon, x: project(GHANA, [lon, 6]).x}));
const PARALLELS = [6].map((lat) => ({lat, y: project(GHANA, [0, lat]).y}));
const GRATICULE_TOP = 282;

// ── Fixes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const DROP_FRAMES = 6;
/** Height of the dotted thread a position falls down, in screen px. */
const DROP_HEIGHT = 120;
export const REJECT_FLIGHT = 12;

export const fixLanding = (k: number): Point => {
  const {x, y} = routeAt(truckProgress(FIXES[k]));
  return {x, y};
};

export type FixState = 'falling' | 'landed' | 'flying' | 'rejected';
export interface FixDot extends Point { state: FixState; top: Point; t: number }

const bezier = (a: Point, c: Point, b: Point, t: number): Point => ({
  x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x,
  y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y,
});

/** The k-th position at frame f (map coordinates), or null before it sets off. */
export const fixDot = (f: number, k: number): FixDot | null => {
  const c = FIXES[k];
  const land = fixLanding(k);
  const top = {x: land.x, y: land.y - DROP_HEIGHT / viewAt(c).scale};
  if (k === REJECTED) {
    if (f < c - REJECT_FLIGHT) return null;
    if (f >= c) return {...ISLET, state: 'rejected', top, t: 1};
    const t = EASE_OUT((f - (c - REJECT_FLIGHT)) / REJECT_FLIGHT);
    return {...bezier(top, land, ISLET, t), state: 'flying', top, t};
  }
  if (f < c - DROP_FRAMES) return null;
  if (f >= c) return {...land, state: 'landed', top, t: 1};
  const t = EASE_OUT((f - (c - DROP_FRAMES)) / DROP_FRAMES);
  return {x: land.x, y: lerp(top.y, land.y, t), state: 'falling', top, t};
};

/** The live dots on the road at frame f: every accepted fix that has landed. */
export const liveDots = (f: number): Point[] => FIXES.flatMap((c, k) => (k !== REJECTED && c <= f ? [fixLanding(k)] : []));

// ── Checks ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const CHECK_ROWS = ['coordonnées valides', 'pas de (0, 0)', 'pas dans le futur', 'vitesse < 250 km/h'] as const;
export const FAILING_ROW = CHECK_ROWS.indexOf('pas de (0, 0)');
export const rowState = (f: number, row: number): 'pass' | 'fail' =>
  row === FAILING_ROW && f >= REJECT && f < REJECT + FRAMES_PER_BEAT ? 'fail' : 'pass';

/** The last fix at or before f (for the checks' tick and the beacon), or null. */
const lastFix = (f: number): number | null => {
  let last: number | null = null;
  for (const c of FIXES) if (c <= f) last = c;
  return last;
};

// ── Drawings ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const svgPoints = (pts: Point[]): string => pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

/** A container truck seen from above, facing +x, centred on its container; `beacon` lights the GPS box on the roof. */
const Truck: React.FC<{at: Point; angle: number; opacity: number; scale: number; beacon: boolean}> = ({at, angle, opacity, scale, beacon}) => (
  <g transform={`translate(${at.x} ${at.y}) rotate(${(angle * 180) / Math.PI}) scale(${scale})`} opacity={opacity}>
    <rect x={-30} y={-11} width={40} height={22} rx={2} fill={pal.surface2} stroke={pal.ink} strokeWidth={2.5} />
    {[-21, -12, -3].map((x) => (
      <line key={x} x1={x} x2={x} y1={-11} y2={11} stroke={pal.ink} strokeWidth={1.25} />
    ))}
    <rect x={13} y={-9.5} width={14} height={19} rx={3} fill={pal.ink} />
    <rect x={24} y={-7} width={2.5} height={14} rx={1} fill={pal.surface2} opacity={0.5} />
    <circle cx={0} cy={0} r={4} fill={beacon ? LIVE : pal.surface2} stroke={pal.ink} strokeWidth={1.5} />
  </g>
);

/** The GT06: a small black box with its GPS patch, two LEDs and its cable; the fix LED blinks live on each fix. */
const Tracker: React.FC<{led: boolean}> = ({led}) => (
  <svg width={124} height={92} viewBox="0 0 124 92" style={{display: 'block', overflow: 'visible'}}>
    <path d="M96 62 C112 64 112 82 122 86" fill="none" stroke={pal.ink} strokeWidth={2.5} strokeLinecap="round" />
    <rect x={8} y={22} width={88} height={58} rx={10} fill={pal.surface2} stroke={pal.ink} strokeWidth={2.5} />
    <rect x={20} y={34} width={26} height={26} rx={3} fill="none" stroke={pal.ink} strokeWidth={1.75} />
    <line x1={26} x2={40} y1={47} y2={47} stroke={pal.ink} strokeWidth={1.25} />
    <line x1={33} x2={33} y1={40} y2={54} stroke={pal.ink} strokeWidth={1.25} />
    <circle cx={62} cy={40} r={5} fill={led ? LIVE : 'none'} stroke={pal.ink} strokeWidth={1.75} />
    <circle cx={80} cy={40} r={5} fill={pal.ink} />
    <line x1={56} x2={86} y1={58} y2={58} stroke={pal.dim} strokeWidth={2} strokeLinecap="round" />
    <line x1={56} x2={78} y1={66} y2={66} stroke={pal.dim} strokeWidth={2} strokeLinecap="round" />
    {[9, 16].map((r) => (
      <path key={r} d={`M${88 - r * 0.7} ${14 - r * 0.7 + 8} A${r} ${r} 0 0 1 ${88 + r * 0.7} ${14 - r * 0.7 + 8}`} fill="none" stroke={pal.ink} strokeWidth={2} strokeLinecap="round" />
    ))}
  </svg>
);

/** A small island that is not there: dashed outline (Null Island is fictional). */
const ISLET_PATH = 'M-26 2C-24 -8 -12 -13 -2 -11C8 -14 20 -10 25 -3C29 4 20 11 8 10C-2 13 -14 12 -21 8C-25 6 -27 5 -26 2Z';

const TITLE_SIZE = 128;
const titleStyle: React.CSSProperties = {
  fontFamily: CONDENSED, fontWeight: 600, fontSize: TITLE_SIZE, lineHeight: 1, letterSpacing: '-0.02em', color: pal.ink,
  whiteSpace: 'nowrap', display: 'inline-block',
};

// Right column (12-column grid: columns 9-12), and the two cards in it.
const COL_X = 1264;
const COL_W = 560;
const CARD_Y = 150;
const CARD_H = 212;
const CHECKS_Y = 400;
const ROW_Y0 = 86;
const ROW_STEP = 52;
const CHECKS_H = ROW_Y0 + ROW_STEP * CHECK_ROWS.length - 6;

// ── The scene ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const S09Route: React.FC = () => {
  const f = useCurrentFrame();
  const v = viewAt(f);
  const S = (p: Point): Point => toScreen(p, v);

  // Road: traced from Accra to Kumasi at constant speed while the wipe reveals the scene.
  const draw = interpolate(f, [WIPE, WIPE + 30], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const zoneIn = ramp(f, ZONE_AT, 12);
  const accra = S(routeAt(0));
  const kumasi = S(routeAt(1));
  const kumasiIn = ramp(f, WIPE + 28, 8);

  // Truck
  const p = truckProgress(f);
  const truck = routeAt(p);
  const truckOn = ramp(f, MOVE_FROM - 8, 8) * (1 - ramp(f, DEADZONE, 8, EASE_EXIT));
  const fixNow = lastFix(f);
  const beacon = fixNow !== null && f < fixNow + 8;

  // Dead zone and the estimate
  const zc = S(ZONE);
  const zr = ZONE.r * v.scale;
  const dead = f >= DEADZONE;
  const ringIn = ramp(f, DEADZONE, 8);
  const lastGhost = GHOSTS.filter((g) => g <= f).pop();
  const ringPop = lastGhost === undefined ? 1 : pop(f, lastGhost, 1.3);
  const uncertainty = 14 + 30 * clamp01((f - DEADZONE) / 60);
  const estimateTo = Math.min(1, p + 0.1);

  // Cards
  const cardIn = ramp(f, CARD_AT, 10);
  const checksIn = ramp(f, CHECKS_AT, 10);
  const tick = fixNow !== null && fixNow >= CHECKS_AT ? pop(f, fixNow, 1.25) : 1;

  // Title parts rise one after the other as the wipe reveals them.
  const titleIn = [3, 6, 9].map((d) => ramp(f, WIPE + d, 10));

  // Reject
  const rej = fixDot(f, REJECTED);
  const isletIn = ramp(f, REJECT - REJECT_FLIGHT - 6, 8);
  const isletAt = S(ISLET);
  const strike = interpolate(f, [REJECT, REJECT + 5], [0, 1], {easing: EASE_OUT, extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const rejectDim = 1 - 0.4 * ramp(f, REJECT + 2 * FRAMES_PER_BEAT, 10);

  // Estimate label
  const labelIn = ramp(f, DEADZONE + 4, 10);
  const label = {x: zc.x + zr + 44, y: zc.y - zr * 0.95};

  return (
    <AbsoluteFill style={{background: pal.surface}}>
      {/* ── Map ── */}
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
        <defs>
          <pattern id="s09-hatch" width={12} height={12} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1={0} y1={0} x2={0} y2={12} stroke={pal.muted} strokeWidth={2} />
          </pattern>
          <clipPath id="s09-zone">
            <circle cx={zc.x} cy={zc.y} r={zr} />
          </clipPath>
        </defs>
        <g transform={viewTransform(v)}>
          <path d={geo.ghana.land} fill={pal.map} stroke={pal.line} strokeWidth={1} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </g>

        {/* Graticule, under the signpost: hairlines, and the 0° meridian dashed down to the islet */}
        <g opacity={ramp(f, WIPE + 6, 12)}>
          {MERIDIANS.map(({lon, x}) => {
            const sx = S({x, y: 0}).x;
            const zero = lon === 0;
            const bottom = zero ? isletAt.y - 26 : 1080;
            return (
              <line
                key={lon} x1={sx} x2={sx} y1={GRATICULE_TOP} y2={bottom} stroke={zero ? pal.muted : pal.dim}
                strokeWidth={zero ? 1.5 : 1} strokeDasharray={zero ? '2 7' : undefined} strokeLinecap="round" opacity={zero ? 0.9 : 0.3}
              />
            );
          })}
          {PARALLELS.map(({lat, y}) => {
            const sy = S({x: 0, y}).y;
            return <line key={lat} x1={0} x2={1920} y1={sy} y2={sy} stroke={pal.dim} strokeWidth={1} opacity={0.3} />;
          })}
        </g>

        {/* Dead zone: hatch, dashed edge */}
        {zoneIn > 0 && (
          <g opacity={zoneIn}>
            <rect x={zc.x - zr} y={zc.y - zr} width={2 * zr} height={2 * zr} fill="url(#s09-hatch)" clipPath="url(#s09-zone)" opacity={0.3} />
            <circle
              cx={zc.x} cy={zc.y} r={zr} fill="none" stroke={pal.muted} strokeWidth={1.5} strokeDasharray="6 6"
              pathLength={1000} strokeDashoffset={1000 * (1 - zoneIn)}
            />
          </g>
        )}

        {/* The road: 3 px ink, faint where it crosses the dead zone once the zone is known */}
        {[[0, P_ZONE], [P_FAR, 1]].map(([a, b]) =>
          draw > a ? (
            <polyline key={a} points={svgPoints(roadBetween(a, Math.min(draw, b)).map(S))} fill="none" stroke={pal.ink} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
          ) : null,
        )}
        {draw > P_ZONE && (
          <>
            <polyline points={svgPoints(roadBetween(P_ZONE, Math.min(draw, P_FAR)).map(S))} fill="none" stroke={pal.ink} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" opacity={1 - zoneIn} />
            <polyline points={svgPoints(roadBetween(P_ZONE, Math.min(draw, P_FAR)).map(S))} fill="none" stroke={pal.dim} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={0.6 * zoneIn} />
          </>
        )}
        {/* Cities */}
        <circle cx={accra.x} cy={accra.y} r={7} fill={pal.ink} stroke={pal.surface} strokeWidth={3} opacity={ramp(f, WIPE, 8)} />
        <circle cx={kumasi.x} cy={kumasi.y} r={7} fill={pal.ink} stroke={pal.surface} strokeWidth={3} opacity={kumasiIn} />

        {/* The estimate: dotted line ahead of the ring, ghost positions on the ghost ticks */}
        {dead && (
          <polyline
            points={svgPoints(roadBetween(P_ZONE, estimateTo).map(S))} fill="none" stroke={pal.ink} strokeWidth={4.5}
            strokeLinecap="round" strokeDasharray="0 12" opacity={ringIn}
          />
        )}
        {GHOSTS.filter((g) => g <= f).map((g) => {
          const at = S(routeAt(truckProgress(g)));
          return <circle key={g} cx={at.x} cy={at.y} r={7 * pop(f, g, 1.4)} fill={pal.surface} stroke={pal.ink} strokeWidth={2} strokeDasharray="3.5 2.5" />;
        })}

        {/* The truck, then the hollow ring that replaces it */}
        {truckOn > 0 && <Truck at={S(truck)} angle={truck.angle} opacity={truckOn} scale={(1.25 * v.scale) / VIEW_FROM.scale} beacon={beacon} />}
        {dead && (() => {
          const at = S(truck);
          const ring = 14 * ringPop * (0.6 + 0.4 * ringIn);
          // The leader runs from the label's left end to the ring's upper-right edge.
          const dx = label.x - 10 - at.x;
          const dy = label.y + 12 - at.y;
          const d = Math.hypot(dx, dy);
          return (
            <g opacity={ringIn}>
              <circle cx={at.x} cy={at.y} r={uncertainty} fill="none" stroke={pal.muted} strokeWidth={1.5} strokeDasharray="4 5" />
              <circle cx={at.x} cy={at.y} r={ring} fill="none" stroke={pal.ink} strokeWidth={3} />
              <line x1={label.x - 10} y1={label.y + 12} x2={at.x + (dx / d) * (ring + 6)} y2={at.y + (dy / d) * (ring + 6)} stroke={pal.ink} strokeWidth={1.5} opacity={labelIn} />
            </g>
          );
        })()}

        {/* Live dots already on the road */}
        {FIXES.map((c, k) => {
          if (k === REJECTED || f < c) return null;
          const at = S(fixLanding(k));
          const age = f - c;
          const wave = clamp01(age / 10);
          return (
            <g key={c}>
              {age < 10 && <circle cx={at.x} cy={at.y} r={4 + 14 * EASE_OUT(wave)} fill="none" stroke={LIVE} strokeWidth={2} opacity={1 - wave} />}
              <circle cx={at.x} cy={at.y} r={4 * pop(f, c)} fill={LIVE} />
            </g>
          );
        })}

        {/* Falling positions and their threads */}
        {FIXES.map((c, k) => {
          const d = fixDot(f, k);
          if (!d || k === REJECTED) return null;
          const top = S(d.top);
          const dot = S(d);
          const threadOpacity = d.state === 'falling' ? 0.55 : 0.55 * (1 - clamp01((f - c) / 6));
          if (threadOpacity <= 0) return null;
          return (
            <g key={`t${c}`}>
              <line x1={top.x} y1={top.y} x2={dot.x} y2={dot.y} stroke={pal.ink} strokeWidth={2.5} strokeLinecap="round" strokeDasharray="0 7" opacity={threadOpacity} />
              {d.state === 'falling' && <circle cx={dot.x} cy={dot.y} r={4} fill={pal.ink} />}
            </g>
          );
        })}

        {/* The islet « (0, 0) » and the rejected position */}
        {isletIn > 0 && (
          <g transform={`translate(${isletAt.x} ${isletAt.y}) scale(${0.8 + 0.2 * isletIn})`} opacity={isletIn}>
            <path d={ISLET_PATH} fill={pal.map} stroke={pal.muted} strokeWidth={1.5} strokeDasharray="4 3" />
          </g>
        )}
        {rej && rej.state === 'flying' && (() => {
          const land = fixLanding(REJECTED);
          const steps = 16;
          const trail = Array.from({length: steps + 1}, (_, i) => S(bezier(rej.top, land, ISLET, (rej.t * i) / steps)));
          const dot = S(rej);
          return (
            <g>
              <polyline points={svgPoints(trail)} fill="none" stroke={pal.ink} strokeWidth={2.5} strokeLinecap="round" strokeDasharray="0 7" opacity={0.55} />
              <circle cx={dot.x} cy={dot.y} r={4} fill={pal.ink} />
            </g>
          );
        })()}
        {rej && rej.state === 'rejected' && (
          <g opacity={rejectDim}>
            <circle cx={isletAt.x} cy={isletAt.y} r={5 * pop(f, REJECT, 1.4)} fill={pal.surface2} stroke={CRIT} strokeWidth={2.5} />
          </g>
        )}
      </svg>

      {/* ── Map labels ── */}
      <div style={{...LABEL, position: 'absolute', right: 1920 - accra.x + 16, top: accra.y + 12, color: pal.muted, opacity: ramp(f, WIPE + 4, 8)}}>ACCRA</div>
      <div style={{position: 'absolute', inset: 0, opacity: ramp(f, WIPE + 10, 12)}}>
        {MERIDIANS.map(({lon, x}) => (
          <div key={lon} style={{...LABEL, position: 'absolute', left: S({x, y: 0}).x + 10, top: GRATICULE_TOP + 4, color: lon === 0 ? pal.muted : pal.dim}}>
            {lon === 0 ? '0°' : `${-lon}°O`}
          </div>
        ))}
        {PARALLELS.map(({lat, y}) => (
          <div key={lat} style={{...LABEL, position: 'absolute', left: 96, top: S({x: 0, y}).y - 34, color: pal.dim}}>{`${lat}°N`}</div>
        ))}
      </div>
      <div style={{...LABEL, position: 'absolute', right: 1920 - kumasi.x + 18, top: kumasi.y - 30, color: pal.muted, opacity: kumasiIn}}>KUMASI</div>
      {zoneIn > 0 && (
        <div style={{...LABEL, position: 'absolute', left: zc.x, top: zc.y + zr + 18, transform: 'translateX(-50%)', color: pal.muted, opacity: ramp(f, ZONE_AT + 4, 10)}}>
          ZONE SANS RÉSEAU
        </div>
      )}
      {labelIn > 0 && (
        <div
          style={{
            ...LABEL, position: 'absolute', left: label.x, top: label.y, display: 'flex', alignItems: 'baseline', gap: 10, color: pal.ink,
            opacity: labelIn, transform: `translateY(${10 * (1 - labelIn)}px)`,
          }}
        >
          <span>SIGNAL MUET</span>
          <Arrow size={24} color={pal.ink} />
          <span>POSITION ESTIMÉE</span>
        </div>
      )}
      {isletIn > 0 && (
        <div style={{...LABEL, position: 'absolute', left: isletAt.x + 40, top: isletAt.y - 12, color: pal.muted, opacity: isletIn, display: 'flex', alignItems: 'center', gap: 16}}>
          <span style={{position: 'relative'}}>
            (0, 0)
            {strike > 0 && (
              <span style={{position: 'absolute', left: -4, top: 11, height: 3, width: `calc(${strike * 100}% + 8px)`, background: CRIT, opacity: rejectDim, borderRadius: 2}} />
            )}
          </span>
          {rej && rej.state === 'rejected' && (
            <span
              style={{
                ...LABEL, color: CRIT, border: `1.5px solid ${CRIT}`, borderRadius: 4, height: 36, padding: '0 10px', display: 'inline-flex',
                alignItems: 'center', boxSizing: 'border-box', background: pal.surface2, opacity: rejectDim,
                transform: `scale(${pop(f, REJECT, 1.2)})`,
              }}
            >
              REJETÉ
            </span>
          )}
        </div>
      )}

      {/* ── Signpost ── */}
      <div style={{position: 'absolute', left: 96, top: 100, display: 'flex', alignItems: 'baseline', gap: 28}}>
        <span style={{...titleStyle, opacity: titleIn[0], transform: `translateY(${40 * (1 - titleIn[0])}px)`}}>ACCRA</span>
        <span style={{display: 'inline-block', opacity: titleIn[1], transform: `translateY(${40 * (1 - titleIn[1])}px)`}}>
          <Arrow size={TITLE_SIZE} color={pal.ink} />
        </span>
        <span style={{...titleStyle, opacity: titleIn[2], transform: `translateY(${40 * (1 - titleIn[2])}px)`}}>KUMASI</span>
      </div>

      {/* ── Instrument card ── */}
      {cardIn > 0 && (
        <Card
          theme={THEME} width={COL_W} height={CARD_H} shadow="md"
          style={{position: 'absolute', left: COL_X, top: CARD_Y, opacity: cardIn, transform: `translateY(${16 * (1 - cardIn)}px) scale(${0.96 + 0.04 * cardIn})`}}
        >
          <div style={{...LABEL, fontSize: 28, letterSpacing: '0.04em', position: 'absolute', left: 28, top: 28, color: pal.ink}}>BALISE GPS GT06 · DÈS 15 €</div>
          <div style={{position: 'absolute', left: 28, right: 28, top: 76, height: 1, background: pal.line}} />
          <div style={{position: 'absolute', left: 22, top: 98}}>
            <Tracker led={beacon && fixNow !== null && fixNow >= CARD_AT} />
          </div>
          <Chip theme={THEME} style={{position: 'absolute', right: 28, top: 130}}>RÉSEAU LOCAL ACTIVÉ</Chip>
        </Card>
      )}

      {/* ── CONTRÔLES ── */}
      {checksIn > 0 && (
        <Card
          theme={THEME} width={COL_W} height={CHECKS_H} shadow="md"
          style={{position: 'absolute', left: COL_X, top: CHECKS_Y, opacity: checksIn, transform: `translateY(${16 * (1 - checksIn)}px)`}}
        >
          <div style={{...LABEL, position: 'absolute', left: 28, top: 28, color: pal.muted}}>CONTRÔLES</div>
          <div style={{position: 'absolute', left: 28, right: 28, top: 66, height: 1, background: pal.line}} />
          {CHECK_ROWS.map((row, r) => {
            const state = rowState(f, r);
            const rowIn = ramp(f, CHECKS_AT + 2 * r, 8);
            const fail = state === 'fail';
            return (
              <div
                key={row}
                style={{
                  position: 'absolute', left: 28, top: ROW_Y0 + r * ROW_STEP, display: 'flex', alignItems: 'center', gap: 20,
                  opacity: rowIn, transform: `translateY(${10 * (1 - rowIn)}px)`,
                }}
              >
                <div
                  style={{
                    width: 32, height: 32, boxSizing: 'border-box', borderRadius: 4, border: `2px solid ${fail ? CRIT : pal.ink}`,
                    background: pal.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${fail ? pop(f, REJECT, 1.3) : tick})`,
                  }}
                >
                  {fail ? (
                    <svg width={18} height={18} viewBox="0 0 18 18">
                      <path d="M3 3 15 15M15 3 3 15" stroke={CRIT} strokeWidth={3} strokeLinecap="round" />
                    </svg>
                  ) : (
                    <Check size={22} color={pal.ink} strokeWidth={2.75} style={{marginTop: -4}} />
                  )}
                </div>
                <span style={{fontFamily: SANS, fontWeight: 500, fontSize: 30, lineHeight: 1, color: pal.ink, whiteSpace: 'nowrap'}}>{row}</span>
              </div>
            );
          })}
        </Card>
      )}
    </AbsoluteFill>
  );
};
