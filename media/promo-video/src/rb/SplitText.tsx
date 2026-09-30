// Adapted from React Bits SplitText (https://reactbits.dev), MIT + Commons Clause. Rewritten to be a pure function of the Remotion frame.
// Original: GSAP SplitText + ScrollTrigger tween each char or word from {opacity 0, y 40} to {opacity 1, y 0}.
// Here every word carries its own start frame (voice-driven, spec § 3.5), the ease is the charter's EASE_OUT,
// and `overshoot` adds a small scale pop (1 → overshoot → 1) over the same entry.
import type {CSSProperties} from 'react';
import {interpolate} from 'remotion';
import {EASE_OUT} from '../lib/easing';

export interface SplitWord { text: string; at: number }

export interface SplitTextProps {
  /** Words in reading order; `at` is the local frame where the word starts to rise. */
  words: SplitWord[];
  frame: number;
  /** Rise distance in px. */
  rise?: number;
  /** Entry length in frames. */
  duration?: number;
  /** Peak scale reached halfway through the entry. */
  overshoot?: number;
  mode?: 'words' | 'chars';
  /** Frames between two characters of a word in 'chars' mode (the original staggered by 50 ms). */
  charStagger?: number;
  tag?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p' | 'span' | 'div';
  textAlign?: CSSProperties['textAlign'];
  className?: string;
  style?: CSSProperties;
}

export interface SplitEntry { opacity: number; y: number; scale: number }

/** State of one split target (word or char) that starts rising at `at`. Clamped on both sides. */
export const splitEntry = (frame: number, at: number, rise = 40, duration = 8, overshoot = 1.03): SplitEntry => {
  const p = duration > 0 ? interpolate(frame, [at, at + duration], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : Number(frame >= at);
  const e = EASE_OUT(p);
  return {opacity: e, y: rise * (1 - e), scale: 1 + (overshoot - 1) * Math.sin(Math.PI * e)};
};

const targetStyle = ({opacity, y, scale}: SplitEntry): CSSProperties => ({
  display: 'inline-block',
  opacity,
  transform: `translateY(${y}px) scale(${scale})`,
  transformOrigin: '50% 100%',
});

export const SplitText: React.FC<SplitTextProps> = ({
  words,
  frame,
  rise = 40,
  duration = 8,
  overshoot = 1.03,
  mode = 'words',
  charStagger = 1,
  tag: Tag = 'p',
  textAlign = 'center',
  className = '',
  style,
}) => (
  // Structure of the original (split-parent > split-word > split-char). The original clipped the parent with
  // overflow: hidden; it stays visible here so accented capitals and the overshoot never clip.
  <Tag
    className={`split-parent ${className}`.trim()}
    style={{textAlign, display: 'inline-block', whiteSpace: 'normal', overflowWrap: 'break-word', margin: 0, ...style}}
  >
    {words.map((w, wi) => (
      <span key={wi}>
        {mode === 'words' ? (
          <span className="split-word" style={targetStyle(splitEntry(frame, w.at, rise, duration, overshoot))}>
            {w.text}
          </span>
        ) : (
          <span className="split-word" style={{display: 'inline-block'}}>
            {Array.from(w.text).map((ch, ci) => (
              <span key={ci} className="split-char" style={targetStyle(splitEntry(frame, w.at + ci * charStagger, rise, duration, overshoot))}>
                {ch}
              </span>
            ))}
          </span>
        )}
        {wi < words.length - 1 ? ' ' : null}
      </span>
    ))}
  </Tag>
);
