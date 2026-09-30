// src/components/Staff.tsx — the five-line staff of S02 (spec § 4 S02): FOURNISSEURS · ROUTE · MER · ENTREPÔTS · STOCK
// at y = 380 … 700, 2 px hairlines drawn from the centre outward, the logo hexagon as a clef, the line labels in Plex
// Mono 24 px and one DÉMO pill for every identifier on the staff. Notes are glyphs that ride the tape at 8 px per frame
// and cross the fixed playhead at x = 640 on their cue frame (task brief: x = 640 + (cue − f) · 8).
// Pure geometry is exported for the scene and the tests; the components only draw what they are given.
import type {CSSProperties, ReactNode} from 'react';
import {interpolate, interpolateColors} from 'remotion';
import {EASE_OUT} from '../lib/easing';
import {FRAMES_PER_BEAT} from '../lib/beat';
import {palette, type Theme} from '../theme/tokens';
import {ContainerGlyph} from './ContainerGlyph';
import {DemoPill} from './DemoPill';
import {Logo} from './Logo';
import {LABEL} from './typography';

/**
 * The five lines, top to bottom, with the demo identifier their notes carry and the pitch class that lands on them.
 * The S02 plucks are the D minor pentatonic (D F G A C): the tonic D sits on STOCK, the base of the chain, and each
 * higher degree one line up, so a note's height follows its pitch class.
 */
export const STAFF_LINES = [
  {name: 'FOURNISSEURS', y: 380, id: 'PO-0412', pitchClass: 'C'},
  {name: 'ROUTE', y: 460, id: 'SHP-0142', pitchClass: 'A'},
  {name: 'MER', y: 540, id: 'NAV-03', pitchClass: 'G'},
  {name: 'ENTREPÔTS', y: 620, id: 'WH-01', pitchClass: 'F'},
  {name: 'STOCK', y: 700, id: 'SKU-006', pitchClass: 'D'},
] as const;
export type StaffLine = 0 | 1 | 2 | 3 | 4;
export const ROUTE_LINE: StaffLine = 1;

/** Left end of the lines, right of the header (clef, labels); they bleed off the right edge like a tape. */
export const STAFF_X0 = 440;
export const STAFF_X1 = 1920;
/** The lines are drawn from the centre of the frame outward. */
export const STAFF_CENTER_X = 960;
export const STAFF_TOP = STAFF_LINES[0].y;
export const STAFF_BOTTOM = STAFF_LINES[4].y;
export const STAFF_MID = (STAFF_TOP + STAFF_BOTTOM) / 2;
export const PLAYHEAD_X = 640;
/** Tape speed, px per frame: one beat (15 frames) = 120 px. */
export const STAFF_SPEED = 8;
/**
 * Box of a note's ContainerGlyph, px. The hexagon fills 16 of the 24 units of the logo's viewBox, so a 54 px box draws
 * the 36 px glyph of spec § 4 S02.
 */
export const NOTE_SIZE = 54;
/** Visible half-width of a note glyph. */
export const NOTE_HALF = NOTE_SIZE / 3;
/** Peak scale of a note crossing the playhead (spec § 2: 1 → 1,25 → 1 over 8 frames). */
export const CROSS_PEAK = 1.25;
export const CLEF = {x: 96, size: 96, stroke: 2} as const;
/** Centre line of the header row above the staff: the DÉMO pill, and the playhead timecode in the scene. */
export const HEADER_Y = 284;
export const LABEL_X = 216;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** x of a note that crosses the playhead on local frame `cue`, at local frame `f`. */
export const noteX = (cue: number, f: number): number => PLAYHEAD_X + (cue - f) * STAFF_SPEED;

/** The line a pluck lands on, from its pitch class (octave ignored). */
export const lineOfPitch = (note: string): StaffLine => {
  const pc = note.replace(/-?\d+$/, '');
  const i = STAFF_LINES.findIndex((l) => l.pitchClass === pc);
  if (i < 0) throw new Error(`Staff: no line for the pitch ${note}`);
  return i as StaffLine;
};

/** Scale of a note around its crossing: 2 frames up to 1.25 on the cue (the pluck), 6 frames back to 1. */
export const crossScale = (f: number, cue: number): number => {
  if (f <= cue - 2 || f >= cue + 6) return 1;
  if (f <= cue) return interpolate(f, [cue - 2, cue], [1, CROSS_PEAK], {easing: EASE_OUT});
  return interpolate(f, [cue, cue + 6], [CROSS_PEAK, 1], {easing: EASE_OUT});
};

/** How much of a line is drawn at `progress` (0..1, eased here): it grows from the frame centre to the whole staff. */
export const lineExtent = (progress: number): {left: number; right: number} => {
  const reach = Math.max(STAFF_CENTER_X - STAFF_X0, STAFF_X1 - STAFF_CENTER_X);
  const r = EASE_OUT(clamp01(progress)) * reach;
  return {left: Math.max(STAFF_X0, STAFF_CENTER_X - r), right: Math.min(STAFF_X1, STAFF_CENTER_X + r)};
};

/** Light of a line lit by its word cues: full on the cue, held briefly, out after one beat (15 frames). */
export const lineLight = (f: number, cues: readonly number[]): number =>
  cues.reduce((best, c) => {
    if (f < c || f >= c + FRAMES_PER_BEAT) return best;
    return Math.max(best, interpolate(f, [c, c + 4, c + FRAMES_PER_BEAT], [1, 1, 0]));
  }, 0);

export interface StaffLineState {
  /** Drawn extent of the line (see `lineExtent`); null when the scene draws this line itself. */
  extent: {left: number; right: number} | null;
  /** Word light, 0..1. */
  light: number;
  /** Opacity of the label. */
  label: number;
}

export interface StaffProps {
  theme: Theme;
  lines: readonly StaffLineState[];
  /** x of the bar lines on screen (kept within the staff). */
  barlines?: readonly number[];
  /** Opacity of the bar lines. */
  barOpacity?: number;
  /** Clef trace, 0..1 (the hexagon of the logo, without its ring and dot). */
  clef?: number;
  /** Opacity of the header DÉMO pill. */
  demo?: number;
  children?: ReactNode;
}

const headerLabel = (color: string, opacity: number, y: number): CSSProperties => ({
  ...LABEL, position: 'absolute', left: LABEL_X, top: y - 12, height: 24, display: 'flex', alignItems: 'center', color, opacity,
});

export const Staff: React.FC<StaffProps> = ({theme, lines, barlines = [], barOpacity = 1, clef = 1, demo = 1, children}) => {
  const pal = palette(theme);
  const inStaff = barlines.filter((x) => x >= STAFF_X0 && x <= STAFF_X1);
  return (
    <>
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
        {inStaff.map((x) => (
          <line key={x} x1={x} x2={x} y1={STAFF_TOP} y2={STAFF_BOTTOM} stroke={pal.line} strokeWidth={1} opacity={barOpacity} />
        ))}
        {lines.map((l, i) =>
          l.extent && l.extent.right > l.extent.left ? (
            <line
              key={STAFF_LINES[i].name}
              x1={l.extent.left} x2={l.extent.right} y1={STAFF_LINES[i].y} y2={STAFF_LINES[i].y}
              stroke={interpolateColors(l.light, [0, 1], [pal.line, pal.ink])} strokeWidth={2}
            />
          ) : null,
        )}
      </svg>
      <Logo
        size={CLEF.size} stroke={CLEF.stroke} color={pal.action}
        // 0.6 is the end of the hexagon phase: the clef is the hexagon alone.
        drawProgress={0.6 * clamp01(clef)}
        style={{position: 'absolute', left: CLEF.x, top: STAFF_MID - CLEF.size / 2}}
      />
      {lines.map((l, i) => (
        <div key={STAFF_LINES[i].name} style={headerLabel(interpolateColors(l.light, [0, 1], [pal.muted, pal.ink]), l.label, STAFF_LINES[i].y)}>
          {STAFF_LINES[i].name}
        </div>
      ))}
      <DemoPill theme={theme} style={{position: 'absolute', left: LABEL_X, top: HEADER_Y - 18, opacity: demo}} />
      {children}
    </>
  );
};

export interface StaffNoteProps {
  theme: Theme;
  x: number;
  line: StaffLine;
  color: string;
  scale?: number;
  opacity?: number;
  /** Identifier shown above right of the glyph (the line's demo id by default). */
  id?: string;
  idOpacity?: number;
  idColor?: string;
}

/** One note: the container glyph centred on its line, its identifier hung above right, clear of the next line up. */
export const StaffNote: React.FC<StaffNoteProps> = ({theme, x, line, color, scale = 1, opacity = 1, id, idOpacity = 1, idColor}) => {
  if (opacity <= 0) return null;
  const y = STAFF_LINES[line].y;
  return (
    <div style={{position: 'absolute', left: 0, top: 0, opacity}}>
      <ContainerGlyph
        size={NOTE_SIZE} color={color}
        style={{position: 'absolute', left: x - NOTE_SIZE / 2, top: y - NOTE_SIZE / 2, transform: `scale(${scale})`}}
      />
      {idOpacity > 0 && (
        <div style={{...LABEL, position: 'absolute', left: x + NOTE_HALF + 10, top: y - 52, color: idColor ?? palette(theme).muted, opacity: idOpacity}}>
          {id ?? STAFF_LINES[line].id}
        </div>
      )}
    </div>
  );
};
