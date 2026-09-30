// Adapted from React Bits CountUp (https://reactbits.dev), MIT + Commons Clause. Rewritten to be a pure function of the Remotion frame.
// Original: a motion spring (useSpring) started by a viewport hook and a timer writes the formatted value into the span.
// Here the caller computes `value` from the frame (for example with dampedSpring) and chooses the formatting, so the
// French typography (frInt, frPercent, frDecimal) stays in one place.
import type {CSSProperties} from 'react';

export interface CountUpProps {
  value: number;
  format: (n: number) => string;
  className?: string;
  style?: CSSProperties;
}

export const CountUp: React.FC<CountUpProps> = ({value, format, className = '', style}) => (
  // Tabular figures keep the width steady while the value moves.
  <span className={className || undefined} style={{fontVariantNumeric: 'tabular-nums', ...style}}>
    {format(value)}
  </span>
);
