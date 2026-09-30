// src/components/Playhead.tsx — the ink playhead of spec § 2: a 2 px vertical line, with an optional Plex Mono timecode
// hung from its top, to the right of the line. `x` is the centre of the line.
import {LABEL} from './typography';

/** Width of the playhead line, in px (spec § 2: « un trait d'encre vertical de 2 px »). */
export const PLAYHEAD_WIDTH = 2;

export interface PlayheadProps {
  x: number;
  height: number;
  color: string;
  timecode?: string;
  /** Top of the line, in px. */
  top?: number;
}

export const Playhead: React.FC<PlayheadProps> = ({x, height, color, timecode, top = 0}) => (
  <div style={{position: 'absolute', left: x - PLAYHEAD_WIDTH / 2, top, width: PLAYHEAD_WIDTH, height, background: color}}>
    {timecode !== undefined && <div style={{...LABEL, position: 'absolute', left: 12, top: 0, color}}>{timecode}</div>}
  </div>
);
