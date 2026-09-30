// src/scenes/S13Clavier.tsx — S13 · Répartir : le clavier des fournisseurs (spec § 4 S13), 114-124 s, light.
// Five tall keys, one per supplier (SUP-A … SUP-E), under the order « 20 000 UNITÉS · 7 JOURS · PART MAX 50 % » + DÉMO
// (the pill covers every supplier id on screen). SUP-B carries its tag « MOINS CHER · 12 J · 75 % À L'HEURE ». The
// dashed cap « PLAFOND 50 % » is drawn across the keyboard on « commande ». On « solveur » (S13.timer) the chip
// « MILP · OR-TOOLS CBC » starts its stopwatch on the counterTicks rhythm and settles on « < 10 ms » on the last tick.
// On « tranche » (S13.chord) the solver plays its chord: SUP-A, SUP-C and SUP-D sink one 32nd apart (the fmChord
// roll) and fill with ink up to their share — quantity bars with no figure, all under the cap. On « cher »
// (S13.strike, crit) SUP-B takes the dead note: a thud, a crit strike and « ÉCARTÉ ». « trop lent » and « pas assez
// fiable » underline the two reasons on its tag.
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {Chip} from '../components/Chip';
import {DemoPill} from '../components/DemoPill';
import {KEY_BED, KEY_H, KEY_OVERHANG, KEY_W, keyLeft, Keys, type KeyState} from '../components/Keys';
import {LABEL, MONO} from '../components/typography';
import {quantize, roundHalfUp, SIXTEENTH} from '../lib/beat';
import {EASE_OUT} from '../lib/easing';
import {frDecimal, frInt, frPercent} from '../lib/format';
import {cueLocal, sceneDef, wordLocal} from '../lib/timeline';
import {palette, signal} from '../theme/tokens';

const S = 'S13' as const;
const THEME = sceneDef(S).theme;
const pal = palette(THEME);
const CRIT = signal(THEME, 'crit');

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
/** Ease-out progress of a move that starts on frame `at` (already visible on that frame) and lasts `frames` frames. */
const hit = (f: number, at: number, frames: number): number => (f < at ? 0 : EASE_OUT(clamp01((f - at + 1) / frames)));
/** Voice-driven entry: on the nearest sixteenth, 2 frames early (spec § 3.5). */
const wordAt = (screen: string): number => quantize(wordLocal(S, screen).start, '16th') - 2;

export const SUPPLIERS = ['SUP-A', 'SUP-B', 'SUP-C', 'SUP-D', 'SUP-E'] as const;
/** The solver's split of the order between the chosen suppliers (no figure on screen): SUP-A sits on the cap. */
export const SHARES: Readonly<Record<string, number>> = {'SUP-A': 0.5, 'SUP-C': 0.2, 'SUP-D': 0.3};
export const CAP_SHARE = 0.5;
/** counterTicks: 16 ticks per second for one second, the 16th one settles. */
const TICK = 30 / 16;
/** The stopwatch at rest, before the cue. */
const IDLE_TIME = `${frDecimal(0, 1)} ms`;

export const S13_T = (() => {
  const timer = cueLocal(S, 'S13.timer');
  const chord = cueLocal(S, 'S13.chord');
  const THIRTY_SECOND = SIXTEENTH / 2;
  return {
    /** The keys pop in on the downbeat. */
    keys: cueLocal(S, 'S13.keys'),
    /** « solveur »: the stopwatch starts. */
    timer,
    /** Its last tick: « < 10 ms ». */
    settle: timer + roundHalfUp(15 * TICK),
    /** « tranche »: the chord. */
    chord,
    /** The chord rolls upward in 32nds (fmChord): the chosen keys, left to right. */
    roll: {'SUP-A': chord, 'SUP-C': chord + roundHalfUp(THIRTY_SECOND), 'SUP-D': chord + roundHalfUp(2 * THIRTY_SECOND)} as Readonly<Record<string, number>>,
    /** « cher »: SUP-B is set aside. */
    strike: cueLocal(S, 'S13.strike'),
    cap: wordAt('commande'),
    ms: wordAt('millisecondes'),
    slow: wordAt('lent'),
    unreliable: wordAt('fiable'),
  };
})();

/** The stopwatch at `f`: null before the cue, a climbing « x,x ms » tick by tick, then « < 10 ms » on the last tick. */
export const timerText = (f: number): string | null => {
  if (f < S13_T.timer) return null;
  if (f >= S13_T.settle) return '< 10 ms';
  const k = Math.min(14, Math.floor((f - S13_T.timer) / TICK));
  return `${frDecimal((k + 1) * 0.6, 1)} ms`;
};

/** Every key's state at `f` (see components/Keys). */
export const keyStates = (f: number): KeyState[] =>
  SUPPLIERS.map((id, i) => {
    const T = S13_T;
    const at = T.roll[id];
    const state: KeyState = {label: id, enter: hit(f, T.keys + 2 * i, 10), press: 0, fill: 0, strike: 0, dim: 0};
    if (at !== undefined) {
      state.press = hit(f, at, 6);
      state.fill = SHARES[id] * hit(f, at + 2, 16);
    }
    if (id === 'SUP-B') {
      // The dead note: a short dip without a fill, then the key comes back up, struck and dimmed.
      const t = f - T.strike;
      state.press = t >= 0 && t < 10 ? 0.5 * (1 - t / 10) : 0;
      state.strike = hit(f, T.strike, 6);
      state.dim = hit(f, T.strike + 4, 10);
    }
    return state;
  });

// ---------------------------------------------------------------------------------------------------------------------
// Layout (screen px)

/** The keyboard's left edge sits KEY_OVERHANG inside the margin, so its key bed and cap line start on it. */
const KB = {x: 96 + KEY_OVERHANG, y: 372};
/** The solver block is centred on the keyboard, in the right-hand column. */
const SOLVER_TOP = KB.y + KEY_H / 2 - 112;
const B_CENTER = KB.x + keyLeft(1) + KEY_W / 2;
/** « ÉCARTÉ » sits in the upper third of SUP-B, clear of its name and across the strike. */
const STAMP_Y = KB.y + 0.28 * KEY_H;
const TAG_TOP = 256;
const RIGHT = 1824;

const Underlined: React.FC<{children: React.ReactNode; p: number}> = ({children, p}) => (
  <span style={{position: 'relative', display: 'inline-block'}}>
    {children}
    <span style={{position: 'absolute', left: 0, bottom: -9, height: 2, width: `${100 * p}%`, background: pal.ink}} />
  </span>
);

export const S13Clavier: React.FC = () => {
  const f = useCurrentFrame();
  const T = S13_T;
  const briefIn = hit(f, T.keys, 10);
  const tagIn = hit(f, T.keys + 14, 10);
  // The solver waits beside the keyboard from the start, its stopwatch parked at zero until « solveur ».
  const solverIn = hit(f, T.keys + 8, 10);
  const running = f >= T.timer;
  const timer = timerText(f) ?? IDLE_TIME;
  const settled = f >= T.settle;
  const msPop = f >= T.ms && f < T.ms + 8 ? 1 + 0.06 * Math.sin((Math.PI * (f - T.ms)) / 8) : 1;
  const stamp = hit(f, T.strike, 6);
  const [big, unit] = [timer.slice(0, -3), 'ms'];

  return (
    <AbsoluteFill style={{background: pal.bg}}>
      {/* The order: one line, with the pill that covers every supplier id in the scene. */}
      <div
        style={{
          ...LABEL, fontSize: 36, letterSpacing: '0.06em', position: 'absolute', left: 96, top: 112, height: 44, display: 'flex',
          alignItems: 'center', gap: 20, color: pal.ink, opacity: briefIn, transform: `translateY(${-10 * (1 - briefIn)}px)`,
        }}
      >
        {`${frInt(20000)} UNITÉS · 7 JOURS · PART MAX ${frPercent(50)}`}
        <DemoPill theme={THEME} />
      </div>

      {/* SUP-B's tag, hung above its key. */}
      <div style={{position: 'absolute', left: KB.x + keyLeft(1), top: TAG_TOP, opacity: tagIn, transform: `translateY(${-8 * (1 - tagIn)}px)`}}>
        <Chip theme={THEME} style={{background: pal.surface2}}>
          <span>
            MOINS CHER ·{' '}
            <Underlined p={hit(f, T.slow, 8)}>12 J</Underlined>
            {' '}·{' '}
            <Underlined p={hit(f, T.unreliable, 10)}>{`${frPercent(75)} À L'HEURE`}</Underlined>
          </span>
        </Chip>
        <div style={{position: 'absolute', left: KEY_W / 2 - 1, top: 44, width: 2, height: KB.y - KEY_BED - TAG_TOP - 44, background: pal.ink}} />
      </div>

      <Keys
        theme={THEME} keys={keyStates(f)} strikeColor={CRIT} style={{left: KB.x, top: KB.y}}
        cap={{
          share: CAP_SHARE, draw: hit(f, T.cap, 14),
          label: <span style={{...LABEL, color: pal.ink}}>PLAFOND {frPercent(50)}</span>,
        }}
      />

      {/* ÉCARTÉ: stamped over the struck key. */}
      {f >= T.strike && (
        <div
          style={{
            ...LABEL, fontSize: 28, position: 'absolute', left: B_CENTER, top: STAMP_Y, display: 'flex', alignItems: 'center',
            height: 48, padding: '0 14px', boxSizing: 'border-box', color: CRIT, border: `2.5px solid ${CRIT}`, borderRadius: 6,
            background: pal.surface2, opacity: Math.min(1, stamp * 2),
            transform: `translate(-50%, -50%) rotate(-7deg) scale(${1.3 - 0.3 * stamp})`,
          }}
        >
          ÉCARTÉ
        </div>
      )}

      {/* The solver and its stopwatch. */}
      {solverIn > 0 && (
        <div style={{position: 'absolute', right: 1920 - RIGHT, top: SOLVER_TOP, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 28, opacity: solverIn, transform: `translateY(${-10 * (1 - solverIn)}px)`}}>
          <Chip theme={THEME}>MILP · OR-TOOLS CBC</Chip>
          <div
            style={{
              fontFamily: MONO, fontWeight: 500, color: settled ? pal.ink : running ? pal.muted : pal.dim, display: 'flex', alignItems: 'baseline', gap: 18,
              fontVariantNumeric: 'tabular-nums', whiteSpace: 'pre', transformOrigin: '100% 80%', transform: `scale(${msPop})`,
            }}
          >
            <span style={{fontSize: 120, lineHeight: 1, letterSpacing: '-0.02em', wordSpacing: '-0.32em'}}>{big}</span>
            <span style={{fontSize: 48, lineHeight: 1}}>{unit}</span>
          </div>
          <div style={{width: 392, height: 2, background: pal.line, position: 'relative'}}>
            <div style={{position: 'absolute', right: 0, top: 0, height: 2, width: 392 * clamp01((f - T.timer) / (T.settle - T.timer)), background: pal.ink}} />
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};
