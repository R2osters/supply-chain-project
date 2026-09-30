// src/components/LoopSequencer.tsx — the 16-step circular sequencer of the refrains (spec § 4 S06-S08, S17): a ring of
// radius 360 centred in the frame, 28 × 12 px cells, a 2 px ink arm that ratchets one cell per beat in 6 frames
// (spec § 3.5), the 120 px logo at the hub, and four station slots at 12, 3, 6 and 9 o'clock.
// The 12 h and 6 h stations hang inside the ring and the 3 h and 9 h ones sit outside it: a 300 × 110 station card fits
// that way within the 96 px margins without covering a cell. Scale or rotate the whole sequencer from the caller
// (camera pushes, the continuous spin of the drop, the 30 % ring behind the S08 words).
import type {CSSProperties, ReactNode} from 'react';
import {AbsoluteFill} from 'remotion';
import {beatAt, FRAMES_PER_BEAT, roundHalfUp} from '../lib/beat';
import {EASE_OUT} from '../lib/easing';
import {palette, signal, type SignalColor, type Theme} from '../theme/tokens';
import {Logo} from './Logo';

export const RING_CENTER = {x: 960, y: 540} as const;
export const RING_RADIUS = 360;
export const CELLS = 16;
export const STEP_DEG = 360 / CELLS;
const CELL_W = 28;
const CELL_H = 12;
const RATCHET_FRAMES = 6;
const HUB = 120;
const STATION_GAP = 48;
const ARM_FROM = HUB / 2 + 16;
const ARM_TO = RING_RADIUS - 18;

/** Arm angle in degrees, clockwise from 12 o'clock: one 22.5° step per beat, eased over its first 6 frames. */
export const armAngle = (frame: number, speed = 1): number => {
  const f = frame * speed;
  return STEP_DEG * beatAt(f) + STEP_DEG * EASE_OUT(Math.min(1, (f % FRAMES_PER_BEAT) / RATCHET_FRAMES));
};

/** Index of the cell nearest to the arm (0 = 12 o'clock, clockwise). */
export const activeCell = (frame: number, speed = 1): number => (((roundHalfUp(armAngle(frame, speed) / STEP_DEG)) % CELLS) + CELLS) % CELLS;

/** Point of the ring at `deg` degrees clockwise from 12 o'clock, e.g. to move something along the loop. */
export const ringPoint = (deg: number, radius = RING_RADIUS): {x: number; y: number} => {
  const a = (deg * Math.PI) / 180;
  return {x: RING_CENTER.x + radius * Math.sin(a), y: RING_CENTER.y - radius * Math.cos(a)};
};

/** Anchor of each station slot (12 h, 3 h, 6 h, 9 h); the station is aligned on it by its ring-facing side. */
const SLOTS: CSSProperties[] = [
  {left: RING_CENTER.x, top: RING_CENTER.y - RING_RADIUS + STATION_GAP, transform: 'translate(-50%, 0)'},
  {left: RING_CENTER.x + RING_RADIUS + STATION_GAP, top: RING_CENTER.y, transform: 'translate(0, -50%)'},
  {left: RING_CENTER.x, top: RING_CENTER.y + RING_RADIUS - STATION_GAP, transform: 'translate(-50%, -100%)'},
  {left: RING_CENTER.x - RING_RADIUS - STATION_GAP, top: RING_CENTER.y, transform: 'translate(-100%, -50%)'},
];

export interface LoopHighlight {
  color: SignalColor;
  /** Cells lit in `color`; every cell when omitted. */
  cells?: readonly number[];
}

export interface LoopSequencerProps {
  theme: Theme;
  /** The caller's frame (local to its scene). */
  frame: number;
  /** Station contents at 12, 3, 6 and 9 o'clock, in that order; null leaves a slot empty. */
  stations: readonly ReactNode[];
  highlight?: LoopHighlight;
  /** Tempo multiplier of the arm (2 = the double tempo of S17). */
  speed?: number;
  /** Frame at which the cells appear clockwise, one frame apart; always visible when omitted. */
  revealFrom?: number;
}

export const LoopSequencer: React.FC<LoopSequencerProps> = ({theme, frame, stations, highlight, speed = 1, revealFrom}) => {
  const pal = palette(theme);
  const active = activeCell(frame, speed);
  const lit = highlight ? new Set(highlight.cells ?? Array.from({length: CELLS}, (_, i) => i)) : new Set<number>();
  return (
    <AbsoluteFill>
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
        <circle cx={RING_CENTER.x} cy={RING_CENTER.y} r={RING_RADIUS} fill="none" stroke={pal.line} strokeWidth={1} />
      </svg>
      {Array.from({length: CELLS}, (_, i) => {
        const deg = i * STEP_DEG;
        const {x, y} = ringPoint(deg);
        const color = highlight && lit.has(i) ? signal(theme, highlight.color) : i === active ? pal.action : undefined;
        const reveal = revealFrom === undefined ? 1 : EASE_OUT(Math.min(1, Math.max(0, (frame - revealFrom - i) / RATCHET_FRAMES)));
        return (
          <div
            key={i}
            style={{
              position: 'absolute', left: x - CELL_W / 2, top: y - CELL_H / 2, width: CELL_W, height: CELL_H, boxSizing: 'border-box',
              borderRadius: 4, background: color ?? pal.surface2, border: `1px solid ${color ?? pal.line}`,
              transform: `rotate(${deg}deg) scale(${reveal})`, opacity: reveal > 0 ? 1 : 0,
            }}
          />
        );
      })}
      <div
        style={{
          position: 'absolute', left: RING_CENTER.x - 1, top: RING_CENTER.y - ARM_TO, width: 2, height: ARM_TO - ARM_FROM,
          background: pal.action, transformOrigin: `1px ${ARM_TO}px`, transform: `rotate(${armAngle(frame, speed)}deg)`,
        }}
      />
      <Logo
        size={HUB} stroke={2.5} color={pal.action}
        style={{position: 'absolute', left: RING_CENTER.x - HUB / 2, top: RING_CENTER.y - HUB / 2}}
      />
      {stations.slice(0, 4).map((station, i) =>
        station == null ? null : (
          <div key={i} style={{position: 'absolute', ...SLOTS[i]}}>
            {station}
          </div>
        ),
      )}
    </AbsoluteFill>
  );
};
