// src/components/VuLane.tsx — a segmented VU meter: vertical strips in the S11 console, horizontal lanes in the S12
// model race. Lit segments are ink; with a `peakColor` (passed only at that colour's cue), the top two lit segments — the
// crest of the meter — take the signal colour. Segments fill from the label side: left to right, or bottom to top.
import type {CSSProperties} from 'react';
import {roundHalfUp} from '../lib/beat';
import {palette, signal, type SignalColor, type Theme} from '../theme/tokens';
import {LABEL} from './typography';

export type SegmentState = 'off' | 'on' | 'peak';

/** Segments lit for `value` out of `max`, rounded half up and clamped to the meter. */
export const litSegments = (value: number, max: number, segments: number): number =>
  max > 0 ? Math.min(segments, Math.max(0, roundHalfUp((value / max) * segments))) : 0;

/** State of each segment, from the bottom (or left) one; the top two lit segments are the peak when `peak` is set. */
export const segmentStates = (lit: number, segments: number, peak: boolean): SegmentState[] =>
  Array.from({length: segments}, (_, i) => (i >= lit ? 'off' : peak && i >= lit - 2 ? 'peak' : 'on'));

export interface VuLaneProps {
  theme: Theme;
  label: string;
  value: number;
  max: number;
  segments?: number;
  orientation?: 'horizontal' | 'vertical';
  peakColor?: SignalColor;
  /** Size of the meter along its axis, in px. */
  length?: number;
  /** Size of the meter across its axis, in px. */
  thickness?: number;
  /** Fixed label width in horizontal lanes, so stacked lanes align their meters. */
  labelWidth?: number;
  style?: CSSProperties;
}

const GAP = 4;

export const VuLane: React.FC<VuLaneProps> = ({
  theme, label, value, max, segments = 16, orientation = 'horizontal', peakColor,
  length = orientation === 'horizontal' ? 640 : 480, thickness = orientation === 'horizontal' ? 28 : 40, labelWidth, style,
}) => {
  const pal = palette(theme);
  const vertical = orientation === 'vertical';
  const fill: Record<SegmentState, string> = {off: pal.line, on: pal.ink, peak: peakColor ? signal(theme, peakColor) : pal.ink};
  const states = segmentStates(litSegments(value, max, segments), segments, peakColor !== undefined);
  const size = (length - GAP * (segments - 1)) / segments;
  const meter = (
    <div
      style={{
        display: 'flex', flexDirection: vertical ? 'column-reverse' : 'row', gap: GAP, flex: 'none',
        width: vertical ? thickness : length, height: vertical ? length : thickness,
      }}
    >
      {states.map((s, i) => (
        <div key={i} style={{flex: 'none', width: vertical ? thickness : size, height: vertical ? size : thickness, borderRadius: 2, background: fill[s]}} />
      ))}
    </div>
  );
  const text = label ? <div style={{...LABEL, color: pal.muted, width: vertical ? undefined : labelWidth}}>{label}</div> : null;
  return (
    <div style={{display: 'flex', flexDirection: vertical ? 'column' : 'row', alignItems: 'center', gap: vertical ? 16 : 24, ...style}}>
      {vertical ? meter : text}
      {vertical ? text : meter}
    </div>
  );
};
