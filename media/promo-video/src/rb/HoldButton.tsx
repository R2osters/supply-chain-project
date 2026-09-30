// Adapted from React Bits HoldButton (https://reactbits.dev), MIT + Commons Clause. Rewritten to be a pure function of the Remotion frame.
// Original: pointer and keyboard handlers drive a per-display-frame tween of --hb-p (fill level) and CSS
// transitions for the press and the glow. Here the caller passes the fill level and the press depth for the current
// frame; the liquid fill, its wavy crest and the glow keep the original geometry, computed in px from the explicit
// size instead of a ResizeObserver. Colours come from the charter: the button fills with the action colour.
import type {CSSProperties, ReactNode} from 'react';
import {palette, type Theme} from '../theme/tokens';

const CREST_RIGHT =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='200' viewBox='0 0 20 200' preserveAspectRatio='none'%3E%3Cpath d='M0 0H10C18 8 18 25.3 10 33.3S2 58.7 10 66.7S18 92 10 100S2 125.3 10 133.3S18 158.7 10 166.7S2 192 10 200H0Z'/%3E%3C/svg%3E\")";
const CREST_UP =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='20' viewBox='0 0 200 20' preserveAspectRatio='none'%3E%3Cpath d='M0 20V10C12 2 38 2 50 10S88 18 100 10S138 2 150 10S188 18 200 10V20Z'/%3E%3C/svg%3E\")";

export interface HoldButtonProps {
  label: ReactNode;
  /** Liquid level, 0..1. */
  fill: number;
  /** Press depth, 0..1 (1 = scaled to `pressScale`). */
  pressed: number;
  theme: Theme;
  width?: number;
  height?: number;
  radius?: number;
  fillDirection?: 'right' | 'up';
  /** Scale at full press (spec § 4 S07: 0.96). */
  pressScale?: number;
  wave?: boolean;
  waveAmplitude?: number;
  /** Vertical travel of the crest over a full fill, in button heights (the original used holdTime / 1100 ms). */
  waveCycles?: number;
  glow?: boolean;
  backgroundColor?: string;
  fillColor?: string;
  textColor?: string;
  fillTextColor?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: CSSProperties['fontWeight'];
  letterSpacing?: CSSProperties['letterSpacing'];
  style?: CSSProperties;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export const HoldButton: React.FC<HoldButtonProps> = ({
  label,
  fill,
  pressed,
  theme,
  width = 560,
  height = 120,
  radius = 14,
  fillDirection = 'right',
  pressScale = 0.96,
  wave = true,
  waveAmplitude = 6,
  waveCycles = 1,
  glow = true,
  backgroundColor,
  fillColor,
  textColor,
  fillTextColor,
  fontSize = 32,
  fontFamily = '"IBM Plex Mono", monospace',
  fontWeight = 500,
  letterSpacing = '0.08em',
  style,
}) => {
  const pal = palette(theme);
  const bg = backgroundColor ?? pal.surface2;
  const fillC = fillColor ?? pal.action;
  const text = textColor ?? pal.ink;
  const fillText = fillTextColor ?? pal.actionText;
  const p = clamp01(fill);
  const w = wave ? waveAmplitude : 0;
  const up = fillDirection === 'up';

  const button: CSSProperties = {
    position: 'relative', display: 'inline-grid', placeItems: 'center', isolation: 'isolate', boxSizing: 'border-box',
    width, height, borderRadius: radius, background: bg, color: text, fontFamily, fontSize, fontWeight, letterSpacing,
    lineHeight: 1, whiteSpace: 'nowrap', userSelect: 'none',
    transform: `scale(${1 - (1 - pressScale) * clamp01(pressed)})`,
    // The original faded the glow in over the hold time; its strength follows the fill level here.
    boxShadow: glow
      ? `inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 10px 32px -6px color-mix(in srgb, ${fillC} ${(70 * p).toFixed(2)}%, transparent)`
      : 'inset 0 1px 0 rgba(255, 255, 255, 0.06)',
    ...style,
  };
  const labelStyle: CSSProperties = {position: 'relative', zIndex: 2, display: 'grid', placeItems: 'center'};
  const layer: CSSProperties = {position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: fillC, color: fillText};
  const edge = (size: number): number => (1 - p) * (size + 0.75 * w) - p * 0.25 * w;
  const fillStyle: CSSProperties = {...layer, clipPath: up ? `inset(${edge(height)}px 0 0 0)` : `inset(0 ${edge(width)}px 0 0)`};
  const mask = up
    ? {image: CREST_UP, repeat: 'repeat-x', size: `${width * 2}px ${w}px`, position: `${-p * waveCycles * width}px ${height - p * (height + w)}px`}
    : {image: CREST_RIGHT, repeat: 'repeat-y', size: `${w}px ${height * 2}px`, position: `${-w + p * (width + w)}px ${-p * waveCycles * height}px`};
  const crestStyle: CSSProperties = {
    ...layer,
    WebkitMaskImage: mask.image, maskImage: mask.image,
    WebkitMaskRepeat: mask.repeat, maskRepeat: mask.repeat,
    WebkitMaskSize: mask.size, maskSize: mask.size,
    WebkitMaskPosition: mask.position, maskPosition: mask.position,
  };

  return (
    <div className="hold-button" data-direction={up ? 'up' : 'right'} style={button} aria-label={typeof label === 'string' ? label : undefined}>
      <span className="hold-button__label" style={labelStyle}>{label}</span>
      <span className="hold-button__clip" aria-hidden="true" style={{position: 'absolute', inset: 0, zIndex: 3, clipPath: `inset(0 round ${radius}px)`}}>
        <span className="hold-button__fill" style={fillStyle}>
          <span className="hold-button__label" style={labelStyle}>{label}</span>
        </span>
        {w > 0 ? (
          <span className="hold-button__crest" style={crestStyle}>
            <span className="hold-button__label" style={labelStyle}>{label}</span>
          </span>
        ) : null}
      </span>
    </div>
  );
};
