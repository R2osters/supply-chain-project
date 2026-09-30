// src/scenes/S01Contretemps.tsx — S01 · Contretemps, the hook (spec § 4 S01, 0-6 s, dark, no voice).
// Bar 1: the logo dot pulses on the four clicks and the count « 1 2 3 4 » ratchets under it. Bar 2: the dot glides to
// x = 220 on the downbeat and unrolls a 2 px trace to the right at 8 px per frame across a time grid (one 1 px line
// every 120 px = one beat), like a heart monitor: four live heartbeats land on four grid lines. Bar 3: the next grid
// line lights up with no beat, and 7 frames later (local frame 127, never quantised) the late crit spike lands 56 px
// past it, the image shakes and « +2 J » slams into the right third. The music stops there, so the tape stops there:
// only the resonance of the spike moves until the caption « Un retard, ça s'entend. » at 4,7 s.
// Every timed event is read from the S01 cues; the shake, the spike shapes and the geometry are exported for the tests
// and for S02, which picks the trace and the late spike up where this scene leaves them.
import {AbsoluteFill, interpolateColors, useCurrentFrame} from 'remotion';
import {EASE_OUT} from '../lib/easing';
import {cueLocal, sceneDef, seriesLocal} from '../lib/timeline';
import {palette, signal} from '../theme/tokens';
import {DemoPill} from '../components/DemoPill';
import {CONDENSED, LABEL, MONO} from '../components/typography';

const THEME = sceneDef('S01').theme;

export const S01_FRAMES = {
  clicks: seriesLocal('S01', 'S01.click'),
  pulses: seriesLocal('S01', 'S01.pulse'),
  missing: cueLocal('S01', 'S01.missing'),
  late: cueLocal('S01', 'S01.late'),
  caption: cueLocal('S01', 'S01.caption'),
} as const;

/** The logo dot's resting place in bar 1. */
export const CENTER = {x: 960, y: 540} as const;
/** The trace: starts at x = 220 on the first heartbeat and runs right at 8 px per frame (spec § 4 S01). */
export const TRACE = {x0: 220, y: 540, speed: 8} as const;
/** One grid line per beat: 15 frames × 8 px. */
export const GRID_STEP = 120;
const GRID_TOP = 340;
const GRID_BOTTOM = 740;
const GRID_LAST_X = 1824; // right safe margin
const DOT = 14;
/** The glide to x = 220 is the upbeat of bar 2: it lands on the first heartbeat. */
const GLIDE_FRAMES = 9;
/** Frames of one ratchet step of the count-in. */
const STEP_FRAMES = 6;
const DIGIT_Y = 612;

export type Shape = ReadonlyArray<readonly [number, number]>;
/** A heartbeat, as a trace deflection around its beat (dx, dy), 80 px high: Q dip, R peak on the beat, S dip. */
export const LIVE_SPIKE: Shape = [[-16, 0], [-7, 6], [0, -80], [6, 12], [13, 0]];
/** The late spike, 170 px high, jagged, with 3 sub-crests around the peak. */
export const CRIT_SPIKE: Shape = [[-36, 0], [-28, -44], [-22, -26], [-14, -98], [-8, -74], [0, -170], [7, -112], [12, -136], [19, 16], [34, 0]];
/** Image shake from the late spike: translateX 10, -8, 5, -2, 0 over 5 frames. */
export const SHAKE = [10, -8, 5, -2, 0] as const;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const ease = (f: number, from: number, frames: number): number => EASE_OUT(clamp01((f - from) / frames));

export const spikeHeight = (s: Shape): number => -Math.min(...s.map((p) => p[1]));
/** Crests other than the main peak: interior points higher than both neighbours. */
export const subCrests = (s: Shape): number =>
  s.filter((p, i) => i > 0 && i < s.length - 1 && p[1] < s[i - 1][1] && p[1] < s[i + 1][1]).length - 1;

/** x of the pen (the dot drawing the trace): 220 on the first heartbeat, 8 px per frame, stopped by the late spike. */
export const penX = (f: number): number => {
  const start = S01_FRAMES.pulses[0];
  return TRACE.x0 + TRACE.speed * (Math.min(Math.max(f, start), S01_FRAMES.late) - start);
};

/** The logo dot: centred in bar 1, gliding to the trace start on the upbeat, then the pen. */
export const dotAt = (f: number): {x: number; y: number} => {
  const land = S01_FRAMES.pulses[0];
  if (f >= land) return {x: penX(f), y: TRACE.y};
  const p = ease(f, land - GLIDE_FRAMES, GLIDE_FRAMES);
  return {x: p === 1 ? TRACE.x0 : CENTER.x + (TRACE.x0 - CENTER.x) * p, y: CENTER.y};
};

export const shakeX = (f: number): number => {
  const i = f - S01_FRAMES.late;
  return i >= 0 && i < SHAKE.length ? SHAKE[i] : 0;
};

/**
 * x of the count-in digit `k` (0-based): it appears under the dot on its click, steps one slot (120 px, one beat of
 * tape) left on each later click, and glides with the dot on the upbeat so that « 1 2 3 4 » lands exactly under the
 * four heartbeats of bar 2.
 */
export const digitX = (k: number, f: number): number => {
  const {clicks, pulses} = S01_FRAMES;
  let steps = 0;
  for (let j = k + 1; j < clicks.length; j++) steps += ease(f, clicks[j], STEP_FRAMES);
  const glide = ease(f, pulses[0] - GLIDE_FRAMES, GLIDE_FRAMES);
  const shift = TRACE.x0 - (CENTER.x - GRID_STEP * (clicks.length - 1));
  return CENTER.x - GRID_STEP * steps + shift * glide;
};

/**
 * Height factor of a spike born on `at`: exactly its charted height on the cue frame (80 px, 170 px), then a damped
 * ring — a short twitch for a heartbeat, a longer resonance for the late spike, the image of the sound that rings on.
 */
export const spikeGain = (f: number, at: number, resonance: boolean): number => {
  const t = f - at;
  if (t < 0) return 0;
  const [depth, decay, period] = resonance ? [0.14, 11, 7] : [0.12, 4, 6];
  return 1 + depth * Math.exp(-t / decay) * Math.sin((2 * Math.PI * t) / period);
};

const points = (s: Shape, x: number, gain: number): string => s.map(([dx, dy]) => `${x + dx},${TRACE.y + dy * gain}`).join(' ');

/** Flat pieces of the trace between the spikes' footprints, from the start to the pen. */
const flatPieces = (to: number, feet: Array<[number, number]>): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  let x: number = TRACE.x0;
  for (const [a, b] of [...feet].sort((p, q) => p[0] - q[0])) {
    if (a > x) out.push([x, Math.min(a, to)]);
    x = Math.max(x, b);
    if (x >= to) break;
  }
  if (x < to) out.push([x, to]);
  return out.filter(([a, b]) => b > a);
};

export const S01Contretemps: React.FC = () => {
  const f = useCurrentFrame();
  const pal = palette(THEME);
  const live = signal(THEME, 'live');
  const crit = signal(THEME, 'crit');
  const {clicks, pulses, missing, late, caption} = S01_FRAMES;
  const land = pulses[0];
  const dot = dotAt(f);
  const pen = penX(f);
  const lateShown = f >= late;

  // Bar 1: the dot pulses on each click (accent on 1), with an echo ring; smaller pulses on the heartbeats.
  const lastClick = [...clicks].reverse().find((c) => f >= c);
  const lastBeat = [...pulses].reverse().find((c) => f >= c);
  const clickPulse = lastClick === undefined || f >= land ? 0 : (lastClick === clicks[0] ? 0.9 : 0.55) * (1 - ease(f, lastClick, 8));
  const beatPulse = lastBeat === undefined ? 0 : 0.35 * (1 - ease(f, lastBeat, 8));
  const dotScale = 1 + clickPulse + beatPulse;

  // Bar 2: the grid (one line per beat, all the expected beats ahead of the pen), the trace and its spikes.
  const gridCount = Math.floor((GRID_LAST_X - TRACE.x0) / GRID_STEP) + 1;
  const missingX = penX(missing);
  const lateX = penX(late);
  const spikes = pulses.filter((p) => f >= p).map((p) => ({x: penX(p), at: p}));
  const feet: Array<[number, number]> = spikes.map((s) => [s.x + LIVE_SPIKE[0][0], s.x + LIVE_SPIKE[LIVE_SPIKE.length - 1][0]]);
  if (lateShown) feet.push([lateX + CRIT_SPIKE[0][0], lateX + CRIT_SPIKE[CRIT_SPIKE.length - 1][0]]);
  const flat = f >= land ? flatPieces(pen, feet) : [];

  // Bar 1 digits → bar 2 beat numbers under the heartbeats; bar 3's numbers wait, dim, on the next four grid lines.
  const digitOpacity = (k: number): number => ease(f, clicks[k], STEP_FRAMES);
  const digitColor = (k: number): string => {
    if (f < land) {
      const newest = [...clicks].reverse().findIndex((c) => f >= c);
      return clicks.length - 1 - newest === k ? pal.action : pal.muted;
    }
    // Dim until its heartbeat, lit on it, then settling to muted.
    return f < pulses[k] ? pal.dim : interpolateColors(ease(f, pulses[k], 10), [0, 1], [pal.action, pal.muted]);
  };
  const digitScale = (k: number): number => 1 + (f >= clicks[k] && f < land ? 0.18 * (1 - ease(f, clicks[k], 8)) : 0) - 0.3 * ease(f, land - GLIDE_FRAMES, GLIDE_FRAMES);
  const bar3 = Array.from({length: 4}, (_, k) => missingX + GRID_STEP * k);

  const grid = Array.from({length: gridCount}, (_, j) => TRACE.x0 + GRID_STEP * j);
  const litMissing = f >= missing ? ease(f, missing, 14) : -1;

  // The chart arrives with the glide, grid lines cascading left to right one frame apart, so it is in place on the
  // downbeat of bar 2.
  const glideStart = land - GLIDE_FRAMES;
  const labelIn = ease(f, glideStart, 10);
  const plus2J = lateShown ? ease(f, late, 8) : 0;
  const captionIn = ease(f, caption, 10);

  return (
    <AbsoluteFill style={{background: pal.bg}}>
      <AbsoluteFill style={{transform: `translateX(${shakeX(f)}px)`}}>
        <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
          <defs>
            <filter id="s01-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="5" />
            </filter>
          </defs>
          {f >= glideStart &&
            grid.map((x, j) => {
              const isMissing = x === missingX && litMissing >= 0;
              return (
                <line
                  key={x} x1={x} x2={x} y1={GRID_TOP} y2={GRID_BOTTOM}
                  stroke={isMissing ? interpolateColors(litMissing, [0, 1], [pal.action, pal.muted]) : pal.line}
                  strokeWidth={isMissing ? 2 : 1} opacity={ease(f, glideStart + j, 6)}
                />
              );
            })}
          {flat.map(([a, b]) => (
            <line key={a} x1={a} x2={b} y1={TRACE.y} y2={TRACE.y} stroke={pal.ink} strokeWidth={2} strokeLinecap="round" />
          ))}
          {spikes.map((s) => (
            <g key={s.at}>
              <polyline points={points(LIVE_SPIKE, s.x, spikeGain(f, s.at, false))} fill="none" stroke={live} strokeWidth={7} opacity={0.35 * (1 - 0.6 * ease(f, s.at, 20))} filter="url(#s01-glow)" strokeLinejoin="round" />
              <polyline points={points(LIVE_SPIKE, s.x, spikeGain(f, s.at, false))} fill="none" stroke={live} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          ))}
          {lateShown && (
            <g>
              <circle cx={lateX} cy={TRACE.y} r={DOT / 2 + 110 * ease(f, late, 20)} fill="none" stroke={crit} strokeWidth={1.5} opacity={0.7 * (1 - ease(f, late, 20))} />
              <polyline points={points(CRIT_SPIKE, lateX, spikeGain(f, late, true))} fill="none" stroke={crit} strokeWidth={9} opacity={0.4} filter="url(#s01-glow)" strokeLinejoin="round" />
              <polyline points={points(CRIT_SPIKE, lateX, spikeGain(f, late, true))} fill="none" stroke={crit} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          )}
          {clicks.map((c, i) =>
            f >= c && f < c + 20 ? (
              <circle
                key={c} cx={dot.x} cy={dot.y} r={DOT / 2 + (i === 0 ? 64 : 40) * ease(f, c, 18)} fill="none" stroke={pal.action}
                strokeWidth={1.5} opacity={0.55 * (1 - ease(f, c, 18))}
              />
            ) : null,
          )}
        </svg>

        {/* Count-in, then beat numbers of bars 2 and 3 */}
        {clicks.map((c, k) =>
          f >= c ? (
            <div
              key={c}
              style={{
                ...LABEL, fontSize: 40, letterSpacing: 0, position: 'absolute', left: digitX(k, f) - 40, width: 80, textAlign: 'center',
                top: DIGIT_Y - 20 - 14 * (1 - digitOpacity(k)), color: digitColor(k), opacity: digitOpacity(k),
                transform: `scale(${digitScale(k)})`,
              }}
            >
              {k + 1}
            </div>
          ) : null,
        )}
        {f >= glideStart &&
          bar3.map((x, k) => (
            <div
              key={x}
              style={{
                ...LABEL, fontSize: 40, letterSpacing: 0, position: 'absolute', left: x - 40, width: 80, textAlign: 'center', top: DIGIT_Y - 20,
                color: k === 0 && litMissing >= 0 ? interpolateColors(litMissing, [0, 1], [pal.action, pal.muted]) : pal.line,
                opacity: ease(f, glideStart + 4 + k, 8), transform: 'scale(0.7)',
              }}
            >
              {k + 1}
            </div>
          ))}

        {/* The shipment this signal belongs to */}
        <div
          style={{
            position: 'absolute', left: TRACE.x0, top: 262 + 12 * (1 - labelIn), opacity: labelIn,
            display: 'flex', alignItems: 'center', gap: 20,
          }}
        >
          <span style={{...LABEL, fontSize: 28, color: pal.muted}}>
            <span style={{color: pal.ink}}>SHP-0142</span> · EN ROUTE · ETA 14 AOÛT 18:00
          </span>
          <DemoPill theme={THEME} />
        </div>

        {/* The logo dot: metronome, then pen */}
        <div
          style={{
            position: 'absolute', left: dot.x - DOT / 2, top: dot.y - DOT / 2, width: DOT, height: DOT, borderRadius: DOT / 2,
            background: pal.action, transform: `scale(${dotScale})`,
          }}
        />

        {lateShown && (
          <div
            style={{
              position: 'absolute', right: 96, top: 207, fontFamily: CONDENSED, fontWeight: 600, fontSize: 380, lineHeight: 1,
              letterSpacing: '-0.02em', color: crit, whiteSpace: 'nowrap', transformOrigin: '100% 85%',
              transform: `scale(${1.16 - 0.16 * plus2J})`,
            }}
          >
            +2 J
          </div>
        )}
        {f >= caption && (
          <div
            style={{
              position: 'absolute', right: 96, top: 596 + 10 * (1 - captionIn), opacity: captionIn,
              fontFamily: MONO, fontWeight: 500, fontSize: 28, lineHeight: 1, color: pal.ink, whiteSpace: 'nowrap',
            }}
          >
            Un retard, ça s'entend.
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
