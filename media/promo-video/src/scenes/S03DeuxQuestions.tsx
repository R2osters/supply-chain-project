// src/scenes/S03DeuxQuestions.tsx — S03 · Deux questions (spec § 4 S03), 16-24 s, light, COUPLET 1.
// The shell wipes the scene in. A divider at x = 960 cuts the screen in two; each half is one kind of software, drawn as
// a pictogram and its caption on « logiciels … une seule question »: a location marker and SUIVRE on the left, a
// histogram and DÉCIDER on the right. The questions rise word by word on the voice, both halves pressed against the
// divider like two opposing voices: « OÙ EST / MA / MARCHANDISE ? » on the left, « QUE / COMMANDER ? » on the right.
// On the last bar the two blocks accelerate into the divider and crush (scaleX 1 → 0.2, ease-in) until they collide on
// the first beat of 24.0 s, where S04 opens with the impact.
// Type size: « MARCHANDISE ? » is 1178 px wide at the spec's 170 px, wider than a half-screen; the questions are set at
// the largest size that fits a half (118 px), identical on both sides.
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {EASE_IN, EASE_OUT} from '../lib/easing';
import {quantize} from '../lib/beat';
import {sceneFrames, wordLocal} from '../lib/timeline';
import {palette} from '../theme/tokens';
import {SplitText} from '../rb/SplitText';
import {Chip} from '../components/Chip';
import {CONDENSED} from '../components/typography';

const ID = 'S03';
const FRAMES = sceneFrames(ID);
const pal = palette('light');
/** Voice-driven entry: on the nearest sixteenth, 2 frames early (spec § 3.5). */
const wordAt = (screen: string): number => quantize(wordLocal(ID, screen).start, '16th') - 2;

export const DIVIDER_X = 960;
/** Gap between each block's inner edge and the divider, px. */
export const INNER_GAP = 36;
/** The collision: from this local frame to the scene's last frame (brief: local 200-240, ease-in). */
export const SQUASH_FROM = 200;
const SQUASH_TO = FRAMES;
const SQUASH_MIN = 0.2;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Horizontal scale of both blocks and how far their inner edges have moved toward the divider. */
export const squash = (f: number): {scaleX: number; shift: number} => {
  const p = EASE_IN(clamp01((f - SQUASH_FROM) / (SQUASH_TO - SQUASH_FROM)));
  return {scaleX: 1 - (1 - SQUASH_MIN) * p, shift: INNER_GAP * p};
};

const MARGIN = 96;
const FONT = 118;
const LEADING = 1;
const ROW_Y = 262;
const PICTO = 96;
const TEXT_Y = 412;
const DIVIDER = {top: 228, bottom: 828};

const ease = (f: number, from: number, frames: number): number =>
  interpolate(f, [from, from + frames], [0, 1], {easing: EASE_OUT, extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

/** « Repère »: a location marker, traced. Stroke in screen px. */
const MarkerPicto: React.FC<{p: number; color: string}> = ({p, color}) => {
  const sw = (3 * 24) / PICTO;
  const trace = p < 1 ? {pathLength: 1, strokeDasharray: '1 1', strokeDashoffset: 1 - p} : {};
  const ring = clamp01((p - 0.55) / 0.35);
  return (
    <svg width={PICTO} height={PICTO} viewBox="0 0 24 24" style={{display: 'block', overflow: 'visible'}}>
      {p > 0 && (
        <path
          d="M12 21.6C12 21.6 5.4 14.8 5.4 9.8a6.6 6.6 0 0 1 13.2 0c0 5-6.6 11.8-6.6 11.8Z"
          fill="none" stroke={color} strokeWidth={sw} strokeLinejoin="round" {...trace}
        />
      )}
      {ring > 0 && <circle cx={12} cy={9.8} r={2.5 * ring} fill="none" stroke={color} strokeWidth={sw} />}
    </svg>
  );
};

/** « Histogramme »: a baseline and four bars growing from it, one after the other. */
const HistogramPicto: React.FC<{f: number; from: number; color: string}> = ({f, from, color}) => {
  const sw = (3 * 24) / PICTO;
  const bars = [6, 11, 8, 15];
  const base = ease(f, from, 8);
  return (
    <svg width={PICTO} height={PICTO} viewBox="0 0 24 24" style={{display: 'block', overflow: 'visible'}}>
      <line x1={3} x2={3 + 18 * base} y1={20.6} y2={20.6} stroke={color} strokeWidth={sw} />
      {bars.map((h, i) => {
        const g = ease(f, from + 3 + 2 * i, 8) * h;
        return g > 0 ? <rect key={i} x={3.4 + 4.9 * i} y={20.6 - g} width={3} height={g} fill="none" stroke={color} strokeWidth={sw} /> : null;
      })}
    </svg>
  );
};

const lineStyle: React.CSSProperties = {
  fontFamily: CONDENSED, fontWeight: 600, fontSize: FONT, lineHeight: LEADING, letterSpacing: '-0.02em', color: pal.ink,
  whiteSpace: 'nowrap', display: 'block',
};

export const S03DeuxQuestions: React.FC = () => {
  const f = useCurrentFrame();
  const {scaleX, shift} = squash(f);

  const divider = ease(f, 4, 18);
  const pictos = wordAt('logiciels');
  const captions = wordAt('question');
  const captionIn = ease(f, captions, 8);
  const caption = (label: string) => (
    <div style={{opacity: captionIn, transform: `translateY(${12 * (1 - captionIn)}px)`}}>
      <Chip theme="light">{label}</Chip>
    </div>
  );

  const left = [
    [{text: 'OÙ', at: wordAt('Où')}, {text: 'EST', at: wordAt('est')}],
    [{text: 'MA', at: wordAt('ma')}],
    [{text: 'MARCHANDISE ?', at: wordAt('marchandise')}],
  ];
  const right = [[{text: 'QUE', at: wordAt('que')}], [{text: 'COMMANDER ?', at: wordAt('commander')}]];
  const block = (lines: typeof left, align: 'left' | 'right') =>
    lines.map((words, i) => (
      <SplitText key={i} words={words} frame={f} rise={56} duration={10} tag="div" textAlign={align} style={lineStyle} />
    ));

  const half = DIVIDER_X - INNER_GAP - MARGIN;
  const half1 = {left: MARGIN, width: half};
  const half2 = {left: DIVIDER_X + INNER_GAP, width: half};

  return (
    <AbsoluteFill style={{background: pal.bg}}>
      {/* The divider, drawn from its middle outwards */}
      <div
        style={{
          position: 'absolute', left: DIVIDER_X - 1, width: 2, background: pal.dim,
          top: (DIVIDER.top + DIVIDER.bottom) / 2 - ((DIVIDER.bottom - DIVIDER.top) / 2) * divider,
          height: (DIVIDER.bottom - DIVIDER.top) * divider,
        }}
      />

      {/* Left: SUIVRE */}
      <div
        style={{
          position: 'absolute', top: 0, height: 1080, ...half1,
          transform: `translateX(${shift}px) scaleX(${scaleX})`, transformOrigin: '100% 50%',
        }}
      >
        <div style={{position: 'absolute', right: 0, top: ROW_Y, height: PICTO, display: 'flex', alignItems: 'center', gap: 24}}>
          {caption('SUIVRE')}
          <MarkerPicto p={ease(f, pictos, 18)} color={pal.ink} />
        </div>
        <div style={{position: 'absolute', right: 0, top: TEXT_Y, textAlign: 'right'}}>{block(left, 'right')}</div>
      </div>

      {/* Right: DÉCIDER */}
      <div
        style={{
          position: 'absolute', top: 0, height: 1080, ...half2,
          transform: `translateX(${-shift}px) scaleX(${scaleX})`, transformOrigin: '0% 50%',
        }}
      >
        <div style={{position: 'absolute', left: 0, top: ROW_Y, height: PICTO, display: 'flex', alignItems: 'center', gap: 24}}>
          <HistogramPicto f={f} from={pictos + 4} color={pal.ink} />
          {caption('DÉCIDER')}
        </div>
        <div style={{position: 'absolute', left: 0, top: TEXT_Y}}>{block(right, 'left')}</div>
      </div>
    </AbsoluteFill>
  );
};
