// src/scenes/S10MerAir.tsx — S10 · La mer et l'air (spec § 4 S10), 84-94 s, light, COUPLET 2.
// Sea: the Baltic crop of geo.json opens on a pull-back (scale 1.8 → 1.36 over 20 frames with the whoosh, then a slow
// drift; never below 1, the crop has no overscan). Twelve ship chevrons sail the three ferry lanes (Helsinki-Tallinn,
// Stockholm-Turku, Gdańsk-Karlskrona) under the React Bits Radar drawn in ink at 12 %. On each of the ten quarter notes
// of S10.ping three ships send an AIS ping: three info rings, the sonar's three echoes, gone within the beat. On
// « Baltique » the chip « NAVIRES · AIS · MER BALTIQUE · DIGITRAFFIC · SANS CLÉ » pops; one beat later the paler one
// « MONDE ENTIER (CÔTES) : AISSTREAM · CLÉ GRATUITE » joins it and stays across the cut until the planes' chip.
// Air: on the beat of « Et les avions » a hard cut to the world map (Equal Earth, geo.world), which pulls back from the
// Baltic (scale 4) to the North Atlantic world (scale 1.4: the Americas, Europe, Africa) in 18 frames; the view frame (an
// ink window with corners, a lens: inside it the map is drawn with more contrast, as the loaded view) marks the Baltic
// view we just left, its twelve ships as dots fading out, then opens over Europe and ratchets west, one move per beat,
// across the Atlantic to North America. Planes (8 px chevrons with
// short trails, on a canvas redrawn every frame) exist everywhere but are drawn only inside the frame: they are loaded
// for the view on screen, in four bursts on the chirps of S10.planes. Chip « AVIONS · OPENSKY / ADSB.LOL · SANS CLÉ ».
import {useLayoutEffect, useRef} from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import geo from '../../generated/geo.json';
import {Chip} from '../components/Chip';
import {WorldMap, type MapView} from '../components/WorldMap';
import {FRAMES_PER_BEAT, quantize} from '../lib/beat';
import {EASE_OUT} from '../lib/easing';
import {rand} from '../lib/prng';
import {cueLocal, sceneDef, seriesLocal, wordLocal} from '../lib/timeline';
import {Radar} from '../rb/Radar';
import {palette, signal} from '../theme/tokens';
import {BALTIC, WORLD, project, unproject} from './crops';
import {coveringView, fromScreen, toScreen, viewTransform, type Point} from './mapView';
import {clamp01, lerp, pop, ramp} from './refrain';

const ID = 'S10' as const;
const THEME = sceneDef(ID).theme;
const pal = palette(THEME);
const INFO = signal(THEME, 'info');
const CENTER: Point = {x: 960, y: 540};

/** Voice-driven entry: on the nearest sixteenth, 2 frames early (spec § 3.5). */
const wordAt = (screen: string, n = 1): number => quantize(wordLocal(ID, screen, n).start, '16th') - 2;

// ── Timing ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ZOOM = cueLocal(ID, 'S10.zoom');
export const PINGS = seriesLocal(ID, 'S10.ping');
export const BALTIC_AT = cueLocal(ID, 'S10.baltic');
/** The cut to the world: the beat nearest « Et » (« Et les avions »). */
export const CUT = quantize(wordLocal(ID, 'Et').start, 'beat');
export const PLANE_CUES = seriesLocal(ID, 'S10.planes');
export const AVIONS_AT = wordAt('avions');
/**
 * The paler chip « MONDE ENTIER (CÔTES) : AISSTREAM · CLÉ GRATUITE »: one beat after the Baltic chip (on « direct »),
 * so it is read for about two seconds. It stays where it is across the cut to the world (the « monde entier » it names)
 * and hands over to the planes' chip: it fades out as « AVIONS · … » comes in.
 */
export const WORLD_CHIP_AT = BALTIC_AT + FRAMES_PER_BEAT;
export const WORLD_CHIP_OUT = AVIONS_AT;
const CHIP_FADE = 8;

// ── Sea: camera on the Baltic crop ────────────────────────────────────────────────────────────────────────────────────
const RECUL_FRAMES = 20;
const SCALE_FROM = 1.8;
const SCALE_REST = 1.36;
const SCALE_END = 1.42;
const LANES = geo.baltic.lanes.map((l) => ({from: {x: l.from[0], y: l.from[1]}, to: {x: l.to[0], y: l.to[1]}}));
const lanePoints = LANES.flatMap((l) => [l.from, l.to]);
/** Centre of the three lanes' bounding box (crop pixels): the camera keeps it near TARGET. */
const ANCHOR: Point = {
  x: (Math.min(...lanePoints.map((p) => p.x)) + Math.max(...lanePoints.map((p) => p.x))) / 2,
  y: (Math.min(...lanePoints.map((p) => p.y)) + Math.max(...lanePoints.map((p) => p.y))) / 2,
};
const TARGET: Point = {x: 1000, y: 630};

/** The Baltic camera: a pull-back on the whoosh, then a slow linear drift; always covering the frame. */
export const balticView = (f: number): MapView => {
  const s = f < ZOOM + RECUL_FRAMES
    ? lerp(SCALE_FROM, SCALE_REST, EASE_OUT(clamp01((f - ZOOM) / RECUL_FRAMES)))
    : lerp(SCALE_REST, SCALE_END, clamp01((f - ZOOM - RECUL_FRAMES) / (CUT - ZOOM - RECUL_FRAMES)));
  return coveringView(ANCHOR, TARGET, s);
};

// ── Ships ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface Ship { lane: number; t0: number; dir: 1 | -1; offset: number }
/** Two-way traffic: ships heading to the lane's end keep to one side, the others to the other (crop pixels). */
export const SHIPS: readonly Ship[] = [
  {lane: 0, t0: 0.18, dir: 1, offset: -5}, {lane: 0, t0: 0.84, dir: -1, offset: 5},
  {lane: 1, t0: 0.06, dir: 1, offset: -6}, {lane: 1, t0: 0.34, dir: -1, offset: 6}, {lane: 1, t0: 0.5, dir: 1, offset: -6},
  {lane: 1, t0: 0.72, dir: -1, offset: 6}, {lane: 1, t0: 0.96, dir: -1, offset: 6},
  {lane: 2, t0: 0.05, dir: 1, offset: -6}, {lane: 2, t0: 0.3, dir: -1, offset: 6}, {lane: 2, t0: 0.49, dir: 1, offset: -6},
  {lane: 2, t0: 0.67, dir: -1, offset: 6}, {lane: 2, t0: 0.92, dir: -1, offset: 6},
];
/** Crop pixels per frame. */
const SHIP_SPEED = 0.16;

export const shipAt = (i: number, f: number): Point & {angle: number; opacity: number} => {
  const s = SHIPS[i];
  const {from, to} = LANES[s.lane];
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const t = s.t0 + (s.dir * SHIP_SPEED * f) / len;
  const u = ((t % 1) + 1) % 1;
  const ux = (to.x - from.x) / len;
  const uy = (to.y - from.y) / len;
  const edge = Math.min(u, 1 - u);
  return {
    x: lerp(from.x, to.x, u) - uy * s.offset,
    y: lerp(from.y, to.y, u) + ux * s.offset,
    angle: Math.atan2(s.dir * uy, s.dir * ux),
    opacity: clamp01(edge / 0.04),
  };
};

// ── AIS pings: three ships per quarter note, three echoes each, all within the beat ─────────────────────────────────
export const ECHOES = 3;
export const ECHO_GAP = 3;
export const RING_FRAMES = 9;
/** The ships that ping on the k-th quarter note: one in each third of the fleet, every ship at least once. */
export const pingEmitters = (k: number): number[] => [0, 4, 8].map((o) => (5 * k + o) % SHIPS.length);

export interface PingRing { ship: number; ping: number; echo: number; age: number }
export const pingRings = (f: number): PingRing[] => {
  const out: PingRing[] = [];
  PINGS.forEach((p, k) => {
    if (f < p || f >= p + FRAMES_PER_BEAT) return;
    for (const ship of pingEmitters(k)) {
      for (let echo = 0; echo < ECHOES; echo++) {
        const age = f - p - echo * ECHO_GAP;
        if (age >= 0 && age < RING_FRAMES) out.push({ship, ping: k, echo, age});
      }
    }
  });
  return out;
};

// ── Air: world camera and the view frame ──────────────────────────────────────────────────────────────────────────────
export const WORLD_RECUL_FRAMES = 18;
const WORLD_SCALE_FROM = 4;
/** Where the pull-back rests: the North Atlantic world (Europe to North America, down to the tropics) at scale 1.4. */
export const WORLD_REST = {scale: 1.4, focus: {x: 787, y: 372} as Point};

/** The world point under the centre of the Baltic view at the cut (the continuity point of the pull-back). */
export const BALTIC_CENTER_WORLD: Point = project(WORLD, unproject(BALTIC, fromScreen(CENTER, balticView(CUT))));

/** The view that puts world point `focus` at the screen centre at `scale`. */
const centredOn = (focus: Point, scale: number): MapView => ({x: -(focus.x - CENTER.x) * scale, y: -(focus.y - CENTER.y) * scale, scale});

/** The world camera: the Baltic at the centre at scale 4, pulled back (18 frames, ease-out, log scale) to WORLD_REST. */
export const worldView = (f: number): MapView => {
  const e = EASE_OUT(clamp01((f - CUT) / WORLD_RECUL_FRAMES));
  const s = Math.exp(lerp(Math.log(WORLD_SCALE_FROM), Math.log(WORLD_REST.scale), e));
  return centredOn({x: lerp(BALTIC_CENTER_WORLD.x, WORLD_REST.focus.x, e), y: lerp(BALTIC_CENTER_WORLD.y, WORLD_REST.focus.y, e)}, s);
};

export interface Rect { x: number; y: number; w: number; h: number }
const rectAround = (c: Point, w: number, h: number): Rect => ({x: c.x - w / 2, y: c.y - h / 2, w, h});

/** Footprint on the world of what the Baltic view showed at the cut: the bounding box of its corners (world px). */
const BALTIC_FOOTPRINT: Rect = (() => {
  const v = balticView(CUT);
  const pts = [[0, 0], [1920, 0], [1920, 1080], [0, 1080], [960, 0], [960, 1080]].map(([x, y]) =>
    project(WORLD, unproject(BALTIC, fromScreen({x, y}, v))),
  );
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys)};
})();

const FRAME_W = 360;
const FRAME_H = 216;
/** Where the frame goes: it opens over Europe, then ratchets west on the beats (world px centres). */
const STOPS: readonly Point[] = [[8, 49], [-24, 47], [-58, 42], [-88, 39]].map(([lon, lat]) => project(WORLD, [lon, lat]));
const OPEN_AT = CUT + WORLD_RECUL_FRAMES;
const OPEN_FRAMES = 12;
const MOVES = [2, 3, 4].map((b) => PLANE_CUES[0] + b * FRAMES_PER_BEAT);
const MOVE_FRAMES = 8;

const lerpRect = (a: Rect, b: Rect, p: number): Rect => ({x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), w: lerp(a.w, b.w, p), h: lerp(a.h, b.h, p)});

/** The view frame in world pixels. */
export const viewFrame = (f: number): Rect => {
  const open = ramp(f, OPEN_AT, OPEN_FRAMES);
  let rect = lerpRect(BALTIC_FOOTPRINT, rectAround(STOPS[0], FRAME_W, FRAME_H), open);
  MOVES.forEach((m, i) => {
    const p = ramp(f, m, MOVE_FRAMES);
    if (p > 0) rect = lerpRect(rect, rectAround(STOPS[i + 1], FRAME_W, FRAME_H), p);
  });
  return rect;
};

/** The twelve ships where the cut left them, on the world (world px): they fade out while the camera pulls back. */
const SHIPS_AT_CUT: readonly Point[] = SHIPS.map((_, i) => project(WORLD, unproject(BALTIC, shipAt(i, CUT))));
const SHIPS_FADE = 12;

// ── Planes ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const PLANE_SEED = 1010;
const PLANE_COUNT = 420;
/** Where the traffic is ([lon], [lat], weight) and its main headings (radians, screen axes; each plane takes one, with
 * a little spread): Europe, the North Atlantic tracks, North America, East Asia, the Gulf and India, and a scatter
 * elsewhere (any heading). */
const REGIONS: ReadonlyArray<{lon: [number, number]; lat: [number, number]; w: number; dirs?: number[]}> = [
  {lon: [-11, 32], lat: [36, 61], w: 0.24, dirs: [-0.35, Math.PI - 0.35, 1.25, 1.25 - Math.PI]},
  {lon: [-52, -14], lat: [44, 58], w: 0.12, dirs: [0.05, Math.PI + 0.05]},
  {lon: [-122, -72], lat: [27, 49], w: 0.24, dirs: [0.08, Math.PI + 0.08, 0.95, 0.95 - Math.PI]},
  {lon: [100, 142], lat: [20, 42], w: 0.12, dirs: [0.2, Math.PI + 0.2, 1.4, 1.4 - Math.PI]},
  {lon: [35, 80], lat: [10, 38], w: 0.1, dirs: [-0.5, Math.PI - 0.5]},
  {lon: [-170, 175], lat: [-45, 65], w: 0.18},
];

interface Plane { base: Point; vx: number; vy: number; burst: number }
const PLANES: readonly Plane[] = Array.from({length: PLANE_COUNT}, (_, i) => {
  let r = rand(PLANE_SEED, i, 0);
  const region = REGIONS.find((g) => (r -= g.w) < 0) ?? REGIONS[REGIONS.length - 1];
  const lon = lerp(region.lon[0], region.lon[1], rand(PLANE_SEED, i, 1));
  const lat = lerp(region.lat[0], region.lat[1], rand(PLANE_SEED, i, 2));
  const heading = region.dirs
    ? region.dirs[Math.floor(rand(PLANE_SEED, i, 3) * region.dirs.length)] + (rand(PLANE_SEED, i, 6) - 0.5) * 0.35
    : rand(PLANE_SEED, i, 3) * 2 * Math.PI;
  const speed = 0.22 + 0.18 * rand(PLANE_SEED, i, 4);
  return {base: project(WORLD, [lon, lat]), vx: Math.cos(heading) * speed, vy: Math.sin(heading) * speed, burst: Math.floor(rand(PLANE_SEED, i, 5) * PLANE_CUES.length)};
});

export interface PlaneAt extends Point { i: number; angle: number; age: number }

/** Planes drawn at frame f (world px): loaded by their burst's chirp, and inside the view frame. */
export const visiblePlanes = (f: number): PlaneAt[] => {
  if (f < PLANE_CUES[0]) return [];
  const r = viewFrame(f);
  const out: PlaneAt[] = [];
  PLANES.forEach((p, i) => {
    const at = PLANE_CUES[p.burst];
    if (f < at) return;
    const x = p.base.x + p.vx * (f - CUT);
    const y = p.base.y + p.vy * (f - CUT);
    if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) return;
    out.push({i, x, y, angle: Math.atan2(p.vy, p.vx), age: f - at});
  });
  return out;
};

/** The planes, on a canvas redrawn from scratch on every frame (a pure function of the frame), clipped to the window. */
const PlaneCanvas: React.FC<{f: number; view: MapView; frame: Rect}> = ({f, view, frame}) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const {width, height} = useVideoConfig();
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const a = toScreen({x: frame.x, y: frame.y}, view);
    const b = toScreen({x: frame.x + frame.w, y: frame.y + frame.h}, view);
    ctx.save();
    ctx.beginPath();
    ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.clip();
    for (const p of visiblePlanes(f)) {
      const s = toScreen(p, view);
      const k = 0.3 + 0.7 * EASE_OUT(clamp01(p.age / 5));
      const cos = Math.cos(p.angle);
      const sin = Math.sin(p.angle);
      ctx.globalAlpha = 0.28 * k;
      ctx.strokeStyle = pal.ink;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(s.x - cos * 5, s.y - sin * 5);
      ctx.lineTo(s.x - cos * 15, s.y - sin * 15);
      ctx.stroke();
      ctx.globalAlpha = k;
      ctx.fillStyle = pal.ink;
      ctx.setTransform(cos * k, sin * k, -sin * k, cos * k, s.x, s.y);
      ctx.beginPath();
      ctx.moveTo(5, 0);
      ctx.lineTo(-4, -3.6);
      ctx.lineTo(-2, 0);
      ctx.lineTo(-4, 3.6);
      ctx.closePath();
      ctx.fill();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }, [f, view, frame, width, height]);
  return <canvas ref={ref} width={width} height={height} style={{position: 'absolute', left: 0, top: 0, width, height}} />;
};

// ── Drawings ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Side of the radar's canvas; its sweep fades out before the canvas edge (shader: dist > 1.05 at scale 1.1). */
const RADAR = 1700;

/** A ship seen from above: a chevron, bow on +x. */
const SHIP_PATH = 'M12 0L-8 -6.5L-3.5 0L-8 6.5Z';

/**
 * The map inside the view frame. Outside, the world keeps the charter's land #dcdee1 on the background (a difference of
 * about 7/255: the part of the world that is not loaded). Inside, the sea takes the surface of the S09/S10 crops and the
 * land the projector grey #c9ccd0 (spec § 3.1) with a 1 px coastline in `dim`: about 40/255 between land and sea, plus
 * the line, so the lens still reads on a projector.
 */
export const LENS = {sea: pal.surface, land: '#c9ccd0', coast: pal.dim, border: pal.line} as const;

/** Top-left chips: the Baltic one, and the paler world one under it (44 px chips, 12 px apart). */
const CHIP_X = 96;
const CHIP_Y = 132;
const CHIP_H = 44;
const CHIP_GAP = 12;

/** « MONDE ENTIER (CÔTES) : AISSTREAM · CLÉ GRATUITE »: paler than the Baltic chip (muted text, dashed border, no fill),
 * under it; the same place on both sides of the cut. */
const WorldChip: React.FC<{f: number}> = ({f}) => {
  if (f < WORLD_CHIP_AT || f >= WORLD_CHIP_OUT + CHIP_FADE) return null;
  const k = ramp(f, WORLD_CHIP_AT, 10);
  return (
    <Chip
      theme={THEME}
      style={{
        position: 'absolute', left: CHIP_X, top: CHIP_Y + CHIP_H + CHIP_GAP, color: pal.muted, background: 'transparent', borderStyle: 'dashed',
        opacity: 0.85 * k * (1 - ramp(f, WORLD_CHIP_OUT, CHIP_FADE)), transform: `translateY(${12 * (1 - k)}px)`,
      }}
    >
      MONDE ENTIER (CÔTES) : AISSTREAM · CLÉ GRATUITE
    </Chip>
  );
};

/** The view frame: an ink window with heavier corners, like a map viewport. */
const ViewFrame: React.FC<{a: Point; b: Point; opacity: number}> = ({a, b, opacity}) => {
  const arm = Math.min(24, (b.x - a.x) / 3, (b.y - a.y) / 3);
  const corners = [
    `M${a.x} ${a.y + arm}V${a.y}H${a.x + arm}`, `M${b.x - arm} ${a.y}H${b.x}V${a.y + arm}`,
    `M${b.x} ${b.y - arm}V${b.y}H${b.x - arm}`, `M${a.x + arm} ${b.y}H${a.x}V${b.y - arm}`,
  ];
  return (
    <g opacity={opacity}>
      <rect x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} fill="none" stroke={pal.ink} strokeWidth={1.5} />
      {corners.map((d) => (
        <path key={d} d={d} fill="none" stroke={pal.ink} strokeWidth={4} strokeLinecap="square" />
      ))}
    </g>
  );
};

// ── The scene ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const S10MerAir: React.FC = () => {
  const f = useCurrentFrame();
  const sea = f < CUT;

  if (sea) {
    const v = balticView(f);
    const S = (p: Point): Point => toScreen(p, v);
    const anchor = S(ANCHOR);
    const rings = pingRings(f);
    const radarIn = ramp(f, ZOOM, 12);
    return (
      <AbsoluteFill style={{background: pal.surface}}>
        <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
          <g transform={viewTransform(v)}>
            <path d={geo.baltic.land} fill={pal.map} stroke={pal.line} strokeWidth={1} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </g>
        </svg>
        <Radar
          frame={f} fps={30} color={pal.ink} ink opacity={0.12 * radarIn} width={RADAR} height={RADAR}
          speed={0.5} scale={1.1} ringCount={6} spokeCount={8} ringThickness={0.03} spokeThickness={0.005} sweepSpeed={1.3}
          sweepWidth={4} falloff={0.6} brightness={1.2}
          style={{position: 'absolute', left: anchor.x - RADAR / 2, top: anchor.y - RADAR / 2}}
        />
        <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
          {/* Lanes and their ports */}
          {LANES.map((l, i) => {
            const a = S(l.from);
            const b = S(l.to);
            return (
              <g key={i}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={pal.muted} strokeWidth={1.5} strokeDasharray="5 7" opacity={0.7} />
                {[a, b].map((p, j) => (
                  <circle key={j} cx={p.x} cy={p.y} r={6} fill={pal.surface2} stroke={pal.ink} strokeWidth={2} />
                ))}
              </g>
            );
          })}
          {/* AIS rings: info, three echoes per ping */}
          {rings.map((r) => {
            const s = S(shipAt(r.ship, f));
            const t = r.age / RING_FRAMES;
            return (
              <circle
                key={`${r.ping}-${r.ship}-${r.echo}`} cx={s.x} cy={s.y} r={12 + 58 * EASE_OUT(t)} fill="none" stroke={INFO}
                strokeWidth={3.5 - 2 * t} opacity={(1 - 0.6 * t) * (1 - 0.2 * r.echo)}
              />
            );
          })}
          {/* Ships */}
          {SHIPS.map((_, i) => {
            const sh = shipAt(i, f);
            const s = S(sh);
            const k = Math.max(...PINGS.map((p, n) => (pingEmitters(n).includes(i) ? pop(f, p) : 1)));
            return (
              <path
                key={i} d={SHIP_PATH} fill={pal.ink} opacity={sh.opacity}
                transform={`translate(${s.x} ${s.y}) rotate(${(sh.angle * 180) / Math.PI}) scale(${k * (v.scale / SCALE_REST)})`}
              />
            );
          })}
        </svg>
        {/* Chips */}
        {f >= BALTIC_AT && (
          <Chip
            theme={THEME}
            style={{
              position: 'absolute', left: CHIP_X, top: CHIP_Y, opacity: ramp(f, BALTIC_AT, 8),
              transform: `translateY(${12 * (1 - ramp(f, BALTIC_AT, 8))}px) scale(${pop(f, BALTIC_AT, 1.06)})`, transformOrigin: 'left center',
            }}
          >
            NAVIRES · AIS · MER BALTIQUE · DIGITRAFFIC · SANS CLÉ
          </Chip>
        )}
        <WorldChip f={f} />
      </AbsoluteFill>
    );
  }

  const v = worldView(f);
  const frame = viewFrame(f);
  const a = toScreen({x: frame.x, y: frame.y}, v);
  const b = toScreen({x: frame.x + frame.w, y: frame.y + frame.h}, v);
  const chipIn = ramp(f, AVIONS_AT, 10);
  return (
    <AbsoluteFill style={{background: pal.bg}}>
      <WorldMap theme={THEME} layers={['land', 'borders']} view={v} />
      {/* The window is a lens, not a card: inside it the map is drawn as the loaded view, the sea lit and the land
          darker with its coastline, so Europe, the Atlantic and America read under the planes. */}
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
        <defs>
          <clipPath id="s10-lens">
            <rect x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} />
          </clipPath>
        </defs>
        <g clipPath="url(#s10-lens)">
          <rect x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} fill={LENS.sea} />
          <g transform={viewTransform(v)}>
            <path d={geo.world.land} fill={LENS.land} stroke={LENS.coast} strokeWidth={1} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            <path d={geo.world.borders} fill="none" stroke={LENS.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          </g>
        </g>
      </svg>
      <PlaneCanvas f={f} view={v} frame={frame} />
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
        {f < CUT + SHIPS_FADE &&
          SHIPS_AT_CUT.map((p, i) => {
            const q = toScreen(p, v);
            return <circle key={i} cx={q.x} cy={q.y} r={3} fill={pal.ink} opacity={1 - ramp(f, CUT, SHIPS_FADE)} />;
          })}
        <ViewFrame a={a} b={b} opacity={1} />
      </svg>
      <WorldChip f={f} />
      {f >= AVIONS_AT && (
        <Chip theme={THEME} style={{position: 'absolute', left: 96, top: 884, opacity: chipIn, transform: `translateY(${12 * (1 - chipIn)}px)`}}>
          AVIONS · OPENSKY / ADSB.LOL · SANS CLÉ
        </Chip>
      )}
    </AbsoluteFill>
  );
};
