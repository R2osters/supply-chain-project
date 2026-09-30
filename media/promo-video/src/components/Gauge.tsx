// src/components/Gauge.tsx — the tuner gauge of S06 (spec § 4 S06): a 180° arc, 560 px wide by default, graduated 0-100,
// with a neutral, a warn and a crit zone, and needles hung from the hub. The zones are drawn as dashed neutral bands
// until the scene lights them at their cue (`warnLit`, `critLit`): colour = event (spec § 3.2).
// The component draws a still picture; the scene computes the needle values from the frame (dampedSpring).
import type {CSSProperties} from 'react';
import {palette, signal, type Theme} from '../theme/tokens';
import {MONO} from './typography';

export const GAUGE_MAX = 100;
/** The warn rimshot fires when the needle passes 60 (spec § 4 S06: « rimshot warn au-dessus de 60 »). */
export const WARN_FROM = 60;
/** The crit zone holds the 68 % the needle settles on (spec § 3.2: « le 68 % est en crit »). */
export const CRIT_FROM = 65;

export type Zone = 'neutral' | 'warn' | 'crit';
export const GAUGE_ZONES: ReadonlyArray<{from: number; to: number; zone: Zone}> = [
  {from: 0, to: WARN_FROM, zone: 'neutral'},
  {from: WARN_FROM, to: CRIT_FROM, zone: 'warn'},
  {from: CRIT_FROM, to: GAUGE_MAX, zone: 'crit'},
];

export const zoneAt = (value: number): Zone => (value >= CRIT_FROM ? 'crit' : value >= WARN_FROM ? 'warn' : 'neutral');

/** Needle angle in degrees, clockwise from 12 o'clock: 0 lies at 9 o'clock, 50 at noon, 100 at 3 o'clock. */
export const valueToAngle = (value: number): number => -90 + (180 * value) / GAUGE_MAX;

export interface Point { x: number; y: number }

export const gaugePoint = (value: number, radius: number, c: Point): Point => {
  const a = (valueToAngle(value) * Math.PI) / 180;
  return {x: c.x + radius * Math.sin(a), y: c.y - radius * Math.cos(a)};
};

/** SVG path of the arc from `v0` to `v1` (clockwise), or '' for an empty span. */
export const arcPath = (v0: number, v1: number, radius: number, c: Point): string => {
  if (v1 <= v0) return '';
  const a = gaugePoint(v0, radius, c);
  const b = gaugePoint(v1, radius, c);
  const large = (180 * (v1 - v0)) / GAUGE_MAX > 180 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${radius} ${radius} 0 ${large} 1 ${b.x} ${b.y}`;
};

export interface GaugeTick { value: number; major: boolean; label: boolean }
/** A tick every 5, a major tick every 10, a label every 20. */
export const gaugeTicks = (): GaugeTick[] =>
  Array.from({length: GAUGE_MAX / 5 + 1}, (_, i) => ({value: i * 5, major: i % 2 === 0, label: i % 4 === 0}));

export interface GaugeNeedle {
  value: number;
  /** active: the needle being recalculated (ink); ghost: a finished one (muted); parked: not started yet (dim). */
  state: 'active' | 'ghost' | 'parked';
}

export interface GaugeProps {
  theme: Theme;
  /** Radius of the zone band; the arc is 2 × radius wide (spec: 560 px). */
  radius?: number;
  needles: readonly GaugeNeedle[];
  warnLit?: boolean;
  critLit?: boolean;
  /** 0..1: how far the band, ticks and labels have been drawn, from 0 towards 100. */
  drawProgress?: number;
  style?: CSSProperties;
}

const BAND = 14;
const GAP = 0.6; // value units left between two zones
/** Room around the band for the labels. */
export const GAUGE_PAD = 72;
/** Room under the hub. */
export const GAUGE_FOOT = 40;

/** Size of the SVG box and the hub position inside it, for a given band radius. */
export const gaugeBox = (radius: number): {width: number; height: number; hub: Point} => ({
  width: 2 * (radius + GAUGE_PAD),
  height: radius + GAUGE_PAD + GAUGE_FOOT,
  hub: {x: radius + GAUGE_PAD, y: radius + GAUGE_PAD},
});

export const Gauge: React.FC<GaugeProps> = ({theme, radius = 280, needles, warnLit = false, critLit = false, drawProgress = 1, style}) => {
  const pal = palette(theme);
  const {width, height, hub} = gaugeBox(radius);
  const drawn = Math.max(0, Math.min(1, drawProgress)) * GAUGE_MAX;
  const lit = {neutral: false, warn: warnLit, crit: critLit};
  const needleLength = radius - 30;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{display: 'block', overflow: 'visible', ...style}}>
      {/* Diameter: the tuner's base line. */}
      <line x1={hub.x - radius - 24} y1={hub.y} x2={hub.x + radius + 24} y2={hub.y} stroke={pal.line} strokeWidth={1} opacity={Math.min(1, drawn / 20)} />
      {GAUGE_ZONES.map(({from, to, zone}) => {
        const a = from === 0 ? from : from + GAP / 2;
        const b = Math.min(to === GAUGE_MAX ? to : to - GAP / 2, drawn);
        const d = arcPath(a, b, radius, hub);
        if (!d) return null;
        if (zone === 'neutral') return <path key={zone} d={d} fill="none" stroke={pal.line} strokeWidth={BAND} />;
        return lit[zone] ? (
          <path key={zone} d={d} fill="none" stroke={signal(theme, zone)} strokeWidth={BAND} />
        ) : (
          // Unlit: a hatched band, so the zone reads as a zone without spending its colour before the cue.
          <path key={zone} d={d} fill="none" stroke={pal.dim} strokeWidth={BAND} strokeDasharray="2 5" opacity={0.7} />
        );
      })}
      {gaugeTicks()
        .filter((t) => t.value <= drawn + 1e-9)
        .map((t) => {
          const outer = gaugePoint(t.value, radius - BAND / 2 - 8, hub);
          const inner = gaugePoint(t.value, radius - BAND / 2 - 8 - (t.major ? 22 : 12), hub);
          return <line key={t.value} x1={outer.x} y1={outer.y} x2={inner.x} y2={inner.y} stroke={t.major ? pal.muted : pal.dim} strokeWidth={2} />;
        })}
      {gaugeTicks()
        .filter((t) => t.label && t.value <= drawn + 1e-9)
        .map((t) => {
          const p = gaugePoint(t.value, radius + BAND / 2 + 30, hub);
          return (
            <text
              key={t.value} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central" fill={pal.muted}
              style={{fontFamily: MONO, fontWeight: 500, fontSize: 24, fontVariantNumeric: 'tabular-nums'}}
            >
              {t.value}
            </text>
          );
        })}
      {needles.map((n, i) => {
        const tip = gaugePoint(n.value, needleLength, hub);
        // Only the live needle carries a counterweight; finished and parked ones are plain hairlines from the hub.
        const tail = gaugePoint(n.value, n.state === 'active' ? -18 : 0, hub);
        const color = n.state === 'active' ? pal.action : n.state === 'ghost' ? pal.muted : pal.dim;
        return (
          <line
            key={i} x1={tail.x} y1={tail.y} x2={tip.x} y2={tip.y} stroke={color} strokeWidth={n.state === 'active' ? 4 : 2}
            strokeLinecap="round" opacity={n.state === 'parked' ? 0.6 : 1}
          />
        );
      })}
      <circle cx={hub.x} cy={hub.y} r={15} fill={pal.surface} stroke={pal.action} strokeWidth={3} />
      <circle cx={hub.x} cy={hub.y} r={5} fill={pal.action} />
    </svg>
  );
};
