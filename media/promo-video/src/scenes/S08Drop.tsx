// src/scenes/S08Drop.tsx — S08 · Drop, 70-74 s, no voice (spec § 4 S08).
// Five full-frame words in Plex Condensed 220 px, one per beat (RotatingText): OBSERVER, RECALCULER, RECOMMANDER,
// ACCEPTER, EXÉCUTER. Each ends on a marker in the colour of its cue, set like a full stop: a dot, and an ink square for
// the human decision. A word takes over from the previous one on a single frame, rising into place at full opacity
// from under a mask, so the drop never shows an empty or a dim frame. Behind them, the ring at 30 % spins
// continuously, one turn per bar (the film's only continuous rotation, spec § 3.5), and each word's colour sweeps its
// cells clockwise over the colour of the word before. The ring has no arm and no hub here: a line crossing the giant
// words would read as a strike-through. The wipe to the light COUPLET 2 is S09's opening (frames 120-135 here).
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {CELLS, RING_CENTER, RING_RADIUS, ringPoint, STEP_DEG} from '../components/LoopSequencer';
import {CONDENSED, LABEL} from '../components/typography';
import {FRAMES_PER_BAR, roundHalfUp} from '../lib/beat';
import {EASE_OUT} from '../lib/easing';
import {cue, sceneDef, seriesLocal} from '../lib/timeline';
import {RotatingText, rotatingIndex} from '../rb/RotatingText';
import {palette, signal, type SignalColor} from '../theme/tokens';
import {clamp01, pop, ramp} from './refrain';

const S = 'S08' as const;
const theme = sceneDef(S).theme;
const pal = palette(theme);
const TEXTS = ['OBSERVER', 'RECALCULER', 'RECOMMANDER', 'ACCEPTER', 'EXÉCUTER'] as const;
const SERIES = 'S08.word';

export interface DropWord { text: string; at: number; color: SignalColor; marker: 'dot' | 'square' }

/** The words, on their cues, each with the colour its cue carries; the ink word (the human decision) gets a square. */
export const DROP_WORDS: readonly DropWord[] = seriesLocal(S, SERIES).map((at, i) => {
  const color = cue(`${SERIES}.${i + 1}`).color as SignalColor;
  return {text: TEXTS[i], at, color, marker: color === 'ink' ? 'square' : 'dot'};
});

const EVERY = DROP_WORDS[1].at - DROP_WORDS[0].at;
/** Words appear 2 frames ahead of their beat, like the voice-driven words (spec § 3.5). */
const LEAD = 2;
const START = DROP_WORDS[0].at - LEAD;
/** Entry length (spec § 3.5: 6-18 frames, ease-out). */
const ENTER = 6;

/** Index of the word on screen (and of the « 0n / 05 » counter): it changes on the frame the next word appears. */
export const dropWordAt = (f: number): number | null => rotatingIndex(f, START, EVERY, DROP_WORDS.length);

/** How far the word on screen has risen into place, 0..1. Its entry starts on the last frame of the word before, so
 * its own first frame (2 frames before its beat) is already one frame in: the swap lands on one frame, with no gap. */
export const dropWordRise = (f: number): number => {
  const i = dropWordAt(f);
  if (i === null) return 0;
  return EASE_OUT(clamp01((f - (START + i * EVERY) + 1) / ENTER));
};

/** The ring's rotation in degrees: one turn per bar. */
export const ringTurn = (f: number): number => (360 * f) / FRAMES_PER_BAR;

const SWEEP = 8;

/** The colour of each cell, clockwise from the ring's own 12 o'clock: from its cue, a word's colour sweeps the cells
 * clockwise in 8 frames (the first cell on the cue itself) over the colour of the word before; neutral before the
 * first cue. */
export const dropCellColors = (f: number): Array<SignalColor | null> => {
  const k = DROP_WORDS.reduce((last, w, i) => (f >= w.at ? i : last), -1);
  if (k < 0) return Array.from({length: CELLS}, () => null);
  const lit = Math.max(1, roundHalfUp(CELLS * ramp(f, DROP_WORDS[k].at, SWEEP)));
  const under = k > 0 ? DROP_WORDS[k - 1].color : null;
  return Array.from({length: CELLS}, (_, j) => (j < lit ? DROP_WORDS[k].color : under));
};

const RING_OPACITY = 0.3;
const CELL_W = 28;
const CELL_H = 12;
const MARKER = 46;
const FONT_SIZE = 220;
const LINE = 176;
/** The mask the words rise through: open above for the accent of « É », closed just under the baseline. */
const MASK = {top: 72, side: 32, bottom: 10} as const;

/** The sequencer's ring and cells (spec § 4 S06: 28 × 12 px cells), turning as one. */
const DropRing: React.FC<{f: number}> = ({f}) => {
  const colors = dropCellColors(f);
  return (
    <AbsoluteFill style={{opacity: RING_OPACITY, transform: `rotate(${ringTurn(f)}deg)`}}>
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
        <circle cx={RING_CENTER.x} cy={RING_CENTER.y} r={RING_RADIUS} fill="none" stroke={pal.line} strokeWidth={1} />
      </svg>
      {colors.map((c, i) => {
        const deg = i * STEP_DEG;
        const {x, y} = ringPoint(deg);
        const color = c === null ? null : signal(theme, c);
        return (
          <div
            key={i}
            style={{
              position: 'absolute', left: x - CELL_W / 2, top: y - CELL_H / 2, width: CELL_W, height: CELL_H, boxSizing: 'border-box',
              borderRadius: 4, background: color ?? pal.surface2, border: `1px solid ${color ?? pal.line}`, transform: `rotate(${deg}deg)`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

export const S08Drop: React.FC = () => {
  const f = useCurrentFrame();
  const i = dropWordAt(f);
  const word = i === null ? null : DROP_WORDS[i];
  const markerOn = word !== null && f >= word.at;
  const markerColor = word ? signal(theme, word.color) : pal.action;
  const markerScale = word ? pop(f, word.at) : 1;
  const rise = dropWordRise(f);
  const step = (n: number) => String(n).padStart(2, '0');
  return (
    <AbsoluteFill style={{background: pal.bg}}>
      <DropRing f={f} />
      {word && i !== null && (
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
          <div style={{position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 26}}>
            <div style={{...LABEL, position: 'absolute', left: 6, top: -34, color: pal.muted}}>{`${step(i + 1)} / ${step(DROP_WORDS.length)}`}</div>
            {/* The mask: padding and negative margins of the same size leave the layout of the row unchanged. */}
            <div style={{overflow: 'hidden', padding: `${MASK.top}px ${MASK.side}px ${MASK.bottom}px`, margin: `-${MASK.top}px -${MASK.side}px -${MASK.bottom}px`}}>
              {/* RotatingText picks the word on the beat and cuts the outgoing one; the scene raises it as one block. */}
              <RotatingText
                items={DROP_WORDS.map((w) => w.text)} frame={f} startFrame={START} every={EVERY} enterFrames={0}
                style={{
                  fontFamily: CONDENSED, fontWeight: 600, fontSize: FONT_SIZE, lineHeight: `${LINE}px`, letterSpacing: '-0.02em', color: pal.ink,
                  flexWrap: 'nowrap', whiteSpace: 'nowrap', transform: `translateY(${(1 - rise) * (LINE + MASK.bottom)}px)`,
                }}
              />
            </div>
            <span
              style={{
                width: MARKER, height: MARKER, marginBottom: 6, flex: 'none', background: markerColor,
                borderRadius: word.marker === 'dot' ? MARKER / 2 : 4, opacity: markerOn ? 1 : 0, transform: `scale(${markerScale})`,
              }}
            />
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
