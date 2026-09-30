// Adapted from React Bits DecryptedText (https://reactbits.dev), MIT + Commons Clause. Rewritten to be a pure function of the Remotion frame.
// Original: an interval timer reveals one character per tick (sequential mode) and re-shuffles the others with the
// unseeded random generator. Here the text morphs from `from` to `to` over `durationFrames`: the revealed count grows
// linearly with the frame, in the original reveal order, and the hidden characters are re-drawn every frame from the
// seeded PRNG.
import type {CSSProperties} from 'react';
import {rand} from '../lib/prng';

const DEFAULT_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@#$%^&*()_+';

export type RevealDirection = 'start' | 'end' | 'center';

export interface DecryptedTextProps {
  from: string;
  to: string;
  frame: number;
  startFrame: number;
  durationFrames?: number;
  seed: number;
  charset?: string;
  revealDirection?: RevealDirection;
  className?: string;
  style?: CSSProperties;
  /** Style of settled characters (the original `className`). */
  revealedStyle?: CSSProperties;
  /** Style of scrambled characters (the original `encryptedClassName`). */
  encryptedStyle?: CSSProperties;
}

export interface DecryptedChar { char: string; revealed: boolean }

/** Reveal order of the original `computeOrder`. */
const revealOrder = (len: number, direction: RevealDirection): number[] => {
  const order: number[] = [];
  if (direction === 'start') for (let i = 0; i < len; i++) order.push(i);
  else if (direction === 'end') for (let i = len - 1; i >= 0; i--) order.push(i);
  else {
    const middle = Math.floor(len / 2);
    for (let offset = 0; order.length < len; offset++) {
      const idx = offset % 2 === 0 ? middle + offset / 2 : middle - Math.ceil(offset / 2);
      if (idx >= 0 && idx < len) order.push(idx);
    }
  }
  return order;
};

/** Characters on screen at `frame`: `from` before the start, `to` from `startFrame + durationFrames` on. */
export const decryptedChars = (
  from: string,
  to: string,
  frame: number,
  startFrame: number,
  {durationFrames = 12, seed, charset = DEFAULT_CHARSET, revealDirection = 'start'}:
    Pick<DecryptedTextProps, 'durationFrames' | 'seed' | 'charset' | 'revealDirection'>,
): DecryptedChar[] => {
  const plain = (s: string): DecryptedChar[] => Array.from(s, (char) => ({char, revealed: true}));
  if (frame < startFrame) return plain(from);
  if (frame >= startFrame + durationFrames) return plain(to);
  const src = Array.from(from);
  const dst = Array.from(to);
  const width = Math.max(src.length, dst.length);
  const shown = Math.floor(((frame - startFrame) / durationFrames) * width);
  const revealed = new Set(revealOrder(width, revealDirection).slice(0, shown));
  const set = Array.from(charset);
  const out: DecryptedChar[] = [];
  for (let i = 0; i < width; i++) {
    if (revealed.has(i)) {
      if (i < dst.length) out.push({char: dst[i], revealed: true});
      continue;
    }
    const base = i < dst.length ? dst[i] : src[i];
    out.push({char: base === ' ' ? ' ' : set[Math.floor(rand(seed, frame, i) * set.length)], revealed: false});
  }
  return out;
};

export const DecryptedText: React.FC<DecryptedTextProps> = ({
  from,
  to,
  frame,
  startFrame,
  durationFrames = 12,
  seed,
  charset = DEFAULT_CHARSET,
  revealDirection = 'start',
  className = '',
  style,
  revealedStyle,
  encryptedStyle,
}) => {
  const chars = decryptedChars(from, to, frame, startFrame, {durationFrames, seed, charset, revealDirection});
  return (
    <span className={className || undefined} style={{display: 'inline-block', whiteSpace: 'pre-wrap', ...style}} aria-label={frame < startFrame ? from : to}>
      <span aria-hidden="true">
        {chars.map((c, i) => (
          <span key={i} style={c.revealed ? revealedStyle : encryptedStyle}>{c.char}</span>
        ))}
      </span>
    </span>
  );
};
