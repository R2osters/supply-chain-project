// src/scenes/S14Pont.tsx — S14 · Pont : chaque chiffre s'explique (spec § 4 S14), 124-136 s, dark, PONT (half time).
// First half: the S07 recommendation comes back small (its RECOMMANDATION station card, bottom left) and bursts into
// three strings stretched across the top of the frame (Threads): « résumé », « raisons », « hypothèses ». Each is
// plucked on its word (S14.pluck1-3, ok): its displacement is 14·e^(−(f−cue)/20) px, as a 6 Hz standing wave (the
// shader has no standing wave, so the sign flips at 6 Hz in the caller), and the string rings ok while the bell does.
// Bottom right, the code panel types itself (TextType, Plex Mono 30 px) with the exact text of the spec; « # vérifié »
// lands on « vérifient » with an ok check. Second half, hard cut on « données » (S14.split, demo): the screen splits.
// Left « RÉEL », a straight track with a live point (in ink: this scene has no live cue); right « DÉMO », the same
// track in violet, wobbling at 5 Hz ±1.5 px in phase with the demo pad's vibrato, with « isSimulated = true » and the
// DÉMO pill. The vertical label « JAMAIS DÉGUISÉES » rises on its words, in the seam.
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {DemoPill} from '../components/DemoPill';
import {Check} from '../components/Glyphs';
import {CONDENSED, LABEL, MONO} from '../components/typography';
import {FPS, roundHalfUp} from '../lib/beat';
import {EASE_OUT} from '../lib/easing';
import {cueLocal, sceneDef, sceneFrames, sceneStart, wordLocal} from '../lib/timeline';
import {SplitText} from '../rb/SplitText';
import {TextType} from '../rb/TextType';
import {Threads} from '../rb/Threads';
import {palette, SHADOW, signal} from '../theme/tokens';
import {StationCard, stationRecommandationDone} from './refrain';

const S = 'S14' as const;
const THEME = sceneDef(S).theme;
const pal = palette(THEME);
const OK = signal(THEME, 'ok');
const DEMO = signal(THEME, 'demo');
const FRAMES = sceneFrames(S);

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
/** Ease-out progress of a move that starts on frame `at` (already visible on that frame) and lasts `frames` frames. */
const hit = (f: number, at: number, frames: number): number => (f < at ? 0 : EASE_OUT(clamp01((f - at + 1) / frames)));
const word = (screen: string): {start: number; end: number} => wordLocal(S, screen);

export const S14_T = (() => {
  const plucks = [cueLocal(S, 'S14.pluck1'), cueLocal(S, 'S14.pluck2'), cueLocal(S, 'S14.pluck3')];
  const split = cueLocal(S, 'S14.split');
  return {
    /** The card bursts into strings as the wipe (S14.wipe) uncovers it: the instrument is strung before the voice. */
    burst: cueLocal(S, 'S14.wipe') + 2,
    /** « s'explique », « raisons », « vérifient »: one pluck per string. */
    plucks,
    /** « données »: hard cut to the split screen. */
    split,
    /** « démo », then « jamais déguisées »: kinetic words, 2 frames ahead. */
    demo: word('démo').start - 2,
    never: [word('jamais').start - 2, word('déguisées').start - 2] as const,
  };
})();

// ---------------------------------------------------------------------------------------------------------------------
// The strings

export const STRING_NAMES = ['résumé', 'raisons', 'hypothèses'] as const;
export const PLUCK_PEAK = 14;
export const PLUCK_DECAY = 20;
export const STANDING_HZ = 6;
/** A Threads line moves about ±0.175 · amplitude canvas heights (task 11 report): px → shader units. */
export const THREADS_UNIT = 0.175;

/** Displacement envelope of a string plucked at `cue`: 14·e^(−(f−cue)/20) px, 0 before the pluck. */
export const pluckEnvelope = (f: number, cue: number): number => (f < cue ? 0 : PLUCK_PEAK * Math.exp(-(f - cue) / PLUCK_DECAY));
/** Signed displacement: the envelope times a 6 Hz standing wave, at its peak on the pluck frame. */
export const pluckDisplacement = (f: number, cue: number): number =>
  pluckEnvelope(f, cue) * Math.cos((2 * Math.PI * STANDING_HZ * (f - cue)) / FPS);
export const threadsAmplitude = (px: number, height: number): number => px / (THREADS_UNIT * height);
/** How much of the ok colour a string wears: all of it on the pluck, fading with the bell. */
export const stringTint = (f: number, cue: number): number => (f < cue ? 0 : Math.exp(-(f - cue) / 12));

/** Mix of two #rrggbb colours, as #rrggbb (Threads hands its colour to ogl, which only parses hex). */
export const mixHex = (a: string, b: string, t: number): string => {
  const ch = (hex: string, k: number): number => parseInt(hex.slice(1 + 2 * k, 3 + 2 * k), 16);
  const p = clamp01(t);
  return `#${[0, 1, 2].map((k) => roundHalfUp(ch(a, k) + (ch(b, k) - ch(a, k)) * p).toString(16).padStart(2, '0')).join('')}`;
};

const STRING_Y = [262, 376, 490];
const STRING_X = 600;
const STRING_W = 1824 - STRING_X;
/** Canvas height: the Threads line width scales with it (7 px × height / width), ~2 px here. The canvases overlap. */
const STRING_H = 340;
/** Where the pluck ring blooms along each string: in the free part, where the Threads lines swing widest. */
const PLUCK_X = [1540, 1640, 1480];

// ---------------------------------------------------------------------------------------------------------------------
// The card (the S07 recommendation, back in its station size)

const CARD = {x: 96, y: 586, w: 352, h: 132};
const ANCHORS = [CARD.y + 38, CARD.y + 68, CARD.y + 104];

// ---------------------------------------------------------------------------------------------------------------------
// The code panel

type Tone = 'kw' | 'code' | 'note';
export interface CodeSegment { text: string; tone: Tone }

/** Spec § 4 S14, verbatim, split into tones for the syntax colouring. */
export const CODE_LINES: readonly (readonly CodeSegment[])[] = [
  [{text: '@dataclass', tone: 'kw'}],
  [{text: 'class ', tone: 'kw'}, {text: 'Recommendation:', tone: 'code'}],
  [{text: '    reasons: list[str]', tone: 'code'}, {text: '   # obligatoire', tone: 'note'}],
  [
    {text: 'def ', tone: 'kw'}, {text: 'test_…(): ', tone: 'code'}, {text: 'assert ', tone: 'kw'}, {text: 'rec.reasons', tone: 'code'},
    {text: '   # vérifié', tone: 'note'},
  ],
];
export const codeLineText = (i: number): string => CODE_LINES[i].map((s) => s.text).join('');

export interface TypedSegment { line: number; index: number; text: string; tone: Tone; start: number; end: number }

/**
 * When each segment types: phases of constant speed tied to the voice — the class on « recommandation », the field on
 * « raisons », its comment on « l'exige », the test on « tests » and « # vérifié » just before the third pluck.
 */
export const typedSegments = (): TypedSegment[] => {
  const [p1, p2, p3] = S14_T.plucks;
  const phases: Array<{line: number; segments: number[]; start: number; end: number}> = [
    {line: 0, segments: [0], start: p1 + 8, end: p1 + 18},
    {line: 1, segments: [0, 1], start: word('recommandation').start - 10, end: word('recommandation').end - 4},
    {line: 2, segments: [0], start: p2 - 6, end: p2 + 14},
    {line: 2, segments: [1], start: word("l'exige").start - 2, end: word("l'exige").start + 10},
    {line: 3, segments: [0, 1, 2, 3], start: word('tests').start - 12, end: p3 - 11},
    {line: 3, segments: [4], start: p3 - 10, end: p3 - 1},
  ];
  return phases.flatMap(({line, segments, start, end}) => {
    const lengths = segments.map((s) => Array.from(CODE_LINES[line][s].text).length);
    const total = lengths.reduce((a, b) => a + b, 0);
    let done = 0;
    return segments.map((s, k) => {
      const from = start + ((end - start) * done) / total;
      done += lengths[k];
      return {line, index: s, text: CODE_LINES[line][s].text, tone: CODE_LINES[line][s].tone, start: from, end: start + ((end - start) * done) / total};
    });
  });
};
const TYPED = typedSegments();
/** First frame of the test line. */
const TEST_START = Math.floor(TYPED.find((s) => s.line === 3)!.start);

const CODE = {x: 896, y: 578, w: 928, fontSize: 30, lineH: 48, pad: 36};
const TONE: Record<Tone, string> = {kw: pal.muted, code: pal.ink, note: pal.ink};
/** A drawn block cursor: the pinned Plex faces have no block element glyph (U+258x). */
const BLOCK = <span style={{display: 'inline-block', width: 14, height: 30, background: pal.ink, verticalAlign: '-4px'}} />;

// ---------------------------------------------------------------------------------------------------------------------
// The split screen

export const WOBBLE_PX = 1.5;
export const WOBBLE_HZ = 5;
const WOBBLE_WAVELENGTH = 150;

/**
 * Vertical offset of the violet track at x (px along the track), frame f: a 5 Hz travelling ripple of ±1.5 px on the
 * film's clock, like the pad's vibrato (score.py: sin(2π·5·s/SR) on absolute samples), ramped in over 2 frames.
 */
export const violetWobble = (x: number, f: number): number => {
  if (f < S14_T.split) return 0;
  const depth = clamp01((f - S14_T.split + 1) / 2);
  const t = (sceneStart(S) + f) / FPS;
  return WOBBLE_PX * depth * Math.sin(2 * Math.PI * WOBBLE_HZ * t - (2 * Math.PI * x) / WOBBLE_WAVELENGTH);
};

const HALF = {left: 96, right: 1056, w: 768};
/** « RÉEL » and « DÉMO »: giant display (spec § 3.3, 150-420 px), one per half. */
const TITLE_SIZE = 260;
const TRACK_Y = 600;
/** The live point beats on the half-time pulse (kick on 1, snare on 3: every 30 frames from the split). */
const PULSE = 30;
/** « isSimulated = true », typed on « démo » (frames after S14_T.demo), the value in the demo colour. */
const SIMULATED = [
  {text: 'isSimulated', from: 0, to: 8, color: pal.ink},
  {text: ' = ', from: 9, to: 10, color: pal.muted},
  {text: 'true', from: 11, to: 14, color: DEMO},
];

const Track: React.FC<{f: number; x: number; color: string; wobble: boolean}> = ({f, x, color, wobble}) => {
  const T = S14_T;
  const draw = hit(f, T.split, 12);
  const n = 96;
  const pts = Array.from({length: n + 1}, (_, k) => {
    const px = (HALF.w * k) / n;
    return `${k ? 'L' : 'M'}${(x + px).toFixed(1)} ${(TRACK_Y + (wobble ? violetWobble(px, f) : 0)).toFixed(2)}`;
  }).join('');
  const along = 0.14 + 0.72 * clamp01((f - T.split) / (FRAMES - T.split));
  const dotX = x + HALF.w * along;
  const dotY = TRACK_Y + (wobble ? violetWobble(HALF.w * along, f) : 0);
  const beat = f - T.split - Math.floor((f - T.split) / PULSE) * PULSE;
  const ripple = clamp01(beat / 14);
  return (
    <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
      <clipPath id={`s14-track-${x}`}>
        {/* Drawn outward from the seam. */}
        <rect x={x < 960 ? x + HALF.w * (1 - draw) : x} y={TRACK_Y - 40} width={HALF.w * draw} height={80} />
      </clipPath>
      <g clipPath={`url(#s14-track-${x})`}>
        {Array.from({length: 9}, (_, k) => (
          <line key={k} x1={x + (HALF.w * k) / 8} x2={x + (HALF.w * k) / 8} y1={TRACK_Y + 14} y2={TRACK_Y + 26} stroke={pal.dim} strokeWidth={1.5} />
        ))}
        <path d={pts} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" />
        {beat < 14 && <circle cx={dotX} cy={dotY} r={9 + 22 * ripple} fill="none" stroke={color} strokeWidth={2} opacity={1 - ripple} />}
        <circle cx={dotX} cy={dotY} r={9} fill={color} />
      </g>
    </svg>
  );
};

const FirstHalf: React.FC<{f: number}> = ({f}) => {
  const T = S14_T;
  const cardIn = hit(f, 0, 8);
  const burst = T.burst;
  return (
    <>
      {/* The three strings, left to right from the card. */}
      {STRING_Y.map((y, k) => {
        const reveal = hit(f, burst + 3 + 2 * k, 14);
        if (reveal <= 0) return null;
        const cue = T.plucks[k];
        const px = pluckDisplacement(f, cue);
        const tint = stringTint(f, cue);
        const color = mixHex(pal.muted, OK, tint);
        const ring = f >= cue && f < cue + 14 ? (f - cue) / 14 : null;
        const pop = f >= cue && f < cue + 8 ? 1 + 0.25 * Math.sin((Math.PI * (f - cue)) / 8) : 1;
        return (
          <div key={k}>
            <div style={{position: 'absolute', left: STRING_X, top: y - STRING_H / 2, width: STRING_W, height: STRING_H, clipPath: `inset(0 ${100 * (1 - reveal)}% 0 0)`}}>
              <Threads frame={f} fps={FPS} amplitude={threadsAmplitude(px, STRING_H)} color={color} width={STRING_W} height={STRING_H} />
            </div>
            {ring !== null && (
              <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
                <circle cx={PLUCK_X[k]} cy={y} r={8 + 46 * EASE_OUT(ring)} fill="none" stroke={OK} strokeWidth={2} opacity={1 - ring} />
                <circle cx={PLUCK_X[k]} cy={y} r={6} fill={OK} opacity={1 - ring} />
              </svg>
            )}
            <div
              style={{
                ...LABEL, letterSpacing: '0.04em', position: 'absolute', left: STRING_X + 12, top: y - 46, color: f >= cue ? pal.ink : pal.muted,
                opacity: reveal, transformOrigin: '0% 100%', transform: `scale(${pop})`,
              }}
            >
              {STRING_NAMES[k]}
            </div>
          </div>
        );
      })}

      {/* The card bursts: one curve per string, from its right edge up to the string's nut. */}
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
        {STRING_Y.map((y, k) => {
          const x0 = CARD.x + CARD.w;
          const d = `M${x0} ${ANCHORS[k]} C${x0 + 110} ${ANCHORS[k]} ${STRING_X - 90} ${y} ${STRING_X} ${y}`;
          const p = hit(f, burst + 2 * k, 7);
          return (
            <g key={k} opacity={p > 0 ? 1 : 0}>
              <path d={d} fill="none" stroke={pal.muted} strokeWidth={1.5} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - p} />
              <circle cx={x0} cy={ANCHORS[k]} r={4} fill={pal.ink} />
              <circle cx={STRING_X} cy={y} r={4} fill={pal.ink} opacity={p >= 1 ? 1 : 0} />
            </g>
          );
        })}
      </svg>
      <div
        style={{
          position: 'absolute', left: CARD.x, top: CARD.y, opacity: cardIn, transformOrigin: '0% 50%',
          transform: `scale(${1.12 - 0.12 * cardIn})`,
        }}
      >
        <StationCard {...stationRecommandationDone()} />
      </div>

      <CodePanel f={f} />
    </>
  );
};

const CodePanel: React.FC<{f: number}> = ({f}) => {
  const T = S14_T;
  // The empty panel comes in with the card, its cursor waiting on the first line.
  const panelIn = hit(f, 2, 12);
  const active = [...TYPED].reverse().find((s) => f >= s.start) ?? TYPED[0];
  const checkIn = hit(f, T.plucks[2], 8);
  const lineTop = (line: number): number => CODE.pad + line * CODE.lineH + (line === 3 ? 30 : 0);
  return (
    <div
      style={{
        position: 'absolute', left: CODE.x, top: CODE.y, width: CODE.w, height: CODE.pad * 2 + 4 * CODE.lineH + 30, boxSizing: 'border-box',
        borderRadius: 10, background: pal.surface, border: `1px solid ${pal.line}`, boxShadow: SHADOW[THEME].md, opacity: panelIn,
        transform: `translateY(${16 * (1 - panelIn)}px)`,
      }}
    >
      {/* The class and its test live in two places: a hairline between them, drawn when the test starts typing. */}
      <div
        style={{
          position: 'absolute', left: CODE.pad, top: lineTop(3) - 16, height: 1, background: pal.line,
          width: (CODE.w - 2 * CODE.pad) * hit(f, TEST_START, 10),
        }}
      />
      {CODE_LINES.map((segments, line) => (
        <div
          key={line}
          style={{
            position: 'absolute', left: CODE.pad, top: lineTop(line), height: CODE.lineH, display: 'flex', alignItems: 'center', whiteSpace: 'pre',
            fontFamily: MONO, fontWeight: 400, fontSize: CODE.fontSize, lineHeight: 1,
          }}
        >
          {segments.map((seg, index) => {
            const s = TYPED.find((t) => t.line === line && t.index === index)!;
            return (
              <TextType
                key={index} as="span" text={seg.text} frame={f} startFrame={s.start} endFrame={s.end} charsPerFrame={0.01}
                cursor={s === active} cursorCharacter={BLOCK} style={{color: TONE[seg.tone], fontWeight: seg.tone === 'note' ? 500 : 400}}
                cursorStyle={{marginLeft: 2}}
              />
            );
          })}
          {line === 3 && checkIn > 0 && <Check size={CODE.fontSize} color={OK} style={{marginLeft: 14, opacity: checkIn, transform: `scale(${1.3 - 0.3 * checkIn})`}} />}
        </div>
      ))}
    </div>
  );
};

const SecondHalf: React.FC<{f: number}> = ({f}) => {
  const T = S14_T;
  const seam = hit(f, T.split, 10);
  const neverIn = hit(f, T.never[0], 10);
  return (
    <>
      {/* The seam, drawn from the middle outwards. */}
      <div style={{position: 'absolute', left: 959, top: 540 - 390 * seam, width: 2, height: 780 * seam, background: pal.line}} />

      <SplitText
        words={[{text: 'RÉEL', at: T.split}]} frame={f} tag="div" textAlign="left" rise={50} duration={10} overshoot={1.02}
        style={{position: 'absolute', left: HALF.left - 8, top: 150, fontFamily: CONDENSED, fontWeight: 600, fontSize: TITLE_SIZE, lineHeight: 1, letterSpacing: '-0.02em', color: pal.ink, whiteSpace: 'nowrap'}}
      />
      <SplitText
        words={[{text: 'DÉMO', at: T.demo}]} frame={f} tag="div" textAlign="left" rise={50} duration={10} overshoot={1.02}
        style={{position: 'absolute', left: HALF.right - 8, top: 150, fontFamily: CONDENSED, fontWeight: 600, fontSize: TITLE_SIZE, lineHeight: 1, letterSpacing: '-0.02em', color: pal.ink, whiteSpace: 'nowrap'}}
      />

      <Track f={f} x={HALF.left} color={pal.ink} wobble={false} />
      <Track f={f} x={HALF.right} color={DEMO} wobble />

      <div style={{position: 'absolute', left: HALF.right, top: 668, height: 48, display: 'flex', alignItems: 'center', gap: 20, opacity: seam}}>
        <DemoPill theme={THEME} />
        <span style={{fontFamily: MONO, fontSize: 30, whiteSpace: 'pre', display: 'inline-flex'}}>
          {SIMULATED.map((s) => (
            <TextType
              key={s.text} as="span" text={s.text} frame={f} startFrame={T.demo + s.from} endFrame={T.demo + s.to} charsPerFrame={0.01}
              cursor={false} style={{color: s.color}}
            />
          ))}
        </span>
      </div>

      {/* JAMAIS DÉGUISÉES, reading upwards in the seam. */}
      {f >= T.never[0] && (
        <div
          style={{
            position: 'absolute', left: 960, top: 560, transform: 'translate(-50%, -50%) rotate(-90deg)', padding: '0 28px', background: pal.bg,
            opacity: Math.min(1, neverIn * 2),
          }}
        >
          <SplitText
            words={[{text: 'JAMAIS', at: T.never[0]}, {text: 'DÉGUISÉES', at: T.never[1]}]} frame={f} tag="div" rise={30} duration={10} overshoot={1.02}
            style={{fontFamily: CONDENSED, fontWeight: 600, fontSize: 64, lineHeight: 1, letterSpacing: '0.01em', color: pal.ink, whiteSpace: 'nowrap'}}
          />
        </div>
      )}
    </>
  );
};

export const S14Pont: React.FC = () => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{background: pal.bg}}>{f < S14_T.split ? <FirstHalf f={f} /> : <SecondHalf f={f} />}</AbsoluteFill>;
};
