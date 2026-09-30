// Adapted from React Bits TextType (https://reactbits.dev), MIT + Commons Clause. Rewritten to be a pure function of the Remotion frame.
// Original: chained timers append one character per `typingSpeed` ms and a GSAP yoyo tween blinks the
// cursor. Here the typed length is a function of the frame (`charsPerFrame`, optionally sped up so the text is
// complete by `endFrame`) and the cursor blinks on a fixed 8-frame half-period. The stylesheet is inlined.
import type {CSSProperties, ReactNode} from 'react';

export interface TextTypeProps {
  text: string;
  frame: number;
  startFrame: number;
  charsPerFrame?: number;
  /** Frame on which the last character appears at the latest (the rate is raised if needed). */
  endFrame?: number;
  cursor?: boolean;
  cursorCharacter?: ReactNode;
  as?: 'div' | 'span' | 'pre' | 'p';
  className?: string;
  style?: CSSProperties;
  cursorStyle?: CSSProperties;
}

/** Characters typed at `frame`: the first one appears on `startFrame`. */
export const typedCount = (length: number, frame: number, startFrame: number, charsPerFrame = 1, endFrame?: number): number => {
  if (frame < startFrame) return 0;
  if (endFrame !== undefined && frame >= endFrame) return length;
  const span = endFrame !== undefined ? endFrame - startFrame + 1 : Infinity;
  const rate = Math.max(charsPerFrame, length / span);
  return Math.min(length, Math.floor((frame - startFrame + 1) * rate));
};

/** Cursor phase: shown on even 8-frame blocks. */
export const cursorOn = (frame: number): boolean => Math.floor(frame / 8) % 2 === 0;

export const TextType: React.FC<TextTypeProps> = ({
  text,
  frame,
  startFrame,
  charsPerFrame = 1,
  endFrame,
  cursor = true,
  cursorCharacter = '|',
  as: Tag = 'div',
  className = '',
  style,
  cursorStyle,
}) => {
  const chars = Array.from(text);
  const typed = chars.slice(0, typedCount(chars.length, frame, startFrame, charsPerFrame, endFrame)).join('');
  return (
    <Tag className={`text-type ${className}`.trim()} style={{display: 'inline-block', whiteSpace: 'pre-wrap', margin: 0, ...style}}>
      <span className="text-type__content">{typed}</span>
      {cursor ? (
        <span className="text-type__cursor" style={{marginLeft: '0.25rem', display: 'inline-block', opacity: cursorOn(frame) ? 1 : 0, ...cursorStyle}}>
          {cursorCharacter}
        </span>
      ) : null}
    </Tag>
  );
};
