// Adapted from React Bits Counter (https://reactbits.dev), MIT + Commons Clause. Rewritten to be a pure function of the Remotion frame.
// Original: one motion spring per digit column chases floor(value / place). Here the column position is computed from
// `value` like an odometer: the lowest place rolls continuously and each higher place rolls during the last unit of
// the place below it, so a value animated by the caller rolls smoothly and lands on exact digits. The number layout
// (ten stacked numerals, wrapped to ±5 rows) and the fade gradients are the original's; the stylesheet is inlined.
import type {CSSProperties} from 'react';

export type PlaceValue = number | '.';

export interface CounterProps {
  /** Non-negative value; the caller animates it. */
  value: number;
  /** Integer digits shown (leading zeros included). */
  digits: number;
  /** Accepted for the component contract; the roll is a function of `value`, which the caller derives from the frame. */
  frame?: number;
  decimals?: number;
  /** French decimal comma by default. */
  decimalSeparator?: string;
  fontSize?: number;
  padding?: number;
  gap?: number;
  borderRadius?: number;
  horizontalPadding?: number;
  textColor?: string;
  fontWeight?: CSSProperties['fontWeight'];
  containerStyle?: CSSProperties;
  counterStyle?: CSSProperties;
  digitStyle?: CSSProperties;
  gradientHeight?: number;
  /** Edge fade colour; pass the scene background (the original default, black, only suits dark scenes). */
  gradientFrom?: string;
  gradientTo?: string;
}

/** Place values of the columns, left to right, e.g. (2, 2) → [10, 1, '.', 0.1, 0.01]. */
export const counterPlaces = (digits: number, decimals = 0): PlaceValue[] => [
  ...Array.from({length: digits}, (_, i) => 10 ** (digits - 1 - i)),
  ...(decimals > 0 ? (['.'] as PlaceValue[]) : []),
  ...Array.from({length: decimals}, (_, i) => 10 ** -(i + 1)),
];

function normalizeNearInteger(num: number): number {
  const nearest = Math.round(num);
  const tolerance = 1e-9 * Math.max(1, Math.abs(num));
  return Math.abs(num - nearest) < tolerance ? nearest : num;
}

/**
 * Continuous position of the column for `place` (its digit is `position % 10`), with `lowest` the smallest place shown.
 * Worked in units of the lowest place so that 24.13 / 0.01 lands on 2413, not 2412.9999.
 */
export const digitPosition = (value: number, place: number, lowest: number): number => {
  const u = normalizeNearInteger(Math.max(0, value) / lowest);
  const k = Math.round(place / lowest);
  const rem = u - Math.floor(u / k) * k;
  return Math.floor(u / k) + Math.min(1, Math.max(0, rem - (k - 1)));
};

const numberStyle = (y: number): CSSProperties => ({
  position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  transform: `translateY(${y}px)`,
});

export const Counter: React.FC<CounterProps> = ({
  value,
  digits,
  decimals = 0,
  decimalSeparator = ',',
  fontSize = 100,
  padding = 0,
  gap = 8,
  borderRadius = 4,
  horizontalPadding = 8,
  textColor = 'inherit',
  fontWeight = 'inherit',
  containerStyle,
  counterStyle,
  digitStyle,
  gradientHeight = 16,
  gradientFrom = 'transparent',
  gradientTo = 'transparent',
}) => {
  const height = fontSize + padding;
  const places = counterPlaces(digits, decimals);
  const lowest = decimals > 0 ? 10 ** -decimals : 1;
  const digit: CSSProperties = {position: 'relative', width: '1ch', fontVariantNumeric: 'tabular-nums', height, ...digitStyle};
  return (
    <span className="counter-container" style={{position: 'relative', display: 'inline-block', ...containerStyle}}>
      <span
        className="counter-counter"
        style={{
          display: 'flex', overflow: 'hidden', lineHeight: 1, fontSize, gap, borderRadius, paddingLeft: horizontalPadding,
          paddingRight: horizontalPadding, color: textColor, fontWeight, direction: 'ltr', ...counterStyle,
        }}
      >
        {places.map((place, i) => {
          if (place === '.') {
            // Centred like the numerals so the separator shares their baseline.
            return <span key={i} className="counter-digit" style={{...digit, width: 'fit-content', display: 'flex', alignItems: 'center'}}>{decimalSeparator}</span>;
          }
          const position = digitPosition(value, place, lowest);
          const placeValue = position % 10;
          return (
            <span key={i} className="counter-digit" style={digit}>
              {Array.from({length: 10}, (_, n) => {
                // The original's wrap: each numeral sits within ±5 rows of the one on show.
                const offset = (10 + n - placeValue) % 10;
                return <span key={n} className="counter-number" style={numberStyle((offset > 5 ? offset - 10 : offset) * height)}>{n}</span>;
              })}
            </span>
          );
        })}
      </span>
      <span className="gradient-container" style={{pointerEvents: 'none', position: 'absolute', top: 0, bottom: 0, left: 0, right: 0}}>
        <span className="top-gradient" style={{position: 'absolute', top: 0, width: '100%', height: gradientHeight, background: `linear-gradient(to bottom, ${gradientFrom}, ${gradientTo})`}} />
        <span className="bottom-gradient" style={{position: 'absolute', bottom: 0, width: '100%', height: gradientHeight, background: `linear-gradient(to top, ${gradientFrom}, ${gradientTo})`}} />
      </span>
    </span>
  );
};
