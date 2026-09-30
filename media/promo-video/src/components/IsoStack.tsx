// src/components/IsoStack.tsx — the isometric slabs of S15 (spec § 4 S15: the installer « éclate en une pile isométrique
// de 4 dalles aux angles du logo »). A slab is a flat prism drawn at the angles of the logo hexagon (spec § 3.4): its top
// face is a rhombus whose edges go 8 across for 4.5 down, and a slab of half-width 8 and thickness 7 is the logo's own
// outer contour. Slabs are placed by the centre of their top face; a stack is a column of slabs one `pitch` apart
// (pitch = thickness gives one solid block, a larger pitch an exploded view).
// Face coordinates (u, v) ∈ [-1, 1]² address the top face: (-1, -1) is its top vertex, (1, -1) the right one, (1, 1) the
// bottom one and (-1, 1) the left one; `faceMatrix` is the same mapping as an SVG matrix, so a pictogram drawn in face
// coordinates lies flat on the slab.
import type {CSSProperties} from 'react';
import {interpolateColors} from 'remotion';
import {palette, type Theme} from '../theme/tokens';

/** Slope of the logo hexagon's edges (M4 8.5 12 4: 8 across for 4.5 down). */
export const ISO_SLOPE = 4.5 / 8;

export interface Pt { x: number; y: number }
export interface Slab {
  /** Centre of the top face. */
  cx: number;
  cy: number;
  /** Half-width of the top face (centre to the left and right vertices). */
  a: number;
  /** Thickness: height of the side faces. */
  t: number;
}
export interface Box { x: number; y: number; w: number; h: number }
/** Top face corners, in the order top, right, bottom, left. */
export type Quad = readonly [Pt, Pt, Pt, Pt];

export const facePoint = (s: Slab, u: number, v: number): Pt => ({
  x: s.cx + ((u - v) * s.a) / 2,
  y: s.cy + ((u + v) * s.a * ISO_SLOPE) / 2,
});

export const topFace = (s: Slab): Quad => [facePoint(s, -1, -1), facePoint(s, 1, -1), facePoint(s, 1, 1), facePoint(s, -1, 1)];

/** SVG matrix(a b c d e f) mapping face coordinates onto the top face. */
export const faceMatrix = (s: Slab): [number, number, number, number, number, number] => {
  const b = s.a * ISO_SLOPE;
  return [s.a / 2, b / 2, -s.a / 2, b / 2, s.cx, s.cy];
};

const down = (p: Pt, t: number): Pt => ({x: p.x, y: p.y + t});

/** The two visible side faces, hung `t` px under the front edges (left → bottom, bottom → right) of a top face. */
export const sideFaces = (quad: Quad, t: number): {left: Pt[]; right: Pt[]} => {
  const [, right, bottom, left] = quad;
  return {
    left: [left, bottom, down(bottom, t), down(left, t)],
    right: [bottom, right, down(right, t), down(bottom, t)],
  };
};

/** Outline of a slab (top, right, right + t, bottom + t, left + t, left): the logo hexagon for a = 8, t = 7. */
export const silhouette = (s: Slab): Pt[] => {
  const [top, right, bottom, left] = topFace(s);
  return [top, right, down(right, s.t), down(bottom, s.t), down(left, s.t), left];
};

/** `n` slabs, top to bottom, their top-face centres `pitch` apart from `cy` down. */
export const stackSlabs = (n: number, {cx, cy, a, t, pitch}: {cx: number; cy: number; a: number; t: number; pitch: number}): Slab[] =>
  Array.from({length: n}, (_, i) => ({cx, cy: cy + i * pitch, a, t}));

/** Bounding box of a stack (from the top vertex of the highest slab to the lowest point of the lowest). */
export const stackBox = (slabs: readonly Slab[]): Box => {
  const pts = slabs.flatMap(silhouette);
  const x = Math.min(...pts.map((p) => p.x));
  const y = Math.min(...pts.map((p) => p.y));
  return {x, y, w: Math.max(...pts.map((p) => p.x)) - x, h: Math.max(...pts.map((p) => p.y)) - y};
};

const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;
const lerpPt = (a: Pt, b: Pt, p: number): Pt => ({x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p)});

export const lerpSlab = (a: Slab, b: Slab, p: number): Slab => ({cx: lerp(a.cx, b.cx, p), cy: lerp(a.cy, b.cy, p), a: lerp(a.a, b.a, p), t: lerp(a.t, b.t, p)});

/**
 * A flat bar tipping into a slab's top face: at 0 the bar's corners (its top-left on the left vertex, top-right on the top
 * one, bottom-right on the right one, bottom-left on the bottom one), at 1 the rhombus.
 */
export const morphQuad = (bar: Box, s: Slab, p: number): Quad => {
  const [top, right, bottom, left] = topFace(s);
  const tl = {x: bar.x, y: bar.y};
  const tr = {x: bar.x + bar.w, y: bar.y};
  const br = {x: bar.x + bar.w, y: bar.y + bar.h};
  const bl = {x: bar.x, y: bar.y + bar.h};
  return [lerpPt(tr, top, p), lerpPt(br, right, p), lerpPt(bl, bottom, p), lerpPt(tl, left, p)];
};

// ---------------------------------------------------------------------------------------------------------------------
// Pictograms lying on a top face, in face coordinates

export type SlabGlyph = 'window' | 'hub' | 'table' | 'network';

const GLYPHS: Record<SlabGlyph, {lines: string; dots?: ReadonlyArray<readonly [number, number, number]>}> = {
  // The interface: a window with its title bar and two lines of content.
  window: {lines: 'M-0.62 -0.62H0.62V0.62H-0.62Z M-0.62 -0.3H0.62 M-0.4 0.02H0.3 M-0.4 0.3H0.05'},
  // The API: a hub and its four endpoints.
  hub: {
    lines: 'M-0.16 0H-0.5 M0.16 0H0.5 M0 -0.16V-0.5 M0 0.16V0.5',
    dots: [[0, 0, 0.16], [-0.62, 0, 0.1], [0.62, 0, 0.1], [0, -0.62, 0.1], [0, 0.62, 0.1]],
  },
  // The database: a table (header row and a 3 × 3 grid) with a map point on one cell (PostGIS).
  table: {lines: 'M-0.62 -0.62H0.62V0.62H-0.62Z M-0.62 -0.3H0.62 M-0.62 0.16H0.62 M-0.2 -0.62V0.62 M0.22 -0.62V0.62', dots: [[0.42, 0.4, 0.09]]},
  // The AI engine: a small network, 2-3-2 nodes.
  network: {
    lines: 'M-0.55 -0.3 0 -0.5M-0.55 -0.3 0 0M-0.55 -0.3 0 0.5M-0.55 0.3 0 -0.5M-0.55 0.3 0 0M-0.55 0.3 0 0.5M0 -0.5 0.55 -0.3M0 0 0.55 -0.3M0 0.5 0.55 -0.3M0 -0.5 0.55 0.3M0 0 0.55 0.3M0 0.5 0.55 0.3',
    dots: [[-0.55, -0.3, 0.09], [-0.55, 0.3, 0.09], [0, -0.5, 0.09], [0, 0, 0.09], [0, 0.5, 0.09], [0.55, -0.3, 0.09], [0.55, 0.3, 0.09]],
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// Rendering

export interface IsoSlabSpec {
  /** Where the slab sits (the pictogram and the default top face follow it). */
  slab: Slab;
  /** Top face override, e.g. while a flat bar tips into the slab (morphQuad); the side faces hang from it. */
  quad?: Quad;
  /** Side-face height override (a tipping bar has no thickness yet). */
  t?: number;
  /** 0 = unlit (a pale top, muted edges), 1 = lit (a white top, ink edges). */
  lit?: number;
  glyph?: SlabGlyph;
  glyphOpacity?: number;
  opacity?: number;
}

export interface IsoStackProps {
  theme: Theme;
  /** Slabs listed top to bottom; they are painted bottom first so the upper ones cover the lower ones. */
  slabs: readonly IsoSlabSpec[];
  /** Edge width in px. */
  stroke?: number;
  style?: CSSProperties;
}

const pts = (p: readonly Pt[]): string => p.map((q) => `${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(' ');

export const IsoStack: React.FC<IsoStackProps> = ({theme, slabs, stroke = 2, style}) => {
  const pal = palette(theme);
  return (
    <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', ...style}}>
      {[...slabs].reverse().map((spec, k) => {
        const {slab, lit = 1, glyph, glyphOpacity = 1, opacity = 1} = spec;
        if (opacity <= 0) return null;
        const quad = spec.quad ?? topFace(slab);
        const t = spec.t ?? slab.t;
        const {left, right} = sideFaces(quad, t);
        const edge = interpolateColors(lit, [0, 1], [pal.muted, pal.ink]);
        const top = interpolateColors(lit, [0, 1], [pal.map, pal.surface2]);
        const g = glyph ? GLYPHS[glyph] : undefined;
        const common = {stroke: edge, strokeWidth: stroke, strokeLinejoin: 'round' as const};
        return (
          <g key={k} opacity={opacity}>
            {t > 0.01 && <polygon points={pts(left)} fill={pal.surface} {...common} />}
            {t > 0.01 && <polygon points={pts(right)} fill={pal.line} {...common} />}
            <polygon points={pts(quad)} fill={top} {...common} />
            {g && glyphOpacity > 0 && (
              <g transform={`matrix(${faceMatrix(slab).join(' ')})`} opacity={glyphOpacity}>
                <path d={g.lines} fill="none" stroke={edge} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                {g.dots?.map(([u, v, r], i) => <circle key={i} cx={u} cy={v} r={r} fill={edge} />)}
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
};
