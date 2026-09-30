// src/components/Glyphs.tsx — drawn stand-ins for characters the pinned IBM Plex faces lack (Ruling R13): U+2192 « → »
// and U+2713 « ✓ ». Typing them would pull a system fallback font into the render. Scenes keep the spec's copy verbatim
// on screen by writing the text around the glyph and dropping the glyph in its place:
//
//   <span>FOURNISSEUR A <Arrow size={24} color={pal.ink} /> ENTREPÔT</span>
//
// API (kept deliberately small, later scenes import it):
//   Arrow({size, color, strokeWidth?, style?})   Check({size, color, strokeWidth?, style?})
//   - size: the font size, in px, of the text the glyph sits in. The glyph box is size × size.
//   - color: stroke colour (the caller passes the text colour, or a signal colour at its cue).
//   - strokeWidth: in screen px; defaults to GLYPH_STROKE em, the stem of Plex Medium at that size.
// Inline, the box sits on the text baseline (an inline SVG aligns its bottom edge to it), and the drawing is centred on
// the capitals: the arrow shaft on the cap-height middle, the check mark between the baseline and the cap height.
// In a flex row, give the row `alignItems: 'baseline'` to keep that alignment.
import type {CSSProperties} from 'react';

/** Default stroke, in em: 2 units of the 24-unit box, close to the stem of IBM Plex Mono / Sans Medium. */
export const GLYPH_STROKE = 2 / 24;
const VIEW = 24;

export interface GlyphProps {
  /** Font size of the surrounding text, in px. */
  size: number;
  color: string;
  /** Stroke width in screen px (default: GLYPH_STROKE × size). */
  strokeWidth?: number;
  style?: CSSProperties;
}

const Glyph: React.FC<GlyphProps & {d: string}> = ({size, color, strokeWidth, style, d}) => (
  <svg
    width={size}
    height={size}
    viewBox={`0 0 ${VIEW} ${VIEW}`}
    aria-hidden="true"
    style={{display: 'inline-block', flex: 'none', overflow: 'visible', ...style}}
  >
    <path
      d={d}
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth === undefined ? GLYPH_STROKE * VIEW : (strokeWidth * VIEW) / size}
      strokeLinecap="butt"
      strokeLinejoin="miter"
    />
  </svg>
);

// Plex capitals are 0.698 em tall, so their middle sits 0.349 em above the baseline: y = 24 − 8.4 = 15.6.
const ARROW = 'M2.5 15.6H21M15.4 10 21 15.6 15.4 21.2';
// From the baseline (y 24) to the cap height (y 7.25), with room for the stroke.
const CHECK = 'M3.5 15.4 9 20.9 20.5 8.6';

/** « → », drawn. */
export const Arrow: React.FC<GlyphProps> = (props) => <Glyph {...props} d={ARROW} />;

/** « ✓ », drawn. */
export const Check: React.FC<GlyphProps> = (props) => <Glyph {...props} d={CHECK} />;
