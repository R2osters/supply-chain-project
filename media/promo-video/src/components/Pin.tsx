// src/components/Pin.tsx — the logo as a map marker: the traced hexagon, the ring and the dot, with the ring and the
// dot scaled about the ring centre (pulses, the dot as a metronome) and a dashed variant for an estimated position.
import type {CSSProperties} from 'react';
import {DOT_R, HEX_PATH, RING, VIEW, viewStroke} from './Logo';

export interface PinProps {
  size: number;
  /** Stroke width in screen pixels. */
  stroke: number;
  color: string;
  ringScale?: number;
  dotScale?: number;
  dashed?: boolean;
  style?: CSSProperties;
}

export const Pin: React.FC<PinProps> = ({size, stroke, color, ringScale = 1, dotScale = 1, dashed = false, style}) => {
  const sw = viewStroke(stroke, size);
  // Dashes of 3 strokes with gaps of 2 strokes, whatever the size.
  const dash = dashed ? {strokeDasharray: `${3 * sw} ${2 * sw}`} : {};
  return (
    <svg width={size} height={size} viewBox={`0 0 ${VIEW} ${VIEW}`} style={{display: 'block', overflow: 'visible', ...style}}>
      <path d={HEX_PATH} fill="none" stroke={color} strokeWidth={sw} strokeLinejoin="round" {...dash} />
      {ringScale > 0 && <circle cx={RING.cx} cy={RING.cy} r={RING.r * ringScale} fill="none" stroke={color} strokeWidth={sw} {...dash} />}
      {dotScale > 0 && <circle cx={RING.cx} cy={RING.cy} r={DOT_R * dotScale} fill={color} />}
    </svg>
  );
};
