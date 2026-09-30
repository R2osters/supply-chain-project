// src/scenes/S17Reprise.tsx — S17 · Reprise, 154-164 s, dark (spec § 4 S17).
// The ring comes back in full view at double tempo: the arm ratchets two cells per beat. Its four stations hang on the
// diagonals this time, so the giant kinetic lines can cross the middle of the frame between them. Three new demo
// shipments (SHP-0217, SHP-0309, SHP-0388, each a container glyph with its violet demo dot) hop from station to station,
// one station per beat: SUIVRE lights crit (the delay is heard), OPTIMISER warn (the risk), RECOMMANDATION ok (the
// answer), HUMAIN live (it runs) — one station and one colour at a time, each on its own cue. The lines, Plex Condensed
// 200 px, cut in on their cues and rise word by word on the voice: « LE SUIVI ENTEND. » → « L'OPTIMISATION PROPOSE. »
// → « VOUS DÉCIDEZ. ». On « décidez » the big button comes to the centre; the cursor glides onto it, it fills over the
// beat, and the click lands on frame 4860 exactly, with the S07 choreography: press 0.96, shockwave 0 → 700 px, punch
// zoom 1 → 1.03 → 1. The arm stops at 12 o'clock on the click and the ring flashes ink. On the last beat everything
// retires but the dot the button collapses into, at the centre of the frame, where the coda picks it up.
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {Button} from '../components/Button';
import {ContainerGlyph} from '../components/ContainerGlyph';
import {Cursor} from '../components/Cursor';
import {DemoPill} from '../components/DemoPill';
import {CELLS, LoopSequencer, RING_CENTER, ringPoint, STEP_DEG} from '../components/LoopSequencer';
import {CONDENSED, LABEL} from '../components/typography';
import {FRAMES_PER_BEAT, quantize} from '../lib/beat';
import {EASE_EXIT} from '../lib/easing';
import {cue, cueLocal, sceneDef, sceneFrames, seriesLocal, wordLocal} from '../lib/timeline';
import {DecryptedText} from '../rb/DecryptedText';
import {SplitText, type SplitWord} from '../rb/SplitText';
import {palette, SHADOW, signal, type SignalColor} from '../theme/tokens';
import {lerp, lerpPoint, pop, ramp, Skeleton, SMALL_PILL, StationCard, STATION_H, STATION_W, type Point, type Rect} from './refrain';
import {DOT_HOME} from './S18Coda';

const S = 'S17' as const;
const theme = sceneDef(S).theme;
const pal = palette(theme);
const FRAMES = sceneFrames(S);
const SPEED = 2;
const DIGITS = '0123456789';
/** The demo IDs share this prefix; only their digits roll when a station changes shipment. */
const ID_PREFIX = 'SHP-0';

/** Voice-driven entry: on the nearest sixteenth, 2 frames early (spec § 3.5). */
const wordAt = (screen: string): number => quantize(wordLocal(S, screen).start, '16th') - 2;

// ---------------------------------------------------------------------------------------------------------------------
// Stations on the diagonals

/** Radius the shipments ride at, just inside the ring line, so the lit cell stays visible beside them. */
const TOKEN_R = 322;
const CARD_GAP = {x: 28, y: 20};

export interface StationDef { title: string; angle: number; anchor: Point; card: Rect }

const station = (title: string, angle: number): StationDef => {
  const onRing = ringPoint(angle);
  const right = Math.sin((angle * Math.PI) / 180) > 0;
  const upper = Math.cos((angle * Math.PI) / 180) > 0;
  return {
    title,
    angle,
    anchor: ringPoint(angle, TOKEN_R),
    card: {
      x: right ? onRing.x + CARD_GAP.x : onRing.x - CARD_GAP.x - STATION_W,
      y: upper ? onRing.y - CARD_GAP.y - STATION_H : onRing.y + CARD_GAP.y,
      w: STATION_W,
      h: STATION_H,
    },
  };
};

/** The loop's four stations (the S06 world), clockwise from the top left. */
export const STATIONS: readonly StationDef[] = [
  station('SUIVRE · OBSERVE', 315),
  station('OPTIMISER · RISQUE', 45),
  station('RECOMMANDATION', 135),
  station('HUMAIN · DÉCIDE', 225),
];

export const SHIPMENTS = ['SHP-0217', 'SHP-0309', 'SHP-0388'] as const;

export interface Arrival { at: number; station: number; shipment: number; color: SignalColor }
/** One arrival per station cue: shipment k covers cues 4k+1 … 4k+4, SUIVRE → OPTIMISER → RECOMMANDATION → HUMAIN. */
export const ARRIVALS: readonly Arrival[] = seriesLocal(S, 'S17.station').map((at, i) => ({
  at,
  station: i % STATIONS.length,
  shipment: Math.floor(i / STATIONS.length),
  color: cue(`S17.station.${i + 1}`).color as SignalColor,
}));

// ---------------------------------------------------------------------------------------------------------------------
// Lines

const LINE_WORDS: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
  [['Le', 'LE'], ['suivi', 'SUIVI'], ['entend', 'ENTEND.']],
  [["L'optimisation", "L'OPTIMISATION"], ['propose', 'PROPOSE.']],
  [['vous', 'VOUS'], ['décidez', 'DÉCIDEZ.']],
];

export interface KineticLine { from: number; words: SplitWord[] }
/** Each line cuts in on its cue; a word rises on its voice word, never before its line. */
export const LINES: readonly KineticLine[] = LINE_WORDS.map((ws, k) => {
  const at = cueLocal(S, `S17.line${k + 1}`) - 2;
  const words = ws.map(([spoken, text]) => ({text, at: Math.max(wordAt(spoken), at)}));
  return {from: words[0].at, words};
});

/** Index of the line on screen (each one replaces the previous on a hard cut), or null before the first. */
export const lineAt = (f: number): number | null => {
  let k: number | null = null;
  LINES.forEach((l, i) => {
    if (f >= l.from) k = i;
  });
  return k;
};

// ---------------------------------------------------------------------------------------------------------------------
// Timings

export const S17_T = (() => {
  const click = cueLocal(S, 'S17.click');
  const buttonIn = wordAt('décidez');
  return {
    hold: cueLocal(S, 'S17.hold'),
    click,
    /** « Sur « vous décidez », le bouton arrive au centre » */
    buttonIn,
    cursorIn: buttonIn + 12,
    /** « Sur le dernier temps, tout se retire » */
    retire: FRAMES - FRAMES_PER_BEAT,
  };
})();

/** The arm runs at double tempo and stops at 12 o'clock on the click (the loop closes on the decision). */
export const s17ArmFrame = (f: number): number => Math.min(f, S17_T.click);

/** The station lit at `f`: the latest arrival, for one beat. */
export const litStation = (f: number): {station: number; shipment: number; color: SignalColor; since: number} | null => {
  const a = [...ARRIVALS].reverse().find((x) => f >= x.at && f < x.at + FRAMES_PER_BEAT);
  return a ? {station: a.station, shipment: a.shipment, color: a.color, since: a.at} : null;
};

const ENTER = 6;
const HOP = 8;
const LEAVE = 8;

export interface TokenState { x: number; y: number; scale: number; opacity: number }

/**
 * Shipment `k`'s glyph: it appears on SUIVRE, hops a quarter turn clockwise into each next station (ease-out, landing
 * on the cue), and leaves HUMAIN when the next shipment reaches SUIVRE; the last one stays until the retire.
 */
export const tokenAt = (k: number, f: number): TokenState | null => {
  const mine = ARRIVALS.filter((a) => a.shipment === k);
  const first = mine[0];
  const leave = k < SHIPMENTS.length - 1 ? mine[mine.length - 1].at + FRAMES_PER_BEAT : Infinity;
  if (f < first.at - ENTER || f >= leave + LEAVE) return null;
  const deg = mine.slice(1).reduce((d, a) => d + 90 * ramp(f, a.at - HOP, HOP), STATIONS[first.station].angle);
  const out = f >= leave ? ramp(f, leave, LEAVE, EASE_EXIT) : 0;
  const p = ringPoint(deg, TOKEN_R + 60 * out);
  return {x: p.x, y: p.y, scale: (f < first.at ? ramp(f, first.at - ENTER, ENTER) : 1) * (1 - 0.6 * out), opacity: 1 - out};
};

// ---------------------------------------------------------------------------------------------------------------------
// The click (the S07 choreography)

export const holdFill17 = (f: number): number => Math.min(1, Math.max(0, (f - S17_T.hold) / (S17_T.click - S17_T.hold)));

export interface ClickFx { pressed: number; zoom: number; wave: {radius: number; opacity: number; width: number} | null }
const WAVE_FRAMES = 18;
const WAVE_RADIUS = 700;
const PUNCH = 0.03;
const PUNCH_FRAMES = 12;

/** Press 0.96, shockwave 0 → 700 px and punch zoom 1 → 1.03 → 1, all at their peak on the click frame. */
export const clickFx17 = (f: number): ClickFx => {
  const t = f - S17_T.click;
  if (t < 0) return {pressed: 0, zoom: 1, wave: null};
  const pressed = t < 2 ? 1 : t < PUNCH_FRAMES ? 1 - ramp(t, 2, PUNCH_FRAMES - 2) : 0;
  const zoom = t < PUNCH_FRAMES ? 1 + PUNCH * (1 - ramp(t, 0, PUNCH_FRAMES)) : 1;
  const wave = t <= WAVE_FRAMES ? {radius: WAVE_RADIUS * ramp(t, 0, WAVE_FRAMES), opacity: 1 - t / WAVE_FRAMES, width: lerp(6, 1.5, t / WAVE_FRAMES)} : null;
  return {pressed, zoom, wave};
};

// ---------------------------------------------------------------------------------------------------------------------
// Layout

const BUTTON: Rect = {x: DOT_HOME.x - 280, y: DOT_HOME.y - 60, w: 560, h: 120};
/** Top of each line's box: lines 1 and 2 centred on the frame, line 3 above the button. */
const LINE_TOP = [452, 364, 277] as const;
const LINE_HEIGHT = 176;
const HUB_MASK = 150;
/** Opacity of the ring behind the kinetic lines (the drop keeps it at 30 %, S08). */
const RING_DIM = 0.3;
const CELL = {w: 28, h: 12};
const DOT = 14;

const cellOf = (angle: number): number => Math.round(((angle % 360) + 360) % 360 / STEP_DEG) % CELLS;

/** The station's status dot: a ring at rest, the colour of the arrival (with a pop and a ripple) for its beat. */
const StatusDot: React.FC<{f: number; lit: {color: SignalColor; since: number} | null}> = ({f, lit}) => {
  if (!lit) return <span style={{width: 14, height: 14, borderRadius: 7, boxSizing: 'border-box', border: `2px solid ${pal.dim}`, flex: 'none'}} />;
  const t = f - lit.since;
  const ripple = Math.min(1, t / 12);
  const c = signal(theme, lit.color);
  const d = 14 * (1 + 1.6 * ripple);
  return (
    <span style={{position: 'relative', width: 14, height: 14, flex: 'none'}}>
      {t < 12 && (
        <span
          style={{
            position: 'absolute', left: 7 - d / 2, top: 7 - d / 2, width: d, height: d, borderRadius: '50%', boxSizing: 'border-box',
            border: `2px solid ${c}`, opacity: 1 - ripple,
          }}
        />
      )}
      <span style={{position: 'absolute', inset: 0, borderRadius: 7, background: c, transform: `scale(${pop(f, lit.since)})`}} />
    </span>
  );
};

/** The shipment shown in station `s`: the last one that reached it, decrypting from the one before. */
const StationRow: React.FC<{f: number; s: number}> = ({f, s}) => {
  const visits = ARRIVALS.filter((a) => a.station === s && f >= a.at);
  const last = visits[visits.length - 1];
  if (!last) return <Skeleton frame={f} width={196} />;
  const before = visits[visits.length - 2];
  const id = SHIPMENTS[last.shipment];
  const digits = (x: string): string => x.slice(ID_PREFIX.length);
  return (
    <>
      <span>
        {ID_PREFIX}
        <DecryptedText
          from={digits(before ? SHIPMENTS[before.shipment] : id)} to={digits(id)} frame={f} startFrame={last.at} durationFrames={4}
          seed={1700 + s} charset={DIGITS}
        />
      </span>
      <DemoPill theme={theme} style={SMALL_PILL} />
    </>
  );
};

export const S17Reprise: React.FC = () => {
  const f = useCurrentFrame();
  const T = S17_T;
  const fx = clickFx17(f);
  const out = ramp(f, T.retire, 10, EASE_EXIT);
  const lineIn = LINES[0].from;
  const dim = ramp(f, lineIn - 4, 8);
  const lit = litStation(f);
  const line = lineAt(f);

  // Cells lit on top of the dimmed ring: the arrival's cell for its beat, then the whole ring in ink on the click.
  const litCells: Array<{i: number; color: string; scale: number; opacity: number}> = [];
  if (lit && f < T.click) {
    litCells.push({i: cellOf(STATIONS[lit.station].angle), color: signal(theme, lit.color), scale: pop(f, lit.since), opacity: 1});
  }
  if (f >= T.click) {
    const n = Math.round(CELLS * ramp(f, T.click, 8));
    const fade = 1 - ramp(f, T.click + 18, 14, (t) => t);
    for (let i = 0; i < n; i++) litCells.push({i, color: pal.action, scale: 1, opacity: fade});
  }

  // The button: comes in on « décidez », fills over the beat before the click, collapses into the dot on the last beat.
  const btnIn = ramp(f, T.buttonIn, 12);
  const collapse = ramp(f, T.retire, 10);
  const btnW = lerp(BUTTON.w, DOT, collapse);
  const btnH = lerp(BUTTON.h, DOT, collapse);

  const glide = ramp(f, T.cursorIn, T.hold - T.cursorIn);
  const cursor = lerpPoint({x: 1580, y: 1000}, {x: 1150, y: 568}, glide);
  const cursorOpacity = Math.min(ramp(f, T.cursorIn, 4, (t) => t), 1 - ramp(f, T.retire, 4, (t) => t));

  return (
    <AbsoluteFill style={{background: pal.bg}}>
      <AbsoluteFill style={{transformOrigin: `${DOT_HOME.x}px ${DOT_HOME.y}px`, transform: `scale(${fx.zoom})`}}>
        <AbsoluteFill style={{opacity: 1 - out}}>
          <AbsoluteFill style={{opacity: lerp(1, RING_DIM, dim)}}>
            <LoopSequencer theme={theme} frame={s17ArmFrame(f)} speed={SPEED} stations={[null, null, null, null]} />
          </AbsoluteFill>
          {/* The kinetic lines cross the hub: the drop's mask, as in S08. */}
          <div
            style={{
              position: 'absolute', left: RING_CENTER.x - HUB_MASK / 2, top: RING_CENTER.y - HUB_MASK / 2, width: HUB_MASK, height: HUB_MASK,
              borderRadius: '50%', background: pal.bg, opacity: dim,
            }}
          />
          <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
            {litCells.map(({i, color, scale, opacity}) => {
              const p = ringPoint(i * STEP_DEG);
              return (
                <rect
                  key={i} x={-CELL.w / 2} y={-CELL.h / 2} width={CELL.w} height={CELL.h} rx={4} fill={color} opacity={opacity}
                  transform={`translate(${p.x} ${p.y}) rotate(${i * STEP_DEG}) scale(${scale})`}
                />
              );
            })}
          </svg>
          {STATIONS.map((st, s) => {
            const on = lit && lit.station === s ? lit : null;
            return (
              <div key={st.title} style={{position: 'absolute', left: st.card.x, top: st.card.y}}>
                <StationCard
                  title={st.title} titleEnd={<StatusDot f={f} lit={on} />}
                  rows={[<StationRow f={f} s={s} />, <Skeleton frame={f} width={140 + 36 * s} delay={5 * s} />]}
                  style={on ? {borderColor: signal(theme, on.color)} : undefined}
                />
              </div>
            );
          })}
          {SHIPMENTS.map((id, k) => {
            const tk = tokenAt(k, f);
            if (!tk) return null;
            return (
              <div
                key={id}
                style={{
                  position: 'absolute', left: tk.x - 20, top: tk.y - 20, width: 40, height: 40, opacity: tk.opacity,
                  transform: `scale(${tk.scale})`,
                }}
              >
                <ContainerGlyph size={40} color={pal.ink} />
                {/* « point DÉMO »: the shipment is demo data (its ID carries the DÉMO pill in the station). */}
                <span style={{position: 'absolute', right: -4, top: -2, width: 12, height: 12, borderRadius: 6, background: signal(theme, 'demo'), border: `2px solid ${pal.bg}`}} />
              </div>
            );
          })}
        </AbsoluteFill>

        {line !== null && (
          <div
            style={{
              position: 'absolute', left: 96, width: 1728, top: LINE_TOP[line], display: 'flex', justifyContent: 'center',
              opacity: line === 2 ? 1 - out : 1, transform: line === 2 ? `translateY(${40 * out}px)` : undefined,
            }}
          >
            <SplitText
              words={[...LINES[line].words]} frame={f} rise={60} duration={8} tag="div"
              style={{
                fontFamily: CONDENSED, fontWeight: 600, fontSize: 200, lineHeight: `${LINE_HEIGHT}px`, letterSpacing: '-0.02em', color: pal.ink,
                // A halo of background colour: the ring's hairlines and arm stop short of the letters instead of cutting them.
                textShadow: `0 0 14px ${pal.bg}, 0 0 28px ${pal.bg}`,
              }}
            />
          </div>
        )}

        {fx.wave && (
          <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
            <circle cx={DOT_HOME.x} cy={DOT_HOME.y} r={fx.wave.radius} fill="none" stroke={pal.action} strokeWidth={fx.wave.width} opacity={fx.wave.opacity} />
            <circle cx={DOT_HOME.x} cy={DOT_HOME.y} r={0.62 * fx.wave.radius} fill="none" stroke={pal.action} strokeWidth={fx.wave.width * 0.6} opacity={0.5 * fx.wave.opacity} />
          </svg>
        )}

        {f >= T.buttonIn && f < T.retire && (
          <div style={{position: 'absolute', left: BUTTON.x, top: BUTTON.y, opacity: btnIn, transform: `translateY(${60 * (1 - btnIn)}px)`}}>
            <Button
              theme={theme} label="ACCEPTER ET EXÉCUTER" fill={holdFill17(f)} pressed={fx.pressed}
              style={{outline: `1.5px solid ${pal.line}`, outlineOffset: -1.5, boxShadow: SHADOW[theme].lg}}
            />
          </div>
        )}
        {f >= T.retire && (
          <div
            style={{
              position: 'absolute', left: DOT_HOME.x - btnW / 2, top: DOT_HOME.y - btnH / 2, width: btnW, height: btnH,
              borderRadius: lerp(14, DOT / 2, collapse), background: pal.action, display: 'grid', placeItems: 'center', overflow: 'hidden',
            }}
          >
            <span style={{...LABEL, fontSize: 32, color: pal.actionText, whiteSpace: 'nowrap', opacity: 1 - ramp(f, T.retire, 4, (t) => t)}}>
              ACCEPTER ET EXÉCUTER
            </span>
          </div>
        )}

        {f >= T.cursorIn && cursorOpacity > 0 && (
          <div style={{position: 'absolute', inset: 0, opacity: cursorOpacity}}>
            <div
              style={{
                position: 'absolute', left: 0, top: 0, transformOrigin: `${cursor.x}px ${cursor.y}px`,
                transform: `scale(${1 - 0.08 * Math.max(fx.pressed, f >= T.hold && f < T.click ? 0.6 : 0)})`,
              }}
            >
              <Cursor x={cursor.x} y={cursor.y} theme={theme} />
            </div>
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
