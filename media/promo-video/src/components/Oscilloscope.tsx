// src/components/Oscilloscope.tsx — the ETA oscilloscope of S05 (spec § 4 S05), in frame coordinates (1920 × 1080).
// A scope screen with a day graticule; the time axis at y = 700, dated « 12 AOÛT … 18 AOÛT »; the PROMESSE, a 2 px ink
// line at x = 1180 (14 August 18:00) under its chip; and the ETA window, a 110 px band with 2 px edges, « OPTIMISTE » on
// its left edge, « PESSIMISTE » on its right edge and the « ETA » mark in its centre. `ToneLane` draws the score's held
// sine full width under the scope and the card.
//
// The band loses exactly two days (« perd deux jours », S01's « +2 J »), in two stages (tested):
//   0. At rest it spans 12 AOÛT 23:20 → 14 AOÛT 04:40: its right (pessimistic) edge is before the promise, on time.
//   1. On « perd deux jours » it slides 2 days − 2 × SHORTFALL (140 px) in 36 frames with the film's only in-out curve.
//      Its right edge crosses the promise exactly on S05.warn; the slide starts WARN_LEAD frames before that cue, which
//      puts its start 1.9 frames after S05.slide, on « perd ». It ends with the left edge SHORTFALL short of the promise:
//      the two days are not all lost yet, and by assessLateness the shipment is at risk, not late.
//   2. On « optimiste », a 12-frame nudge of 2 × SHORTFALL (40 px), same curve, starting 6 frames before S05.crit: its
//      midpoint puts the left edge on the promise on S05.crit, and it ends on 14 AOÛT 23:20, two days after it started.
//      Even the optimistic bound now misses the promise: EN RETARD (eta-engine.ts, assessLateness).
// Colour is an event (spec § 2): the band is drawn in neutral ink until S05.warn, then in warn, then in crit from
// S05.crit. The spec's resting "info" tint is not used: S05 has no info cue, so info would be a colour without its
// event and sound (spec § 2; Ruling R18).
import type {CSSProperties} from 'react';
import {interpolate} from 'remotion';
import {EASE_INOUT, EASE_OUT} from '../lib/easing';
import {palette, signal, type Theme} from '../theme/tokens';
import {Chip} from './Chip';
import {LABEL} from './typography';

export const AXIS_Y = 700;
export const PROMISE_X = 1180;
/** Width of the ETA window, px (spec). */
export const BAND_WIDTH = 110;
/** How far the left edge stays short of the promise after the first stage, px (brief). */
export const SHORTFALL = 20;
/** One day on the axis, px: the seven days 12 → 18 August sit in the 736 px screen with equal margins. */
export const DAY_PX = 90;
export const SLIDE_FRAMES = 36;
export const NUDGE_FRAMES = 12;
/** The two stages of the band's move (see the header): together, exactly two days. */
export const SLIDE_PX = 2 * DAY_PX - 2 * SHORTFALL;
export const NUDGE_PX = 2 * SHORTFALL;
/** Promise vibration (spec): 3 px at 12 Hz for 10 frames. */
export const SHAKE = {px: 3, hz: 12, frames: 10} as const;
const FPS = 30;

/** x of a date in August (day of month, hour), on the axis. */
export const dateX = (day: number, hour = 0): number => PROMISE_X + (((day - 14) * 24 + hour - 18) / 24) * DAY_PX;

/** Left edge of the band before it moves: two days before where it ends, SHORTFALL past the promise (12 AOÛT 23:20). */
export const START_LEFT = PROMISE_X + SHORTFALL - 2 * DAY_PX;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** The time t in [0, 1] at which the in-out curve reaches `y` (the curve is monotonic; bisection to float precision). */
const easeInverse = (y: number): number => {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (EASE_INOUT(mid) < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};

/** Frames from the start of the slide to the right edge reaching the promise (≈ 16.1: 50 px of the 140 px slide). */
export const WARN_LEAD = SLIDE_FRAMES * easeInverse((PROMISE_X - BAND_WIDTH - START_LEFT) / SLIDE_PX);

/** First frame of the slide, derived from S05.warn so that the right edge is on the promise exactly on that cue. */
export const slideStart = (warn: number): number => warn - WARN_LEAD;

export interface EtaCues { slide: number; warn: number; crit: number }

/** Left edge of the ETA band at local frame `f`. */
export const bandLeft = (f: number, {warn, crit}: EtaCues): number => {
  const first = EASE_INOUT(clamp01((f - slideStart(warn)) / SLIDE_FRAMES));
  const nudge = EASE_INOUT(clamp01((f - (crit - NUDGE_FRAMES / 2)) / NUDGE_FRAMES));
  return START_LEFT + SLIDE_PX * first + NUDGE_PX * nudge;
};

/** Width of a quarter-turned 24 px label, and its gap to its edge. */
const EDGE_LABEL = {width: 24, gap: 8} as const;

/**
 * Left x of the two quarter-turned edge labels. At rest the promise line lies at least 20 px from an edge (50 px right
 * of the band before the slide, 20 px inside its left edge after the slide, 20 px left of that edge after the nudge),
 * so each label hangs outside its edge. OPTIMISTE stays outside until S05.crit, where its edge is on the promise, then
 * moves inside over the second half of the nudge (it has to cross the line once; this way the crit frame itself is
 * clean). PESSIMISTE always hangs outside the right edge.
 */
export const edgeLabelX = (f: number, cues: EtaCues): {optimiste: number; pessimiste: number} => {
  const left = bandLeft(f, cues);
  const inside = EASE_OUT(clamp01((f - cues.crit) / (NUDGE_FRAMES / 2)));
  const outside = -EDGE_LABEL.gap - EDGE_LABEL.width;
  return {optimiste: left + outside + (EDGE_LABEL.gap - outside) * inside, pessimiste: left + BAND_WIDTH + EDGE_LABEL.gap};
};

export type BandTone = 'neutral' | 'warn' | 'crit';

export const bandTone = (f: number, {warn, crit}: {warn: number; crit: number}): BandTone =>
  f >= crit ? 'crit' : f >= warn ? 'warn' : 'neutral';

/** Horizontal offset of the promise line: 3 px at 12 Hz for 10 frames from S05.crit, starting at full swing. */
export const promiseShake = (f: number, crit: number): number => {
  const k = f - crit;
  if (k < 0 || k >= SHAKE.frames) return 0;
  return SHAKE.px * Math.cos((2 * Math.PI * SHAKE.hz * k) / FPS);
};

/**
 * The tone lane: the visual twin of the score's held D4 sine (spec § 4 S05, Son). The score starts the sine on
 * S05.slide, so the lane is a flat line until then and the sine swells in over `enter` frames; it follows the band and
 * bends one semitone up to E♭4; on S05.crit the retard's minor second joins it and the two close frequencies beat. It
 * runs full width, margin to margin, across the strip under the scope and the card, where « FAUSSE NOTE. » lands and
 * covers it; it scrolls linearly, like the tape. y is the centre line (the middle of the stamp's capitals), amp the
 * peak height.
 */
export const TRACE = {x0: 96, x1: 1824, y: 876, amp: 14, wavelength: 80, speed: 4, enter: 6, beatIn: 6} as const;
const SEMITONE = 2 ** (1 / 12);

/** Pitch ratio of the held sine: 1 (D4) until S05.slide, then up to a semitone (E♭4) on the slide's curve. */
export const tracePitch = (f: number, {slide}: {slide: number}): number =>
  SEMITONE ** EASE_INOUT(clamp01((f - slide) / SLIDE_FRAMES));

/** Height of the trace at x (px, up is positive). */
export const traceY = (x: number, f: number, cues: EtaCues): number => {
  const amp = TRACE.amp * EASE_OUT(clamp01((f - cues.slide) / TRACE.enter));
  if (amp === 0) return 0;
  const k = (2 * Math.PI) / TRACE.wavelength;
  const u = x - TRACE.speed * f;
  const pitch = tracePitch(f, cues);
  const held = Math.sin(k * pitch * u);
  const b = clamp01((f - cues.crit) / TRACE.beatIn);
  if (b === 0) return amp * held;
  // D against E♭: the held note and the note a semitone below it, mixed in over TRACE.beatIn frames.
  return amp * ((1 - b / 2) * held + (b / 2) * Math.sin(k * (pitch / SEMITONE) * u));
};

/** The scope screen: x from 880 to 1616 frames 12 → 18 August with the same margin on both sides. */
export const SCREEN = {x: 880, y: 160, width: 736, height: 602, radius: 14} as const;
const BAND_TOP = 340;
const PROMISE_TOP = 232;
const FIRST_DAY = 12;
const LAST_DAY = 18;

export interface OscilloscopeProps {
  theme: Theme;
  /** Local scene frame, already frozen by the caller if needed. */
  frame: number;
  cues: EtaCues;
  style?: CSSProperties;
}

const grow = (f: number, from: number, frames: number): number =>
  interpolate(f, [from, from + frames], [0, 1], {easing: EASE_OUT, extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

/** The tone lane (see TRACE), drawn margin to margin as the scope switches on. The caller cuts it when the stamp lands. */
export const ToneLane: React.FC<{theme: Theme; frame: number; cues: EtaCues}> = ({theme, frame: f, cues}) => {
  const end = TRACE.x0 + (TRACE.x1 - TRACE.x0) * grow(f, 0, 14);
  const points: string[] = [];
  for (let x = TRACE.x0; x <= end; x += 4) points.push(`${x.toFixed(1)} ${(TRACE.y - traceY(x, f, cues)).toFixed(2)}`);
  if (points.length < 2) return null;
  return (
    <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
      <path d={`M${points.join('L')}`} fill="none" stroke={palette(theme).muted} strokeWidth={2} strokeLinejoin="round" />
    </svg>
  );
};

export const Oscilloscope: React.FC<OscilloscopeProps> = ({theme, frame: f, cues, style}) => {
  const pal = palette(theme);
  const tone = bandTone(f, cues);
  const toneColor = tone === 'neutral' ? pal.ink : signal(theme, tone);
  const fillAlpha = tone === 'neutral' ? 0.06 : 0.14;
  const left = bandLeft(f, cues);
  const shake = promiseShake(f, cues.crit);
  const px = PROMISE_X + shake;

  // Build-in over the first beat and a half, while the clock flips.
  const screenIn = grow(f, 0, 8);
  const axisIn = grow(f, 0, 14);
  const labelsIn = grow(f, 6, 10);
  const promiseIn = grow(f, 8, 12);
  const chipIn = grow(f, 16, 10);
  const bandIn = grow(f, 20, 12);
  const bandLabelsIn = grow(f, 26, 10);

  const days: number[] = [];
  for (let d = FIRST_DAY; d <= LAST_DAY + 1; d++) days.push(d);
  const rows = [AXIS_Y - 90, AXIS_Y - 180, AXIS_Y - 270, AXIS_Y - 360, AXIS_Y - 450];
  const xL = SCREEN.x + 24;
  const xR = SCREEN.x + SCREEN.width - 24;
  const bandH = (AXIS_Y - BAND_TOP) * bandIn;
  const labelX = edgeLabelX(f, cues);
  const edgeLabel = (text: string, x: number, color: string): React.ReactNode => (
    // Rotated a quarter turn, reading upwards along the edge, its start 12 px above the axis.
    <div
      style={{
        ...LABEL, position: 'absolute', left: x, top: AXIS_Y - 12, color, opacity: bandLabelsIn,
        transform: 'rotate(-90deg)', transformOrigin: '0 0', lineHeight: '24px', height: 24,
      }}
    >
      {text}
    </div>
  );

  return (
    <div style={{position: 'absolute', left: 0, top: 0, width: 1920, height: 1080, ...style}}>
      {/* Screen and graticule */}
      <div
        style={{
          position: 'absolute', left: SCREEN.x, top: SCREEN.y, width: SCREEN.width, height: SCREEN.height,
          borderRadius: SCREEN.radius, background: pal.surface, border: `1px solid ${pal.line}`, opacity: screenIn,
        }}
      />
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
        <g opacity={screenIn} stroke={pal.line} strokeWidth={1}>
          {days.map((d) => (
            <line key={d} x1={dateX(d)} x2={dateX(d)} y1={SCREEN.y + 24} y2={AXIS_Y} />
          ))}
          {rows.map((y) => (
            <line key={y} x1={xL} x2={xR} y1={y} y2={y} />
          ))}
        </g>
        {/* Axis, drawn left to right, with a tick at every midnight */}
        <g stroke={pal.ink}>
          <line x1={xL} x2={xL + (xR - xL) * axisIn} y1={AXIS_Y} y2={AXIS_Y} strokeWidth={2} />
          {days.map((d) => (
            <line key={d} x1={dateX(d)} x2={dateX(d)} y1={AXIS_Y} y2={AXIS_Y + 12} strokeWidth={2} opacity={labelsIn} />
          ))}
        </g>
        {/* ETA window */}
        {bandH > 0 && (
          <g>
            <rect x={left} y={AXIS_Y - bandH} width={BAND_WIDTH} height={bandH} fill={toneColor} fillOpacity={fillAlpha} />
            <line x1={left + 1} x2={left + 1} y1={AXIS_Y - bandH} y2={AXIS_Y} stroke={toneColor} strokeWidth={2} />
            <line x1={left + BAND_WIDTH - 1} x2={left + BAND_WIDTH - 1} y1={AXIS_Y - bandH} y2={AXIS_Y} stroke={toneColor} strokeWidth={2} />
            <line
              x1={left + BAND_WIDTH / 2} x2={left + BAND_WIDTH / 2} y1={AXIS_Y - bandH} y2={AXIS_Y}
              stroke={toneColor} strokeWidth={1.5} strokeDasharray="6 6" opacity={bandLabelsIn}
            />
          </g>
        )}
        {/* Promise, grown up from the axis */}
        <line x1={px} x2={px} y1={AXIS_Y} y2={AXIS_Y - (AXIS_Y - PROMISE_TOP) * promiseIn} stroke={pal.ink} strokeWidth={2} />
        <rect x={px - 5} y={AXIS_Y - 5} width={10} height={10} fill={pal.ink} opacity={promiseIn} transform={`rotate(45 ${px} ${AXIS_Y})`} />
      </svg>

      {/* « 12 AOÛT … 18 AOÛT »: the two end days are named, centred in their day; the days between are ticks only
          (a day is 90 px and a dated label is 114 px, so naming every day would run the labels together). */}
      {[FIRST_DAY, LAST_DAY].map((d) => (
        <div
          key={d}
          style={{
            ...LABEL, position: 'absolute', top: AXIS_Y + 22, left: dateX(d) + DAY_PX / 2, transform: 'translateX(-50%)',
            color: pal.muted, opacity: labelsIn,
          }}
        >
          {`${d} AOÛT`}
        </div>
      ))}

      {/* Band labels */}
      {bandIn > 0 && (
        <>
          {edgeLabel('OPTIMISTE', labelX.optimiste, tone === 'crit' ? toneColor : pal.muted)}
          {edgeLabel('PESSIMISTE', labelX.pessimiste, tone === 'neutral' ? pal.muted : toneColor)}
          <div
            style={{
              ...LABEL, position: 'absolute', top: BAND_TOP - 40, left: left + BAND_WIDTH / 2, transform: 'translateX(-50%)',
              color: tone === 'neutral' ? pal.ink : toneColor, opacity: bandLabelsIn,
            }}
          >
            ETA
          </div>
        </>
      )}

      {/* Promise chip */}
      <div
        style={{
          position: 'absolute', left: px, top: PROMISE_TOP - 56 - 12 * (1 - chipIn), transform: 'translateX(-50%)',
          opacity: chipIn,
        }}
      >
        <Chip theme={theme} style={{borderColor: pal.ink}}>PROMESSE · 14 AOÛT 18:00</Chip>
      </div>
    </div>
  );
};
