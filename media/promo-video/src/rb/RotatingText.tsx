// Adapted from React Bits RotatingText (https://reactbits.dev), MIT + Commons Clause. Rewritten to be a pure function of the Remotion frame.
// Original: an interval timer advances the index and motion's AnimatePresence springs each character in from y 100 %
// (opacity 0) and out to y -120 %. Here the index is `floor((frame - startFrame) / every)`, each character enters over
// `enterFrames` with the charter's EASE_OUT, and the outgoing item leaves on a hard cut (spec § 3.5). The stylesheet
// is inlined.
import type {CSSProperties} from 'react';
import {interpolate} from 'remotion';
import {EASE_OUT} from '../lib/easing';

export interface RotatingTextProps {
  items: string[];
  frame: number;
  /** Frames per item (one beat at 120 BPM). */
  every?: number;
  startFrame: number;
  enterFrames?: number;
  /** Start again from the first item after the last one; otherwise the last item stays (the original looped). */
  loop?: boolean;
  splitBy?: 'characters' | 'words';
  /** Frames between two characters (or words) entering; the original default was 0. */
  staggerFrames?: number;
  staggerFrom?: 'first' | 'last' | 'center' | number;
  className?: string;
  style?: CSSProperties;
  elementStyle?: CSSProperties;
}

/** Rotation step on screen (its item is `step % count`), or null before `startFrame`. Without loop it stops on the last item. */
const rotationStep = (frame: number, startFrame: number, every: number, count: number, loop: boolean): number | null => {
  if (frame < startFrame || count === 0) return null;
  const k = Math.floor((frame - startFrame) / every);
  return loop ? k : Math.min(k, count - 1);
};

/** Index of the item on screen, or null before `startFrame`. */
export const rotatingIndex = (frame: number, startFrame: number, every: number, count: number, loop = false): number | null => {
  const step = rotationStep(frame, startFrame, every, count, loop);
  return step === null ? null : step % count;
};

const graphemes = (text: string): string[] => Array.from(new Intl.Segmenter('fr', {granularity: 'grapheme'}).segment(text), (s) => s.segment);

const staggerDelay = (index: number, total: number, from: RotatingTextProps['staggerFrom'], step: number): number => {
  if (from === 'first') return index * step;
  if (from === 'last') return (total - 1 - index) * step;
  if (from === 'center') return Math.abs(Math.floor(total / 2) - index) * step;
  return Math.abs((from ?? 0) - index) * step;
};

export const RotatingText: React.FC<RotatingTextProps> = ({
  items,
  frame,
  every = 15,
  startFrame,
  enterFrames = 4,
  loop = false,
  splitBy = 'characters',
  staggerFrames = 0,
  staggerFrom = 'first',
  className = '',
  style,
  elementStyle,
}) => {
  const step = rotationStep(frame, startFrame, every, items.length, loop);
  const root: CSSProperties = {display: 'flex', flexWrap: 'wrap', whiteSpace: 'pre-wrap', position: 'relative', ...style};
  if (step === null) return <span className={`text-rotate ${className}`.trim()} style={root} />;

  const text = items[step % items.length];
  const itemStart = startFrame + step * every;
  const words = text.split(' ').map((word) => (splitBy === 'characters' ? graphemes(word) : [word]));
  const total = words.reduce((n, w) => n + w.length, 0);
  let seen = 0;
  return (
    <span className={`text-rotate ${className}`.trim()} style={root} aria-label={text}>
      <span style={{display: 'flex', flexWrap: 'wrap', whiteSpace: 'pre-wrap', position: 'relative'}} aria-hidden="true">
        {words.map((chars, wi) => (
          <span key={wi} style={{display: 'inline-flex'}}>
            {chars.map((ch, ci) => {
              const at = itemStart + staggerDelay(seen++, total, staggerFrom, staggerFrames);
              const p = enterFrames > 0 ? interpolate(frame, [at, at + enterFrames], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : Number(frame >= at);
              const e = EASE_OUT(p);
              return (
                <span key={ci} style={{display: 'inline-block', opacity: e, transform: `translateY(${100 * (1 - e)}%)`, ...elementStyle}}>
                  {ch}
                </span>
              );
            })}
            {wi < words.length - 1 ? <span style={{whiteSpace: 'pre'}}> </span> : null}
          </span>
        ))}
      </span>
    </span>
  );
};
