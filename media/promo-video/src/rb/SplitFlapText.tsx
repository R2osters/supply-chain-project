// Adapted from React Bits SplitFlapText (https://reactbits.dev), MIT + Commons Clause. Rewritten to be a pure function of the Remotion frame.
// Original: a per-display-frame loop walks each tile through `flipsPerChar` random glyphs, and CSS keyframes turn
// the flaps. Here the glyph sequence comes from the seeded PRNG, the tile state is computed from the frame, and the
// keyframes (split-flap-front / split-flap-back) are evaluated in JS with the original curve. The stylesheet is inlined;
// the ::before hinge and ::after rim become two spans. Tiles start blank. Defaults differ where the film needs it: IBM
// Plex Mono Medium (a loaded face) instead of a system monospace at weight 760, and no padding to 12 tiles.
import type {CSSProperties} from 'react';
import {Easing, interpolate} from 'remotion';
import {rand} from '../lib/prng';

const CHARSETS: Record<string, string> = {
  alpha: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  numeric: '0123456789',
};
const FLAP_EASE = Easing.bezier(0.23, 1, 0.32, 1);

export interface SplitFlapTextProps {
  text: string;
  frame: number;
  startFrame: number;
  /** Frames per flip (the original flipDuration, 0.12 s). */
  flapFrames?: number;
  /** Frames between the start of two neighbouring tiles. */
  stagger?: number;
  /** Seed of the random intermediate glyphs. */
  seed: number;
  flipsPerChar?: number;
  charset?: 'alpha' | 'alphanumeric' | 'numeric' | (string & {});
  /** Minimum tile count (the original padded to 12; 0 = exactly the text). */
  padTo?: number;
  tileColor?: string;
  textColor?: string;
  tileRadius?: number;
  gap?: number;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: CSSProperties['fontWeight'];
  className?: string;
  style?: CSSProperties;
}

export interface FlapTile {
  current: string;
  next: string;
  flipping: boolean;
  /** Progress of the flip in progress, 0..1. */
  t: number;
}

const resolveCharset = (charset: string): string => CHARSETS[charset] ?? (charset.length > 0 ? charset : CHARSETS.alphanumeric);

/** Every tile at `frame`. Tiles start blank; a tile whose target is blank never flips (as in the original). */
export const flapTiles = (
  text: string,
  frame: number,
  startFrame: number,
  {flapFrames = 3, stagger = 3, seed, flipsPerChar = 8, charset = 'alphanumeric', padTo = 0}:
    Pick<SplitFlapTextProps, 'flapFrames' | 'stagger' | 'seed' | 'flipsPerChar' | 'charset' | 'padTo'>,
): FlapTile[] => {
  const chars = Array.from(text);
  const width = Math.max(chars.length, Math.ceil(padTo));
  const set = resolveCharset(charset);
  const flips = Math.max(0, Math.floor(flipsPerChar));
  return Array.from({length: width}, (_, index): FlapTile => {
    const target = chars[index] ?? ' ';
    if (target === ' ') return {current: ' ', next: ' ', flipping: false, t: 0};
    const local = frame - startFrame - index * stagger;
    if (local < 0) return {current: ' ', next: ' ', flipping: false, t: 0};
    const step = Math.floor(local / flapFrames);
    if (step > flips) return {current: target, next: target, flipping: false, t: 0};
    const glyph = (k: number): string => (k === flips ? target : set.charAt(Math.floor(rand(seed, index, k) * set.length)) || ' ');
    return {current: step === 0 ? ' ' : glyph(step - 1), next: glyph(step), flipping: true, t: (local - step * flapFrames) / flapFrames};
  });
};

const nbsp = (c: string): string => (c === ' ' ? ' ' : c);

export const SplitFlapText: React.FC<SplitFlapTextProps> = ({
  text,
  frame,
  startFrame,
  flapFrames = 3,
  stagger = 3,
  seed,
  flipsPerChar = 8,
  charset = 'alphanumeric',
  padTo = 0,
  tileColor = '#111827',
  textColor = '#f8fafc',
  tileRadius = 8,
  gap = 6,
  fontSize = 52,
  fontFamily = '"IBM Plex Mono", monospace',
  fontWeight = 500,
  className = '',
  style,
}) => {
  const tiles = flapTiles(text, frame, startFrame, {flapFrames, stagger, seed, flipsPerChar, charset, padTo});

  const root: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap, color: textColor, fontFamily, fontSize, fontWeight,
    lineHeight: 1, letterSpacing: '0.035em', whiteSpace: 'pre', userSelect: 'none', fontVariantNumeric: 'tabular-nums', ...style,
  };
  const tile: CSSProperties = {
    position: 'relative', width: '0.78em', height: '1.08em', overflow: 'hidden', borderRadius: tileRadius,
    background: `radial-gradient(circle at 50% 0%, rgba(255, 255, 255, 0.16), transparent 44%), linear-gradient(180deg, color-mix(in srgb, ${tileColor} 82%, white), ${tileColor})`,
    boxShadow: '0 0.035em 0.08em rgba(255, 255, 255, 0.08) inset, 0 -0.05em 0.1em rgba(0, 0, 0, 0.38) inset, 0 0.16em 0.38em rgba(0, 0, 0, 0.28)',
    perspective: 520, transformStyle: 'preserve-3d', isolation: 'isolate',
  };
  const hinge: CSSProperties = {
    position: 'absolute', zIndex: 8, top: 'calc(50% - 0.5px)', left: 0, width: '100%', height: 1,
    background: 'linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.18) 18%, rgba(0, 0, 0, 0.64) 50%, rgba(255, 255, 255, 0.14) 82%, transparent)',
    boxShadow: '0 -1px 0 rgba(255, 255, 255, 0.08), 0 1px 0 rgba(0, 0, 0, 0.5)',
  };
  const rim: CSSProperties = {
    position: 'absolute', inset: 0, zIndex: 9, border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: 'inherit',
    boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.2) inset',
  };
  const half = (top: boolean): CSSProperties => ({
    position: 'absolute', left: 0, width: '100%', height: '50%', overflow: 'hidden', backfaceVisibility: 'hidden',
    ...(top
      ? {top: 0, background: `linear-gradient(180deg, rgba(255, 255, 255, 0.07), transparent 34%), ${tileColor}`}
      : {bottom: 0, background: `linear-gradient(0deg, rgba(255, 255, 255, 0.06), transparent 38%), color-mix(in srgb, ${tileColor} 92%, black)`}),
  });
  const char = (top: boolean): CSSProperties => ({
    position: 'absolute', left: 0, width: '100%', height: '200%', display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: textColor, textShadow: '0 0.025em 0 rgba(255, 255, 255, 0.16), 0 0.09em 0.16em rgba(0, 0, 0, 0.42)',
    ...(top ? {top: 0} : {bottom: 0}),
  });
  // Keyframes of the original: the front flap falls 0° → -90° (brightness 1.08 → 0.52); the back flap waits at 90°
  // until 45 %, then lands 90° → 0° (brightness 0.58 → 1). Each keyframe segment uses the original curve.
  const front = (t: number): CSSProperties => {
    const e = FLAP_EASE(t);
    return {...half(true), zIndex: 6, transformOrigin: 'center bottom', transform: `rotateX(${-90 * e}deg)`, filter: `brightness(${1.08 - 0.56 * e})`};
  };
  const back = (t: number): CSSProperties => {
    const e = FLAP_EASE(interpolate(t, [0.45, 1], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}));
    return {...half(false), zIndex: 6, transformOrigin: 'center top', transform: `rotateX(${90 * (1 - e)}deg)`, filter: `brightness(${0.58 + 0.42 * e})`};
  };

  const settled = tiles.map((t) => t.current).join('').trimEnd();
  return (
    <div className={`split-flap-text ${className}`.trim()} style={root} role="text" aria-label={settled || undefined}>
      {tiles.map((t, i) => (
        <span key={i} style={tile} aria-hidden="true">
          <span style={half(true)}><span style={char(true)}>{nbsp(t.current)}</span></span>
          <span style={half(false)}><span style={char(false)}>{nbsp(t.flipping ? t.next : t.current)}</span></span>
          {t.flipping ? (
            <>
              <span style={front(t.t)}><span style={char(true)}>{nbsp(t.current)}</span></span>
              <span style={back(t.t)}><span style={char(false)}>{nbsp(t.next)}</span></span>
            </>
          ) : null}
          <span style={hinge} />
          <span style={rim} />
        </span>
      ))}
    </div>
  );
};
