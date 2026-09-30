// Adapted from React Bits StatusMark (https://reactbits.dev), MIT + Commons Clause. Rewritten to be a pure function of the Remotion frame.
// Original: motion values tween the ring's dash pattern between states and CSS transitions draw the check and the
// label strike. Here the state is explicit (idle = dashed ring, progress = determinate arc, done = full ring + check),
// the caller passes the arc (`progress`) and the draw-in of the done mark (`drawDone`), and the original timings of
// the check (120 ms delay, 240 ms) and of the strike (180 ms delay, 280 ms) are mapped onto `drawDone` 0..1 (460 ms).
// Colours default to currentColor: a signal colour is the caller's to pass, at its cue. The stylesheet is inlined.
import type {CSSProperties, ReactNode} from 'react';
import {Easing, interpolate} from 'remotion';

export type StatusMarkState = 'idle' | 'progress' | 'done';

export interface StatusMarkProps {
  state: StatusMarkState;
  /** Arc of the ring in the progress state, 0..1. */
  progress?: number;
  /** Draw-in of the done state (colour, check, strike), 0..1. */
  drawDone?: number;
  label?: ReactNode;
  color?: string;
  doneColor?: string;
  size?: number;
  strokeWidth?: number;
  dashes?: number;
  fontSize?: number;
  fillOpacity?: number;
  strike?: boolean;
  className?: string;
  style?: CSSProperties;
}

const CHECK = 'M7.5 12.25 10.5 15.25 16.75 8.75';
const IDLE_DASH = 0.3;
const EASE = Easing.bezier(0.23, 1, 0.32, 1);
const TOTAL_MS = 460;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
/** Eased progress of a segment [delay, delay + duration] ms of the done timeline. */
const segment = (drawDone: number, delay: number, duration: number): number =>
  EASE(interpolate(drawDone * TOTAL_MS, [delay, delay + duration], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}));

export const StatusMark: React.FC<StatusMarkProps> = ({
  state,
  progress = 0,
  drawDone = 0,
  label,
  color = 'currentColor',
  doneColor = 'currentColor',
  size = 36,
  strokeWidth = 2,
  dashes = 8,
  fontSize = 28,
  fillOpacity = 0.06,
  strike = true,
  className = '',
  style,
}) => {
  const r = 10 - strokeWidth / 2;
  const C = 2 * Math.PI * r;
  const P = C / Math.max(1, dashes);
  const solid = state !== 'idle';
  const arc = state === 'progress' ? clamp01(progress) : 1;
  // The original's dash pattern: idle = `dashes` short dashes, solid = one arc of length arc·C.
  const dash = solid ? arc * C : IDLE_DASH * P;
  const gap = solid ? (1 - arc) * C : (1 - IDLE_DASH) * P;
  const done = state === 'done';
  const d = clamp01(drawDone);
  const colorMix = done ? segment(d, 0, 200) : 0;
  const glyphColor = done ? `color-mix(in srgb, ${doneColor} ${(100 * colorMix).toFixed(2)}%, ${color})` : color;
  const check = done ? segment(d, 120, 240) : 0;
  const strikeScale = done && strike ? segment(d, 180, 280) : 0;
  const labelOpacity = state === 'idle' ? 0.65 : state === 'progress' ? 1 : 0.6;

  return (
    <span
      className={`status-mark${className ? ` ${className}` : ''}`}
      data-status={state}
      style={{position: 'relative', display: 'inline-flex', alignItems: 'center', gap: size * 0.5, verticalAlign: 'middle', lineHeight: 1, ...style}}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} style={{flex: 'none', overflow: 'visible', color: glyphColor}} aria-hidden={label !== undefined || undefined}>
        <circle
          cx="12" cy="12" r={r} transform="rotate(-90 12 12)" fill="currentColor" stroke="currentColor" strokeWidth={strokeWidth}
          fillOpacity={done ? fillOpacity : 0} strokeOpacity={state === 'progress' ? 0.2 : 0}
        />
        <circle
          cx="12" cy="12" r={r} transform="rotate(-90 12 12)" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round"
          strokeDasharray={`${Math.max(0, dash)} ${Math.max(0, gap)}`} opacity={solid ? 1 : 0.55}
        />
        <path
          d={CHECK} pathLength={1} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
          strokeDasharray="1 2" strokeDashoffset={1.05 * (1 - check)} opacity={check > 0 ? 1 : 0}
        />
      </svg>
      {label !== undefined ? (
        <span style={{position: 'relative', color, fontSize, lineHeight: 1.25, opacity: labelOpacity}}>
          {label}
          <span
            aria-hidden="true"
            style={{
              position: 'absolute', top: '50%', right: 0, left: 0, height: Math.max(1, fontSize / 14), background: 'currentColor',
              transform: `translateY(-50%) scaleX(${strikeScale})`, transformOrigin: 'left center', pointerEvents: 'none',
            }}
          />
        </span>
      ) : null}
    </span>
  );
};
