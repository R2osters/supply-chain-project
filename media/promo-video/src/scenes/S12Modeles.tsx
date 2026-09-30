// src/scenes/S12Modeles.tsx — S12 · Prévoir : la bataille des modèles (spec § 4 S12), 104-114 s, light, COUPLET 3.
// Top: two years of daily demand (weekly ripple, annual swell) draw themselves in like tape; the walk-forward validation
// is drawn over it — the « ENTRAÎNEMENT » zone grows and the « TEST » window ratchets one fold per step (S12.step.1-3).
// On every step a playhead sweeps the test window while the six lanes play one sixteenth apart (the modelRun
// arpeggio): each meter kicks on its note and the running WAPE (header « WAPE MOYEN · PAS k/3 ») rolls on its
// odometer (Counter, one column per digit). On « précis » (S12.sort, ok) the rows FLIP into the final ranking of
// CONCEPT.fr.md over 18 frames, the others giving way under the winner, which flashes ok; « ✓ SÉLECTIONNÉ » lands once
// the counters have settled. The selected model then draws its forecast past the last day. On « compliqué » (S12.dim)
// GRADIENT_BOOSTING fades. Ghost word « WAPE ». Chip « OPTIMISER · PRÉVISION · VALIDATION GLISSANTE » + DÉMO.
import {Fragment} from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {Chip} from '../components/Chip';
import {DemoPill, PILL} from '../components/DemoPill';
import {Check} from '../components/Glyphs';
import {VuLane} from '../components/VuLane';
import {CONDENSED, LABEL, MONO} from '../components/typography';
import {FRAMES_PER_BEAT, roundHalfUp, SIXTEENTH} from '../lib/beat';
import {EASE_OUT} from '../lib/easing';
import {rand} from '../lib/prng';
import {cueLocal, sceneDef, seriesLocal} from '../lib/timeline';
import {Counter} from '../rb/Counter';
import {SplitText} from '../rb/SplitText';
import {palette, signal} from '../theme/tokens';

const S = 'S12' as const;
const THEME = sceneDef(S).theme;
const pal = palette(THEME);
const OK = signal(THEME, 'ok');

// ---------------------------------------------------------------------------------------------------------------------
// Maths

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, p: number): number => (p >= 1 ? b : a + (b - a) * p);
/** Ease-out progress of a move of `frames` frames that starts at `from`, clamped to 0..1. */
const ease = (f: number, from: number, frames: number): number => EASE_OUT(clamp01((f - from) / frames));

// ---------------------------------------------------------------------------------------------------------------------
// The models and their scores

/** The six models, in the order of their meters (spec § 4 S12, and the modelRun arpeggio D E F G A C). */
export const MODELS = ['NAIVE', 'SEASONAL_NAIVE', 'MOVING_AVERAGE', 'EXPONENTIAL_SMOOTHING', 'HOLT_WINTERS', 'GRADIENT_BOOSTING'] as const;
export type Model = (typeof MODELS)[number];

/**
 * Running WAPE after each of the three walk-forward steps (the mean over the folds scored so far). The last column is
 * the final table of CONCEPT.fr.md § 3.1 (spec § 4 S12). The complex model leads the first folds and falls behind out of
 * sample, which is what the voice says: « le plus précis gagne, pas le plus compliqué ».
 */
export const WAPE: Record<Model, readonly [number, number, number]> = {
  NAIVE: [31.52, 30.21, 29.38],
  SEASONAL_NAIVE: [27.9, 26.48, 25.74],
  MOVING_AVERAGE: [29.44, 27.93, 27.07],
  EXPONENTIAL_SMOOTHING: [30.06, 28.85, 28.11],
  HOLT_WINTERS: [25.61, 24.66, 24.13],
  GRADIENT_BOOSTING: [23.87, 24.38, 24.72],
};

/** Final ranking, best first (lowest final WAPE). */
export const FINAL_RANKING: readonly Model[] = [...MODELS].sort((a, b) => WAPE[a][2] - WAPE[b][2]);
const RANK: Record<Model, number> = Object.fromEntries(FINAL_RANKING.map((m, r) => [m, r])) as Record<Model, number>;
const WINNER = FINAL_RANKING[0];
const DIMMED: Model = 'GRADIENT_BOOSTING';

// ---------------------------------------------------------------------------------------------------------------------
// Time

export const ROLL_FRAMES = 12;
export const FLIP_FRAMES = 18;
/** The test window ratchets like the sequencer arm (spec § 3.5): one step in 6 frames, from the cue. */
const RATCHET_FRAMES = 6;
/** Six lanes, one sixteenth apart: the playhead crosses the test window over those six sixteenths. */
const SWEEP_FRAMES = 6 * SIXTEENTH;

export const S12_T = (() => {
  const steps = seriesLocal(S, 'S12.step');
  const sort = cueLocal(S, 'S12.sort');
  return {
    /** Walk-forward steps (the modelRun arpeggio). */
    steps,
    /** « précis »: the rows re-rank, the winner flashes ok. */
    sort,
    flipEnd: sort + FLIP_FRAMES,
    /**
     * « ✓ SÉLECTIONNÉ » lands once the last roll has settled (the last step shares its frame with the sort), so the
     * winner never carries the pill while its counter still reads worse than another (still inside « gagne »).
     */
    selected: Math.max(sort, steps[steps.length - 1] + ROLL_FRAMES),
    /** « compliqué »: GRADIENT_BOOSTING fades. */
    dim: cueLocal(S, 'S12.dim'),
    /** The demand line draws itself in over the frames before the first step. */
    drawEnd: steps[0] - 2,
  };
})();

/** Frames at which lane `i` plays, one per step: the arpeggio puts the six lanes one sixteenth apart. */
export const noteFrames = (i: number): number[] => S12_T.steps.map((s) => s + roundHalfUp(i * SIXTEENTH));

/** The WAPE lane `i` shows at frame `f`: 0 until the first step, then a 12-frame ease-out roll at each step. */
export const wapeAt = (i: number, f: number): number => {
  const series = WAPE[MODELS[i]];
  let v = 0;
  S12_T.steps.forEach((s, k) => {
    if (f >= s) v = lerp(k === 0 ? 0 : series[k - 1], series[k], ease(f, s, ROLL_FRAMES));
  });
  return v;
};

/** Steps scored so far at `f` (0 before the first): the running WAPE is the mean over these folds. */
export const stepsDone = (f: number): number => S12_T.steps.filter((s) => f >= s).length;

/** Column header: the counters are a running mean that follows the TEST window, « PAS k/3 ». */
export const wapeHeader = (f: number): string => `WAPE MOYEN · PAS ${stepsDone(f)}/${S12_T.steps.length}`;

/** The four digits of a WAPE on the display (tens, units, tenths, hundredths), rounded half up to the hundredth. */
export const wapeDigits = (v: number): number[] => {
  const u = roundHalfUp(v * 100);
  return [Math.floor(u / 1000) % 10, Math.floor(u / 100) % 10, Math.floor(u / 10) % 10, u % 10];
};

/**
 * How far off its line a landing digit may sit, in rows (0.15 × 36 px ≈ 5 px): its neighbour then stays more than
 * 30 px away, outside the cell, so a column never shows two digits at once.
 */
export const LAND = 0.15;

/**
 * Odometer position (0..10, digit = position mod 10) of the four columns of lane `i` at `f`. A roll moves each column
 * from its old digit to its new one in the direction of the change (up when the WAPE rises), easing over ROLL_FRAMES,
 * so every column travels less than one turn. (A single value interpolated through the odometer made the hundredths
 * spin through 50-150 digits in 12 frames and stacked half digits on every frame.) On the way the column clicks
 * through whole digits; the new digit lands with a short slide of at most LAND rows from the side it rolls in from.
 */
export const wapeColumns = (i: number, f: number): number[] => {
  const series = WAPE[MODELS[i]];
  const k = stepsDone(f) - 1;
  if (k < 0) return [0, 0, 0, 0];
  const from = wapeDigits(k === 0 ? 0 : series[k - 1]);
  const to = wapeDigits(series[k]);
  const dir = series[k] >= (k === 0 ? 0 : series[k - 1]) ? 1 : -1;
  const p = ease(f, S12_T.steps[k], ROLL_FRAMES);
  return from.map((a, c) => {
    if (p >= 1) return to[c];
    const end = a + dir * ((dir * (to[c] - a) + 10) % 10);
    const pos = a + (end - a) * p;
    const whole = Math.round(pos);
    const shown = whole === end ? end + Math.min(LAND, Math.max(-LAND, pos - end)) : whole;
    return ((shown % 10) + 10) % 10;
  });
};

/** How full a meter is for a WAPE: the more precise, the louder (spec § 4 S12, « plus forte s'il est plus précis »). */
export const levelOf = (wape: number): number => clamp01((34 - wape) / 10);

/** Meter level of lane `i`: dark until its first note, it kicks on every note and eases onto the running score. */
export const meterLevel = (i: number, f: number): number => {
  const series = WAPE[MODELS[i]];
  const notes = noteFrames(i);
  let level = 0;
  let last = -Infinity;
  notes.forEach((n, k) => {
    if (f < n) return;
    level = lerp(k === 0 ? 0 : levelOf(series[k - 1]), levelOf(series[k]), ease(f, n, 8));
    last = n;
  });
  const kick = Number.isFinite(last) ? 0.14 * Math.exp(-(f - last) / 4) : 0;
  return clamp01(level + kick);
};

/** Row slot of lane `i` (0 = top): spec order until the sort, then an 18-frame ease-out FLIP into the ranking. */
export const rowSlot = (i: number, f: number): number => lerp(i, RANK[MODELS[i]], ease(f, S12_T.sort, FLIP_FRAMES));

/** The winner flashes ok twice from the sort cue, then holds ok (the bell lands on the second flash). */
export const winnerOk = (f: number): boolean => {
  const t = f - S12_T.sort;
  return t >= 0 && (t < 6 || t >= 10);
};

/** GRADIENT_BOOSTING fades on « compliqué »; every other row stays at full strength. */
export const rowOpacity = (i: number, f: number): number => (MODELS[i] === DIMMED ? 1 - 0.62 * ease(f, S12_T.dim, 10) : 1);

/** Opacity of the rows that give way during the FLIP. */
export const FLIP_FADE = 0.35;
/**
 * The FLIP's rows cross each other (NAIVE falls five slots, HOLT_WINTERS and GRADIENT_BOOSTING rise four) while
 * 0.1 < FLIP progress < 0.9. Over that stretch every row but the winner steps back to FLIP_FADE, so no two labels or
 * counters ever overprint at full ink; the winner travels at full strength on top. Rows are whole again as they land.
 */
export const flipFade = (i: number, f: number): number => {
  if (MODELS[i] === WINNER) return 1;
  const p = ease(f, S12_T.sort, FLIP_FRAMES);
  if (p <= 0 || p >= 1) return 1;
  return 1 - (1 - FLIP_FADE) * Math.min(1, p / 0.1, (1 - p) / 0.1);
};

/** Entrance of « ✓ SÉLECTIONNÉ » (0..1): nothing before S12_T.selected, then a 6-frame ease-out. */
export const selectedIn = (f: number): number => (f < S12_T.selected ? 0 : ease(f, S12_T.selected, 6));

// ---------------------------------------------------------------------------------------------------------------------
// The demand series and the walk-forward validation (screen px)

const CHART = {left: 96, top: 204, bottom: 476, right: 1824};
/** Two years of daily history end here; the forecast is drawn to the right of it. */
const HISTORY_END = 1488;
const DAYS = 728;
const DX = (HISTORY_END - CHART.left) / DAYS;
const FORECAST_DAYS = 150;
/** Weekday profile of the demand: busy end of week, quiet Sunday. */
const WEEK = [0.35, 0.2, 0.1, 0.25, 0.55, 0.8, -1.0];
const dayX = (d: number): number => CHART.left + d * DX;
const smooth = (d: number): number => 396 - 0.034 * d - 46 * Math.sin((2 * Math.PI * (d - 60)) / 364);
const demandY = (d: number): number => smooth(d) - 13 * WEEK[d % 7] - 9 * (rand(1204, d) - 0.5);
const forecastY = (d: number): number => smooth(d) - 6 * WEEK[d % 7];

const path = (points: Array<[number, number]>): string =>
  points.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
const HISTORY_PATH = path(Array.from({length: DAYS + 1}, (_, d) => [dayX(d), demandY(d)]));
const FORECAST = Array.from({length: FORECAST_DAYS + 1}, (_, k) => DAYS + k);
const FORECAST_PATH = path(FORECAST.map((d) => [dayX(d), forecastY(d)]));
const spread = (d: number): number => 7 + 0.11 * (d - DAYS);
const BAND_PATH = `${path(FORECAST.map((d) => [dayX(d), forecastY(d) - spread(d)]))}${[...FORECAST].reverse().map((d) => `L${dayX(d).toFixed(1)} ${(forecastY(d) + spread(d)).toFixed(1)}`).join('')}Z`;

/** Test windows of one quarter; the three folds end on the last day of history. */
const TEST_W = 91 * DX;
const foldX = (k: number): number => HISTORY_END - (3 - k) * TEST_W;

export interface Fold { trainEnd: number; testX: number; testW: number; appear: number; step: number }

/** The walk-forward state at `f`, or null before the first step: the window ratchets one fold per step. */
export const foldAt = (f: number): Fold | null => {
  const {steps} = S12_T;
  if (f < steps[0]) return null;
  let k = 0;
  steps.forEach((s, j) => {
    if (f >= s) k = j;
  });
  const p = ease(f, steps[k], RATCHET_FRAMES);
  const testX = k === 0 ? foldX(0) : lerp(foldX(k - 1), foldX(k), p);
  return {trainEnd: testX, testX, testW: TEST_W, appear: ease(f, steps[0], RATCHET_FRAMES), step: k};
};

// ---------------------------------------------------------------------------------------------------------------------
// Layout of the lanes

const LANE_TOP = 572;
const PITCH = 62;
const ROW_H = 44;
const RANK_X = 96;
const NAME_X = 146;
const METER_X = 548;
const METER_LEN = 792;
const COUNTER_R = 1512;
const TAG_X = 1552;

const Chart: React.FC<{f: number}> = ({f}) => {
  const T = S12_T;
  const draw = clamp01(f / T.drawEnd);
  const fold = foldAt(f);
  const pen = Math.min(DAYS, Math.floor(draw * DAYS));
  const forecast = clamp01((f - T.flipEnd) / 20);
  // The forecast's pen: it leads the line while it draws, then holds its end and pops on every beat (the held note).
  const penDay = DAYS + Math.min(FORECAST_DAYS, Math.floor(forecast * FORECAST_DAYS));
  const beatAge = f - Math.floor(f / FRAMES_PER_BEAT) * FRAMES_PER_BEAT;
  const penPop = forecast >= 1 && beatAge < 8 ? 1 + 0.25 * Math.sin((Math.PI * beatAge) / 8) : 1;
  const sweeps = T.steps.map((s) => (f >= s && f < s + SWEEP_FRAMES ? (f - s) / SWEEP_FRAMES : null));
  const sweep = sweeps.find((s) => s !== null) ?? null;
  const labelsIn = fold ? fold.appear : 0;
  return (
    <>
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
        {fold && (
          <>
            {/* ENTRAÎNEMENT: everything before the test window. */}
            <rect
              x={CHART.left} y={CHART.top} width={Math.max(0, (fold.trainEnd - CHART.left) * fold.appear)} height={CHART.bottom - CHART.top}
              fill={pal.surface} opacity={0.85}
            />
            <line x1={fold.trainEnd} x2={fold.trainEnd} y1={CHART.top} y2={CHART.bottom} stroke={pal.dim} strokeWidth={1} opacity={fold.appear} />
            {/* TEST: the window the models are scored on. */}
            <rect
              x={fold.testX + 1} y={CHART.top + 1} width={fold.testW - 2} height={CHART.bottom - CHART.top - 2} rx={4}
              fill={pal.surface2} fillOpacity={0.75} stroke={pal.ink} strokeWidth={2} opacity={fold.appear}
            />
          </>
        )}
        {/* The axis and the history. */}
        <line x1={CHART.left} x2={CHART.right} y1={CHART.bottom} y2={CHART.bottom} stroke={pal.dim} strokeWidth={1} />
        <path d={HISTORY_PATH} fill="none" stroke={pal.ink} strokeWidth={2} strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - draw} />
        {draw > 0 && draw < 1 && <circle cx={dayX(pen)} cy={demandY(pen)} r={6} fill={pal.ink} />}
        {/* The selected model's forecast, past the last day of history. */}
        {forecast > 0 && (
          <g>
            <clipPath id="s12-forecast">
              <rect x={HISTORY_END} y={CHART.top - 20} width={(FORECAST_DAYS * DX + 4) * forecast} height={CHART.bottom - CHART.top + 40} />
            </clipPath>
            <line x1={HISTORY_END} x2={HISTORY_END} y1={CHART.top} y2={CHART.bottom} stroke={pal.muted} strokeWidth={1.5} strokeDasharray="4 6" />
            <g clipPath="url(#s12-forecast)">
              <path d={BAND_PATH} fill={pal.line} />
              <path d={FORECAST_PATH} fill="none" stroke={pal.ink} strokeWidth={2} strokeDasharray="9 7" strokeLinejoin="round" />
            </g>
            <circle cx={dayX(penDay)} cy={forecastY(penDay)} r={6 * penPop} fill={pal.ink} />
          </g>
        )}
        {fold && sweep !== null && (
          <line x1={fold.testX + fold.testW * sweep} x2={fold.testX + fold.testW * sweep} y1={CHART.top - 10} y2={CHART.bottom + 10} stroke={pal.action} strokeWidth={2} />
        )}
      </svg>
      {fold && (
        <>
          <div style={{...LABEL, position: 'absolute', left: CHART.left + 18, top: CHART.top + 18, color: pal.muted, opacity: labelsIn}}>ENTRAÎNEMENT</div>
          <div style={{...LABEL, position: 'absolute', left: fold.testX + 16, top: CHART.top + 18, color: pal.ink, opacity: labelsIn}}>TEST</div>
        </>
      )}
      {forecast > 0 && (
        <div style={{...LABEL, position: 'absolute', right: 96, top: CHART.top + 18, color: pal.muted, opacity: forecast}}>{WINNER}</div>
      )}
    </>
  );
};

/** Counter size: one 36 px line box per digit cell, no vertical padding. */
const WAPE_FONT = 36;
/**
 * Each digit cell is clipped to its line box, and its top and bottom edges fade out, so a rolling column shows the digit
 * that is arriving and never a sliver of its neighbour (a settled Plex Mono numeral sits within 6-32 px of the box).
 */
const CELL_MASK = 'linear-gradient(to bottom, transparent 0px, #000 5px, #000 32px, transparent 36px)';

/** The running WAPE « 24,13 »: one React Bits Counter column per digit, so each column rolls its own short way. */
const WapeReadout: React.FC<{columns: number[]}> = ({columns}) => (
  <span style={{display: 'flex', fontSize: WAPE_FONT, lineHeight: 1, fontWeight: 500}}>
    {columns.map((position, c) => (
      <Fragment key={c}>
        {c === 2 && <span style={{height: WAPE_FONT, display: 'flex', alignItems: 'center'}}>,</span>}
        <Counter
          value={position} digits={1} fontSize={WAPE_FONT} fontWeight={500} gap={0} horizontalPadding={0} borderRadius={0} padding={0}
          gradientHeight={0} digitStyle={{overflow: 'hidden'}} counterStyle={{WebkitMaskImage: CELL_MASK, maskImage: CELL_MASK}}
        />
      </Fragment>
    ))}
  </span>
);

const Lane: React.FC<{f: number; i: number}> = ({f, i}) => {
  const model = MODELS[i];
  const y = LANE_TOP + rowSlot(i, f) * PITCH;
  const enter = ease(f, 2 + 1.5 * i, 10);
  const played = f >= noteFrames(i)[0];
  const isWinner = model === WINNER;
  const crest = isWinner && winnerOk(f);
  const tagIn = isWinner ? selectedIn(f) : 0;
  return (
    <div
      style={{
        position: 'absolute', left: 0, top: y, width: 1920, height: ROW_H, opacity: enter * rowOpacity(i, f) * flipFade(i, f),
        transform: `translateX(${-24 * (1 - enter)}px)`, zIndex: isWinner ? 1 : 0,
      }}
    >
      <div style={{...LABEL, position: 'absolute', left: NAME_X, top: 10, color: played ? pal.ink : pal.dim}}>{model}</div>
      <VuLane
        theme={THEME} label="" value={meterLevel(i, f) * 16} max={16} length={METER_LEN} thickness={28}
        peakColor={crest ? 'ok' : undefined} style={{position: 'absolute', left: METER_X, top: 8}}
      />
      <div style={{position: 'absolute', right: 1920 - COUNTER_R, top: (ROW_H - WAPE_FONT) / 2, fontFamily: MONO, color: played ? pal.ink : pal.dim}}>
        <WapeReadout columns={wapeColumns(i, f)} />
      </div>
      {tagIn > 0 && (
        <span
          style={{
            ...PILL, position: 'absolute', left: TAG_X, top: 4, gap: 8, color: OK, border: `1.5px solid ${OK}`,
            background: 'rgb(63 138 92 / 0.08)', opacity: tagIn, transform: `translateX(${-16 * (1 - tagIn)}px)`,
          }}
        >
          <Check size={24} color={OK} />
          SÉLECTIONNÉ
        </span>
      )}
    </div>
  );
};

export const S12Modeles: React.FC = () => {
  const f = useCurrentFrame();
  const T = S12_T;
  const chipIn = ease(f, 0, 10);
  const headIn = ease(f, 10, 10);
  const ranksIn = ease(f, T.sort + 8, 8);
  return (
    <AbsoluteFill style={{background: pal.bg}}>
      {/* Ghost word, behind everything. */}
      <SplitText
        words={[{text: 'WAPE', at: 4}]} frame={f} mode="chars" charStagger={2} rise={60} duration={14} overshoot={1} tag="div" textAlign="right"
        style={{
          position: 'absolute', right: 80, top: 486, fontFamily: CONDENSED, fontWeight: 600, fontSize: 440, lineHeight: 1,
          letterSpacing: '-0.02em', color: pal.surface, whiteSpace: 'nowrap',
        }}
      />

      <div style={{position: 'absolute', left: 96, top: 112, display: 'flex', alignItems: 'center', gap: 16, opacity: chipIn, transform: `translateY(${-10 * (1 - chipIn)}px)`}}>
        <Chip theme={THEME}>OPTIMISER · PRÉVISION · VALIDATION GLISSANTE</Chip>
        <DemoPill theme={THEME} />
      </div>

      <Chart f={f} />

      <div style={{...LABEL, position: 'absolute', right: 1920 - COUNTER_R, top: LANE_TOP - 44, color: pal.muted, opacity: headIn}}>{wapeHeader(f)}</div>
      {Array.from({length: 6}, (_, r) => (
        <div key={r} style={{...LABEL, position: 'absolute', left: RANK_X, top: LANE_TOP + r * PITCH + 10, color: pal.dim, opacity: ranksIn}}>
          {String(r + 1).padStart(2, '0')}
        </div>
      ))}
      {MODELS.map((_, i) => (
        <Lane key={i} f={f} i={i} />
      ))}
    </AbsoluteFill>
  );
};
