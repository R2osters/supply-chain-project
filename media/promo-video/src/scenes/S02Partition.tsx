// src/scenes/S02Partition.tsx — S02 · La partition (spec § 4 S02, 6-16 s, dark).
// The S01 trace lifts into the ROUTE line of a five-line staff, the four other lines are drawn from the centre, one per
// beat, and the logo dot stretches into the fixed playhead at x = 640 (timecode 14:01:50 → 14:01:59). Notes (container
// glyphs with their demo identifiers) ride the tape at 8 px per frame and cross the playhead exactly on their S02.cross
// cue, growing 1 → 1.25 → 1. Each spoken word (fournisseurs, camions, navires, entrepôts) lights its line for a beat.
// On « en mesure » (S02.chord) every note on the staff slides into one column on the playhead: the chord.
// The late S01 spike becomes a red note with a twisted stem: it rides the tape, slips under the playhead unplayed, and
// sticks on ROUTE when the first note sounds, just behind the playhead where the played notes have already faded, so it
// stays in sight for the whole scene and out of the chord. « PARTITION » rises as a ghost word, 420 px, on « partition ».
import {AbsoluteFill, interpolateColors, useCurrentFrame} from 'remotion';
import {EASE_OUT} from '../lib/easing';
import {FPS, FRAMES_PER_BAR, FRAMES_PER_BEAT} from '../lib/beat';
import {cue, cueLocal, sceneDef, sceneFrames, seriesLocal, wordLocal} from '../lib/timeline';
import {palette, signal} from '../theme/tokens';
import {ContainerGlyph} from '../components/ContainerGlyph';
import {Playhead, PLAYHEAD_WIDTH} from '../components/Playhead';
import {
  HEADER_Y, lineExtent, lineLight, lineOfPitch, NOTE_HALF, NOTE_SIZE, noteX, PLAYHEAD_X, ROUTE_LINE, Staff, STAFF_LINES, STAFF_MID, STAFF_SPEED,
  STAFF_X0, STAFF_X1, StaffNote, crossScale, type StaffLine, type StaffLineState,
} from '../components/Staff';
import {CONDENSED} from '../components/typography';
import {SplitText} from '../rb/SplitText';
import {CRIT_SPIKE, penX, S01_FRAMES, TRACE, type Shape} from './S01Contretemps';

const THEME = sceneDef('S02').theme;

export const S02_FRAMES = {
  cross: seriesLocal('S02', 'S02.cross'),
  /** The four words and the line each one lights. */
  words: [
    {frame: cueLocal('S02', 'S02.fournisseurs'), line: 0 as StaffLine},
    {frame: cueLocal('S02', 'S02.camions'), line: 1 as StaffLine},
    {frame: cueLocal('S02', 'S02.navires'), line: 2 as StaffLine},
    {frame: cueLocal('S02', 'S02.entrepots'), line: 3 as StaffLine},
  ],
  chord: cueLocal('S02', 'S02.chord'),
  /** The ghost word rises 2 frames before « partition » is spoken (spec § 3.5). */
  partition: wordLocal('S02', 'partition').start - 2,
} as const;

/** Local frame from which each line is drawn: one per beat of the first bar, STOCK first; ROUTE is the S01 trace. */
const LINE_BEAT: Record<StaffLine, number> = {0: 3, 1: 0, 2: 2, 3: 1, 4: 0};
const MORPH_FRAMES = FRAMES_PER_BEAT;
const PLAYHEAD_TOP = HEADER_Y - 12;
const PLAYHEAD_BOTTOM = 780;
const FLIP_FRAMES = 12;
/** Played notes fade out over this x range, behind the playhead, well before the late note. */
const FADE_FROM = PLAYHEAD_X - 40;
const FADE_TO = PLAYHEAD_X - 84;
/** Incoming notes fade in over this x range, so no identifier is ever cut by the frame edge. */
const EDGE_FULL = 1616;
const EDGE_NONE = 1736;
/** A note's identifier brightens over the frames before its crossing and is gone 3 frames after, before it reaches the playhead. */
const ID_READ_FRAMES = 10;
const ID_OUT_FRAMES = 3;

export interface S02Note { k: number; cue: number; pitch: string; line: StaffLine; sounded: boolean }

const CYCLE = (cue('S02.cross').params?.cycle ?? []) as string[];
const sounded: S02Note[] = S02_FRAMES.cross.map((c, i) => {
  const pitch = String(cue(`S02.cross.${i + 1}`).params?.note);
  return {k: i + 1, cue: c, pitch, line: lineOfPitch(pitch), sounded: true};
});
/**
 * The 16 plucks, then silent notes that keep the beat and the cycle for as long as they would be on screen at the chord:
 * the staff does not run empty before « en mesure », and the chord gathers them before they could cross (no pluck).
 */
export const S02_NOTES: S02Note[] = (() => {
  const out = [...sounded];
  const step = S02_FRAMES.cross[1] - S02_FRAMES.cross[0];
  for (let k = out.length + 1; ; k++) {
    const c = S02_FRAMES.cross[S02_FRAMES.cross.length - 1] + step * (k - S02_FRAMES.cross.length);
    if (noteX(c, S02_FRAMES.chord) > STAFF_X1 + NOTE_SIZE / 2) break;
    const pitch = CYCLE[(k - 1) % CYCLE.length];
    out.push({k, cue: c, pitch, line: lineOfPitch(pitch), sounded: false});
  }
  return out;
})();

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const ease = (f: number, from: number, frames: number): number => EASE_OUT(clamp01((f - from) / frames));

/** The ROUTE line is the S01 trace: it lifts from y = 540 to its line and stretches to the staff over the first beat. */
const routeMorph = (f: number): {left: number; right: number; y: number; p: number} => {
  const p = ease(f, 0, MORPH_FRAMES);
  return {
    left: TRACE.x0 + (STAFF_X0 - TRACE.x0) * p,
    right: penX(S01_FRAMES.late) + (STAFF_X1 - penX(S01_FRAMES.late)) * p,
    y: TRACE.y + (STAFF_LINES[ROUTE_LINE].y - TRACE.y) * p,
    p,
  };
};

const extentAt = (line: StaffLine, f: number): {left: number; right: number} => {
  if (line === ROUTE_LINE) {
    const m = routeMorph(f);
    return {left: m.left, right: m.right};
  }
  return lineExtent((f - LINE_BEAT[line] * FRAMES_PER_BEAT) / MORPH_FRAMES);
};

const pastFade = (x: number): number => clamp01((x - FADE_TO) / (FADE_FROM - FADE_TO));

export interface NoteLayout { x: number; scale: number; opacity: number; flash: number; idOpacity: number; idLit: number }

/** Where a note is and how it looks at local frame `f`. */
export const noteLayout = (n: S02Note, f: number): NoteLayout => {
  const chord = S02_FRAMES.chord;
  const atChord = noteX(n.cue, chord);
  const gathered = pastFade(atChord) > 0 && atChord <= STAFF_X1 + NOTE_SIZE / 2;
  const flipping = gathered && f >= chord;
  const x = flipping ? atChord + (PLAYHEAD_X - atChord) * ease(f, chord, FLIP_FRAMES) : noteX(n.cue, f);
  const {left, right} = extentAt(n.line, f);
  // Revealed as its line is drawn over it and as it enters from the right; faded once played, unless the chord has it.
  const reveal = clamp01((right - x + NOTE_HALF) / (2 * NOTE_HALF)) * clamp01((x + NOTE_HALF - left) / (2 * NOTE_HALF));
  const edge = clamp01((EDGE_NONE - x) / (EDGE_NONE - EDGE_FULL));
  const opacity = reveal * edge * (flipping ? 1 : pastFade(x));
  const scale = n.sounded ? crossScale(f, n.cue) : 1;
  const flash = flipping ? 1 : n.sounded && f >= n.cue ? 1 - ease(f, n.cue, 12) : 0;
  // At the chord, one note per line keeps its identifier (the first one there); the others let theirs go.
  const leader = gathered && S02_NOTES.find((m) => m.line === n.line && pastFade(noteX(m.cue, chord)) > 0)?.k === n.k;
  const played = !flipping && n.sounded && f > n.cue ? 1 - clamp01((f - n.cue) / ID_OUT_FRAMES) : 1;
  const idOpacity = (flipping && !leader ? 1 - ease(f, chord, 6) : 1) * played;
  const idLit = flipping ? 1 : n.sounded ? ease(f, n.cue - ID_READ_FRAMES, ID_READ_FRAMES) : 0;
  return {x, scale, opacity, flash, idOpacity, idLit};
};

/** The late note rides the tape from where the S01 spike stopped and sticks when the first note plays. */
export const lateNoteX = (f: number): number => penX(S01_FRAMES.late) - STAFF_SPEED * Math.min(Math.max(f, 0), S02_FRAMES.cross[0]);
export const LATE_NOTE_X = lateNoteX(S02_FRAMES.cross[0]);

/** The playhead timecode: one second per second, 14:01:50 → 14:01:59 over the scene, held under the next wipe. */
export const timecode = (f: number): string => `14:01:${50 + Math.min(9, Math.max(0, Math.floor(f / FPS)))}`;

/**
 * The twisted stem the late spike collapses into, one point per spike point (relative to the note head's centre):
 * it leaves the head's right side, kinks three times like the spike's sub-crests and ends bent over.
 */
const LATE_STEM: Shape = [[16, -10], [17, -22], [23, -28], [17, -35], [24, -42], [18, -48], [24, -54], [21, -58], [30, -62], [37, -56]];

const shapePoints = (x: number, y: number, p: number): string =>
  CRIT_SPIKE.map(([sx, sy], i) => {
    const [tx, ty] = LATE_STEM[i];
    return `${x + sx + (tx - sx) * p},${y + sy + (ty - sy) * p}`;
  }).join(' ');

export const S02Partition: React.FC = () => {
  const f = useCurrentFrame();
  const pal = palette(THEME);
  const crit = signal(THEME, 'crit');
  const {words, chord, partition} = S02_FRAMES;
  const route = routeMorph(f);
  const morphed = route.p >= 1;

  const lines: StaffLineState[] = STAFF_LINES.map((_, i) => {
    const line = i as StaffLine;
    const light = lineLight(f, words.filter((w) => w.line === line).map((w) => w.frame));
    if (line === ROUTE_LINE) return {extent: morphed ? extentAt(line, f) : null, light, label: route.p};
    const start = LINE_BEAT[line] * FRAMES_PER_BEAT;
    return {extent: extentAt(line, f), light, label: ease(f, start, 10)};
  });
  // Bar lines ride the tape and cross the playhead on each downbeat.
  const bars = Math.ceil((sceneFrames('S02') + FRAMES_PER_BAR) / FRAMES_PER_BAR);
  const barlines = Array.from({length: bars + 1}, (_, m) => noteX(m * FRAMES_PER_BAR, f)).filter((x) => x >= STAFF_X0 && x <= STAFF_X1);
  // They come in once the staff has most of its lines.
  const barOpacity = ease(f, 2 * FRAMES_PER_BEAT, 2 * FRAMES_PER_BEAT);

  // The logo dot stretches into the playhead over the first beat's first 12 frames.
  const ph = ease(f, 0, 12);
  const dotX = penX(S01_FRAMES.late);
  const phX = dotX + (PLAYHEAD_X - dotX) * ph;
  const phW = 14 + (PLAYHEAD_WIDTH - 14) * ph;
  const phH = 14 + (PLAYHEAD_BOTTOM - PLAYHEAD_TOP - 14) * ph;

  // The late note: the spike morphs into a stemmed note while it lifts onto ROUTE.
  const lateP = ease(f, 0, 12);
  const lateY = route.y;
  const lateX = lateNoteX(f);
  const headIn = ease(f, 3, 8);

  const chordLit = f >= chord ? 1 - 0.35 * ease(f, chord + FLIP_FRAMES, 30) : 0;

  return (
    <AbsoluteFill style={{background: pal.bg}}>
      {f >= partition && (
        <div style={{position: 'absolute', left: 0, right: 0, top: STAFF_MID - 210, display: 'flex', justifyContent: 'center'}}>
          <SplitText
            words={[{text: 'PARTITION', at: partition}]} frame={f} mode="chars" charStagger={1} rise={60} duration={12} overshoot={1}
            style={{fontFamily: CONDENSED, fontWeight: 600, fontSize: 420, lineHeight: 1, letterSpacing: '-0.02em', color: pal.surface, whiteSpace: 'nowrap'}}
          />
        </div>
      )}

      <Staff theme={THEME} lines={lines} barlines={barlines} barOpacity={barOpacity} clef={ease(f, 0, MORPH_FRAMES)} demo={ease(f, 6, 10)}>
        {!morphed && (
          <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
            <line
              x1={route.left} x2={route.right} y1={route.y} y2={route.y} strokeWidth={2}
              stroke={interpolateColors(route.p, [0, 1], [pal.ink, pal.line])}
            />
          </svg>
        )}

        {f < 12 ? (
          <div
            style={{
              position: 'absolute', left: phX - phW / 2, top: TRACE.y - phH / 2, width: phW, height: phH,
              borderRadius: phW / 2, background: pal.action,
            }}
          />
        ) : (
          <Playhead x={PLAYHEAD_X} top={PLAYHEAD_TOP} height={PLAYHEAD_BOTTOM - PLAYHEAD_TOP} color={pal.action} timecode={timecode(f)} />
        )}

        {S02_NOTES.map((n) => {
          const l = noteLayout(n, f);
          const lit = Math.max(l.flash, chordLit);
          return (
            <StaffNote
              key={n.k} theme={THEME} x={l.x} line={n.line} scale={l.scale} opacity={l.opacity}
              color={interpolateColors(lit, [0, 1], [pal.muted, pal.action])} idOpacity={l.idOpacity}
              idColor={interpolateColors(Math.max(l.idLit, chordLit), [0, 1], [pal.dim, pal.ink])}
            />
          );
        })}

        <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
          <polyline
            points={shapePoints(lateX, lateY, lateP)} fill="none" stroke={crit} strokeWidth={2.5}
            strokeLinejoin="round" strokeLinecap="round"
          />
        </svg>
        {headIn > 0 && (
          <ContainerGlyph
            size={NOTE_SIZE} color={crit}
            style={{position: 'absolute', left: lateX - NOTE_SIZE / 2, top: lateY - NOTE_SIZE / 2, transform: `scale(${headIn})`}}
          />
        )}
      </Staff>
    </AbsoluteFill>
  );
};

