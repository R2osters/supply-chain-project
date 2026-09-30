// src/scenes/S06Boucle1.tsx — S06 · Refrain : la boucle (1), 48-58 s (spec § 4 S06).
// The 16-step ring appears clockwise on the downbeat; SUIVRE lights crit with « SHP-0142 · EN RETARD ». A
// `shipment.delayed` pill rides the arc into the domain_events cylinder, which blinks twice on « base ». On
// « L'optimisation » the camera pushes onto OPTIMISER and the station opens into the tuner gauge: three SKU needles are
// recalculated one beat apart, the last one springs 0 → 68 (overshooting towards 74), the warn zone lights as it passes
// 60 and « 68 % » turns crit on the risk cue, with « RISQUE DE RUPTURE » and the EXEMPLE pill. Recoil to the whole ring
// over frames 285-300, the station now summarising the analysis; S07 takes the world over from there.
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {Gauge, valueToAngle, type GaugeNeedle} from '../components/Gauge';
import {DemoPill} from '../components/DemoPill';
import {ExamplePill} from '../components/ExamplePill';
import {CONDENSED, LABEL} from '../components/typography';
import {FRAMES_PER_BEAT, quantize, roundHalfUp, SIXTEENTH} from '../lib/beat';
import {frPercent} from '../lib/format';
import {dampedSpring} from '../lib/spring';
import {cueLocal, sceneFrames, wordLocal} from '../lib/timeline';
import {CountUp} from '../rb/CountUp';
import {DecryptedText} from '../rb/DecryptedText';
import {palette, signal} from '../theme/tokens';
import {RING_RADIUS, ringPoint} from '../components/LoopSequencer';
import {
  DbCylinder, DB_CENTER, IDENTITY, lerp, lerpCamera, lerpRect, MorphBox, pop, pushOn, ramp, rectCenter, rectToScreen, RingWorld,
  SMALL_PILL, StationCard, STATION_RECTS, stationHumain, stationOptimiserDone, stationOptimiserPending,
  stationRecommandationPending, stationSuivreObserve, THEME, WORLD_FADE, type Camera, type Point, type Rect,
} from './refrain';

const S = 'S06' as const;
const FRAMES = sceneFrames(S);
const pal = palette(THEME);

/** The analysis figure of spec § 4 S06: an EXEMPLE (spec § 8), never a measured value. */
export const RISK_EXAMPLE = 68;
const PUSH_FRAMES = 18;
const RECOIL_FRAMES = 15; // spec: « recul vers l'anneau entier sur les images 285-300 »
const PUSH_SCALE = 2.2;
const SKUS = [
  {id: 'SKU-006', target: 24},
  {id: 'SKU-011', target: 41},
  {id: 'SKU-014', target: RISK_EXAMPLE},
] as const;
const NEEDLE_SPRING = {from: 0, damping: 12, stiffness: 90} as const;

/** Every timed event of the scene, in local frames, from the cues and the voice. */
export const S06_T = (() => {
  const drop = cueLocal(S, 'S06.drop');
  const dbWrite = cueLocal(S, 'S06.dbWrite');
  const needle = cueLocal(S, 'S06.needle');
  const push = quantize(wordLocal(S, "L'optimisation").start, 'beat');
  return {
    drop,
    /** The pill leaves SUIVRE one beat after the drop and reaches the cylinder on the write. */
    pill: drop + FRAMES_PER_BEAT,
    dbWrite,
    /** dbBlip: two blips one sixteenth apart. */
    dbBlips: [dbWrite, dbWrite + roundHalfUp(SIXTEENTH)] as const,
    push,
    pushEnd: push + PUSH_FRAMES,
    relance: wordLocal(S, 'relance').start - 2,
    needle,
    warn60: cueLocal(S, 'S06.warn60'),
    risk: cueLocal(S, 'S06.risk'),
    /** One beat apart, the last on the needle cue. */
    skus: [needle - 2 * FRAMES_PER_BEAT, needle - FRAMES_PER_BEAT, needle] as const,
    recoil: FRAMES - RECOIL_FRAMES,
    recoilEnd: FRAMES,
  };
})();

export const s06NeedleValue = (f: number): number => dampedSpring(f - S06_T.needle, {...NEEDLE_SPRING, to: RISK_EXAMPLE});

/** The CountUp readout: the needle's value, held at 68 once reached (the needle overshoots, the figure does not). */
export const s06Readout = (f: number): {text: string; tone: 'ink' | 'crit'} | null =>
  f < S06_T.needle ? null : {text: frPercent(Math.min(s06NeedleValue(f), RISK_EXAMPLE)), tone: f >= S06_T.risk ? 'crit' : 'ink'};

const OPTIMISER = STATION_RECTS[1];
const PUSHED: Camera = pushOn(rectCenter(OPTIMISER), PUSH_SCALE);

export const s06Camera = (f: number): Camera => {
  if (f < S06_T.push || f >= S06_T.recoilEnd) return IDENTITY;
  if (f < S06_T.recoil) return lerpCamera(IDENTITY, PUSHED, ramp(f, S06_T.push, PUSH_FRAMES));
  return lerpCamera(PUSHED, IDENTITY, ramp(f, S06_T.recoil, RECOIL_FRAMES));
};

/** The gauge panel the OPTIMISER station opens into, centred in the frame. */
export const S06_PANEL: Rect = {x: 192, y: 180, w: 1536, h: 720};

export const s06PanelRect = (f: number): Rect | null => {
  if (f < S06_T.push || f >= S06_T.recoilEnd) return null;
  const station = rectToScreen(OPTIMISER, s06Camera(f));
  if (f < S06_T.recoil) return lerpRect(station, S06_PANEL, ramp(f, S06_T.push, PUSH_FRAMES));
  return lerpRect(S06_PANEL, station, ramp(f, S06_T.recoil, RECOIL_FRAMES));
};

const needles = (f: number): GaugeNeedle[] =>
  SKUS.map((sku, i) => {
    const at = S06_T.skus[i];
    const next = S06_T.skus[i + 1];
    const state = f < at ? 'parked' : next === undefined || f < next ? 'active' : 'ghost';
    const value = i === SKUS.length - 1 ? s06NeedleValue(f) : dampedSpring(f - at, {...NEEDLE_SPRING, to: sku.target});
    return {value, state};
  });

// ---------------------------------------------------------------------------------------------------------------------

/** The `shipment.delayed` event pill: born on the crit step at 12 h, it rides the arc outside the ring at a steady speed
 * (tape logic, spec § 3.5) and drops into the cylinder on the write. */
const PILL_ARC = 44;
const EventPill: React.FC<{f: number}> = ({f}) => {
  const {pill, dbWrite} = S06_T;
  if (f < pill || f >= dbWrite) return null;
  const drop = dbWrite - 6;
  const deg = PILL_ARC * Math.min(1, (f - pill) / (drop - pill));
  const onArc = ringPoint(deg, lerp(RING_RADIUS, 420, Math.min(1, deg / 10)));
  const into = ramp(f, drop, 6);
  // Into the cylinder from its left, clear of its label.
  const target: Point = {x: DB_CENTER.x - 80, y: DB_CENTER.y - 34};
  const p = {x: lerp(onArc.x, target.x, into), y: lerp(onArc.y, target.y, into)};
  const opacity = Math.min(ramp(f, pill, 4), 1 - ramp(f, dbWrite - 3, 3, (t) => t));
  return (
    <div
      style={{
        ...LABEL, letterSpacing: '0.04em', position: 'absolute', left: p.x, top: p.y, transform: 'translate(-50%, -50%)', opacity,
        display: 'flex', alignItems: 'center', height: 40, padding: '0 14px', borderRadius: 20, boxSizing: 'border-box',
        background: pal.surface2, border: `1.5px solid ${pal.muted}`, color: pal.ink, boxShadow: `0 6px 18px rgb(0 0 0 / 0.5)`,
      }}
    >
      shipment.delayed
    </div>
  );
};

/** A small tuner icon for a SKU row: a half-dial and its needle at the SKU's current value. */
const MiniDial: React.FC<{value: number; color: string}> = ({value, color}) => {
  const a = (valueToAngle(value) * Math.PI) / 180;
  return (
    <svg width={32} height={20} viewBox="0 0 32 20" style={{display: 'block', flex: 'none'}}>
      <path d="M3 18 A13 13 0 0 1 29 18" fill="none" stroke={pal.dim} strokeWidth={2} />
      <line x1={16} y1={18} x2={16 + 12 * Math.sin(a)} y2={18 - 12 * Math.cos(a)} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
    </svg>
  );
};

const RIGHT_X = 816;
const COL_RIGHT = S06_PANEL.w - 64;

const PanelContent: React.FC<{f: number}> = ({f}) => {
  const T = S06_T;
  const readout = s06Readout(f);
  const ns = needles(f);
  const risk = f >= T.risk;
  const numberIn = ramp(f, T.needle, 6);
  const labelIn = ramp(f, T.risk, 8);
  return (
    <>
      <div style={{...LABEL, position: 'absolute', left: 64, top: 52, color: pal.muted}}>OPTIMISER · RISQUE</div>
      <div style={{...LABEL, fontSize: 36, letterSpacing: '0.06em', position: 'absolute', left: 64, top: 90, color: pal.ink, display: 'flex'}}>
        <span>ANALYSE DE RISQUE</span>
        <DecryptedText
          from="" to=" · RELANCÉE" frame={f} startFrame={T.relance} durationFrames={8} seed={606}
          charset="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" style={{whiteSpace: 'pre'}}
        />
      </div>
      <div style={{position: 'absolute', left: 64, right: 64, top: 156, height: 1, background: pal.line}} />
      <Gauge
        theme={THEME} radius={280} needles={ns} warnLit={f >= T.warn60} critLit={risk} drawProgress={ramp(f, T.pushEnd - 2, 14)}
        style={{position: 'absolute', left: 40, top: 196}}
      />
      {SKUS.map((sku, i) => {
        const n = ns[i];
        const color = n.state === 'active' ? pal.ink : n.state === 'ghost' ? pal.muted : pal.dim;
        const progress = ramp(f, T.skus[i], FRAMES_PER_BEAT, (t) => t);
        const rowIn = ramp(f, T.pushEnd + 2 + 3 * i, 8);
        return (
          <div
            key={sku.id}
            style={{
              ...LABEL, letterSpacing: '0.04em', position: 'absolute', left: RIGHT_X, width: COL_RIGHT - RIGHT_X, top: 204 + 52 * i, height: 40,
              display: 'flex', alignItems: 'center', gap: 14, color, opacity: rowIn, transform: `translateY(${(1 - rowIn) * 12}px)`,
            }}
          >
            <MiniDial value={n.value} color={n.state === 'active' ? pal.action : color} />
            <span>{sku.id}</span>
            <DemoPill theme={THEME} style={SMALL_PILL} />
            <span style={{flex: 1}} />
            <span style={{position: 'relative', width: 200, height: 4, borderRadius: 2, background: pal.line, overflow: 'hidden'}}>
              <span style={{position: 'absolute', left: 0, top: 0, bottom: 0, width: `${progress * 100}%`, background: n.state === 'active' ? pal.action : pal.muted}} />
            </span>
          </div>
        );
      })}
      {readout && (
        <div style={{position: 'absolute', left: RIGHT_X - 6, top: 372, opacity: numberIn, display: 'flex', alignItems: 'flex-start', gap: 24}}>
          <CountUp
            value={Math.min(s06NeedleValue(f), RISK_EXAMPLE)} format={frPercent}
            style={{
              display: 'block', fontFamily: CONDENSED, fontWeight: 600, fontSize: 220, lineHeight: '220px', letterSpacing: '-0.02em',
              color: readout.tone === 'crit' ? signal(THEME, 'crit') : pal.ink, transform: `scale(${pop(f, T.risk, 1.06)})`, transformOrigin: '0% 70%',
            }}
          />
          <ExamplePill theme={THEME} style={{marginTop: 42}} />
        </div>
      )}
      <div
        style={{
          ...LABEL, fontSize: 32, position: 'absolute', left: RIGHT_X, top: 612, color: pal.ink, opacity: labelIn,
          transform: `translateY(${(1 - labelIn) * 12}px)`,
        }}
      >
        RISQUE DE RUPTURE
      </div>
    </>
  );
};

export const S06Boucle1: React.FC = () => {
  const f = useCurrentFrame();
  const T = S06_T;
  const cam = s06Camera(f);
  const panel = s06PanelRect(f);
  const opened = f >= T.push && f < T.recoilEnd;
  const pushP = ramp(f, T.push, PUSH_FRAMES);
  const recoilP = ramp(f, T.recoil, RECOIL_FRAMES);
  // The world recedes during the push and is gone behind the open panel (a ghost of it would only be noise).
  const worldOpacity = f < T.push ? 1 : f < T.recoil ? 1 - ramp(f, T.push, WORLD_FADE) : recoilP;
  // The station comes back over the second half of the recoil, while the morphing panel fades away.
  const back = ramp(f, T.recoil + 6, RECOIL_FRAMES - 8, (t) => t);
  // SUIVRE is there on the downbeat with its crit dot (the cue); the other stations follow their cells clockwise.
  const enter = (k: number) => (k === 0 ? 1 : ramp(f, T.drop + 4 * k, 8));
  const content = f < T.recoil ? ramp(f, T.pushEnd - 4, 8) : 1 - ramp(f, T.recoil, 4, (t) => t);
  return (
    <AbsoluteFill style={{background: pal.bg}}>
      <RingWorld
        armFrame={f} camera={cam} opacity={worldOpacity} revealFrom={T.drop} highlight={{color: 'crit', cells: [0]}}
        stations={[
          {props: stationSuivreObserve(pop(f, T.drop)), opacity: enter(0)},
          f < T.push
            ? {props: stationOptimiserPending(f), opacity: enter(1)}
            : f >= T.recoil
              ? {props: stationOptimiserDone(), opacity: f >= T.recoilEnd ? 1 : back}
              : null,
          {props: stationRecommandationPending(f), opacity: enter(2)},
          {props: stationHumain(0), opacity: enter(3)},
        ]}
      >
        <DbCylinder frame={f} appear={T.drop + 2} writes={T.dbBlips} written={T.dbWrite} />
        <EventPill f={f} />
      </RingWorld>
      {opened && panel && (
        <MorphBox rect={panel} radius={lerp(10, 14, f < T.recoil ? pushP : 1 - recoilP)} shadow="lg" style={{opacity: f < T.recoil ? 1 : 1 - back}}>
          {/* The station itself, at the start of the push: its opening reads as one object growing. */}
          <div style={{position: 'absolute', left: -1, top: -1, opacity: 1 - ramp(f, T.push, 6, (t) => t)}}>
            <StationCard {...stationOptimiserPending(f)} style={{boxShadow: 'none'}} />
          </div>
          <div style={{position: 'absolute', left: 0, top: 0, width: S06_PANEL.w, height: S06_PANEL.h, opacity: content}}>
            <PanelContent f={f} />
          </div>
        </MorphBox>
      )}
    </AbsoluteFill>
  );
};
