// src/components/Logo.tsx — the "conteneur localisé" logo, traced (spec § 3.4): the hexagon path, then the ring, then
// the dot, all in the 24 × 24 viewBox of the charter. Pin and ContainerGlyph reuse the same geometry.
import type {CSSProperties} from 'react';

const HEX_OUTER = 'M4 8.5 12 4l8 4.5v7L12 20l-8-4.5Z';
const HEX_INNER_REST = 'L5.6 8.9v5.4l6.4 3.6 6.4-3.6V8.9Z';
/** The exact logo path of spec § 3.4 (evenodd when filled). */
export const HEX_PATH = `${HEX_OUTER}m8 4.2${HEX_INNER_REST}`;
/**
 * The outer and inner contours of HEX_PATH as two paths. Browsers restart a dash pattern on every subpath, so a single
 * `pathLength = 1` path would finish its shorter contour early; traced apart, both end exactly with the hexagon phase.
 * The relative `m8 4.2` after the outer contour closes at (4, 8.5) is the absolute (12, 12.7).
 */
export const HEX_CONTOURS = [HEX_OUTER, `M12 12.7${HEX_INNER_REST}`] as const;
export const RING = {cx: 12, cy: 10.2, r: 2.4} as const;
export const DOT_R = 1.1;
export const VIEW = 24;

/** Parts of `drawProgress` spent on each stroke: the hexagon traces first, then the ring, then the dot grows. */
export const LOGO_PHASES = {hex: [0, 0.6], ring: [0.6, 0.9], dot: [0.9, 1]} as const;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
export const phaseProgress = (p: number, [from, to]: readonly [number, number]): number => clamp01((p - from) / (to - from));

/** A stroke width given in screen pixels, expressed in viewBox units for a mark drawn `size` px wide. */
export const viewStroke = (strokePx: number, size: number): number => (strokePx * VIEW) / size;

export interface LogoProps {
  size: number;
  /** Stroke width in screen pixels. */
  stroke: number;
  color: string;
  /** 0 = nothing drawn, 1 = the complete logo. */
  drawProgress?: number;
  style?: CSSProperties;
}

export const Logo: React.FC<LogoProps> = ({size, stroke, color, drawProgress = 1, style}) => {
  const sw = viewStroke(stroke, size);
  const hex = phaseProgress(drawProgress, LOGO_PHASES.hex);
  const ring = phaseProgress(drawProgress, LOGO_PHASES.ring);
  const dot = phaseProgress(drawProgress, LOGO_PHASES.dot);
  // pathLength = 1 normalises every stroke, so the dash offset is simply 1 - progress.
  const trace = (p: number) => (p < 1 ? {pathLength: 1, strokeDasharray: '1 1', strokeDashoffset: 1 - p} : {});
  return (
    <svg width={size} height={size} viewBox={`0 0 ${VIEW} ${VIEW}`} style={{display: 'block', overflow: 'visible', ...style}}>
      {hex > 0 &&
        HEX_CONTOURS.map((d) => (
          <path key={d} d={d} fill="none" stroke={color} strokeWidth={sw} strokeLinejoin="round" strokeLinecap="round" {...trace(hex)} />
        ))}
      {ring > 0 && (
        // Rotated so the ring starts tracing at 12 o'clock, like the playhead.
        <circle
          cx={RING.cx} cy={RING.cy} r={RING.r} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round"
          transform={`rotate(-90 ${RING.cx} ${RING.cy})`} {...trace(ring)}
        />
      )}
      {dot > 0 && <circle cx={RING.cx} cy={RING.cy} r={DOT_R * dot} fill={color} />}
    </svg>
  );
};
