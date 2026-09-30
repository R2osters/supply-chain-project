// src/components/Keys.tsx — the supplier keyboard of S13 (spec § 4 S13): tall keys (180 × 520 px) hanging from a key
// bed, one per supplier. The scene drives every key from the frame through a KeyState:
//   - enter: 0 → 1 entry (the key drops in from above and fades in);
//   - press: 0 → 1 travel (the key sinks KEY_TRAVEL px and its shadow tightens; its outline turns ink);
//   - fill: the key's share of the order, 0..1 of its height, in ink from the bottom edge: the quantity bar, no figure;
//   - strike: 0 → 1 draw of the diagonal strike (in `strikeColor`, passed only at its cue);
//   - dim: 0 → 1 fade of a key set aside.
// `cap` draws the dashed ceiling across the keyboard at the height a fill of `share` reaches on a key at rest, and
// hangs the scene's label at its right end. The label under the fill turns to the action text colour, so it stays
// readable when the ink rises over it.
import type {CSSProperties, ReactNode} from 'react';
import {palette, SHADOW, type Theme} from '../theme/tokens';
import {LABEL} from './typography';

export const KEY_W = 180;
export const KEY_H = 520;
export const KEY_GAP = 20;
/** How far a key sinks when pressed, in px. */
export const KEY_TRAVEL = 10;
/** Height of the key bed the keys hang from, above y = 0. */
export const KEY_BED = 22;
/** How far the key bed and the cap line reach past the outer keys, on each side. */
export const KEY_OVERHANG = 12;

export const keyLeft = (i: number): number => i * (KEY_W + KEY_GAP);
export const keyboardWidth = (n: number): number => n * KEY_W + (n - 1) * KEY_GAP;
/** Height of the ink for a share of the order (0..1), from the key's bottom edge. */
export const fillHeight = (share: number): number => Math.min(1, Math.max(0, share)) * KEY_H;
/** Distance from the top of the keyboard to the cap line of a given share, for a key at rest. */
export const capOffset = (share: number): number => KEY_H - fillHeight(share);

export interface KeyState {
  label: string;
  enter: number;
  press: number;
  fill: number;
  strike: number;
  dim: number;
}

export interface KeysProps {
  theme: Theme;
  keys: KeyState[];
  /** Colour of the strike (the scene passes the crit colour at the strike cue). */
  strikeColor: string;
  cap?: {share: number; draw: number; label: ReactNode};
  style?: CSSProperties;
}

const RADIUS = '4px 4px 14px 14px';
const LABEL_BOTTOM = 30;

/** The key's name near its bottom edge; `clip` is in the key's box, so a copy can be cut to the ink region. */
const KeyLabel: React.FC<{text: string; color: string; clip?: string}> = ({text, color, clip}) => (
  <div style={{position: 'absolute', inset: 0, clipPath: clip}}>
    <div style={{...LABEL, fontSize: 28, position: 'absolute', left: 0, right: 0, bottom: LABEL_BOTTOM, textAlign: 'center', color}}>{text}</div>
  </div>
);

export const Keys: React.FC<KeysProps> = ({theme, keys, strikeColor, cap, style}) => {
  const pal = palette(theme);
  const width = keyboardWidth(keys.length);
  const bedIn = keys.length ? Math.max(...keys.map((k) => k.enter)) : 0;
  return (
    <div style={{position: 'absolute', width, height: KEY_H + KEY_TRAVEL, ...style}}>
      {/* The key bed: a slim rail the keys hang from, like a keyboard's key slip. */}
      <div
        style={{
          position: 'absolute', left: -KEY_OVERHANG, top: -KEY_BED, width: width + 2 * KEY_OVERHANG, height: KEY_BED + 6, borderRadius: 6,
          background: pal.muted, opacity: bedIn, transform: `scaleX(${0.9 + 0.1 * bedIn})`,
        }}
      />
      {keys.map((k, i) => {
        const fillH = fillHeight(k.fill);
        const inkClip = `inset(${KEY_H - fillH}px 0 0 0)`;
        return (
          <div
            key={k.label}
            style={{
              position: 'absolute', left: keyLeft(i), top: 0, width: KEY_W, height: KEY_H, opacity: k.enter,
              transform: `translateY(${KEY_TRAVEL * k.press - 36 * (1 - k.enter)}px)`,
            }}
          >
            {/* The body dims when the key is set aside; the strike over it keeps its full strength. */}
            <div
              style={{
                position: 'absolute', inset: 0, boxSizing: 'border-box', borderRadius: RADIUS, overflow: 'hidden', background: pal.surface2,
                border: `${1 + k.press}px solid ${k.press > 0 ? pal.ink : pal.line}`,
                boxShadow: k.press > 0.5 ? SHADOW[theme].sm : SHADOW[theme].md, opacity: 1 - 0.5 * k.dim,
              }}
            >
              {/* The quantity bar: ink rising from the bottom edge. */}
              {fillH > 0 && <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: fillH, background: pal.ink}} />}
              <KeyLabel text={k.label} color={pal.ink} />
              {fillH > 0 && <KeyLabel text={k.label} color={pal.actionText} clip={inkClip} />}
            </div>
            {k.strike > 0 && (
              <svg width={KEY_W} height={KEY_H} viewBox={`0 0 ${KEY_W} ${KEY_H}`} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
                <path
                  d={`M18 20 L${KEY_W - 18} ${KEY_H - 20}`} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - k.strike}
                  stroke={strikeColor} strokeWidth={6} strokeLinecap="round" fill="none"
                />
              </svg>
            )}
          </div>
        );
      })}
      {cap && cap.draw > 0 && (
        <>
          <svg width={width + 2 * KEY_OVERHANG} height={4} style={{position: 'absolute', left: -KEY_OVERHANG, top: capOffset(cap.share) - 1, overflow: 'visible'}}>
            <line x1={0} x2={(width + 2 * KEY_OVERHANG) * cap.draw} y1={1} y2={1} stroke={pal.ink} strokeWidth={2} strokeDasharray="10 8" />
          </svg>
          <div
            style={{
              position: 'absolute', left: width + KEY_OVERHANG + 20, top: capOffset(cap.share) - 12, height: 24, display: 'flex', alignItems: 'center',
              opacity: Math.min(1, Math.max(0, (cap.draw - 0.6) / 0.4)),
            }}
          >
            {cap.label}
          </div>
        </>
      )}
    </div>
  );
};
