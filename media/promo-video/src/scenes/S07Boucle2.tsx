// src/scenes/S07Boucle2.tsx — S07 · Refrain : la boucle (2), 58-70 s (spec § 4 S07).
// The camera pushes onto RECOMMANDATION and the station grows into the recommendation card: ORDER_NOW, « 3 000 UNITÉS »
// on the voice, « FOURNISSEUR C » with DÉMO + EXEMPLE, then three skeleton rows, one per beat. Above the card, the three
// crit notes that flew out of the risk figure tremble as a cluster and resolve into a vertical ok chord on « C ». When
// the arm reaches 9 o'clock the big button comes in; the cursor glides onto it, it fills over the beat before the click,
// and the click lands on frame 1920 exactly: press 0.96, shockwave 0 → 700 px, punch zoom 1 → 1.03 → 1. The draft
// purchase order slides out of the button (no "ai" marker, spec § 8), the camera recoils, and the order ratchets round
// the ring to SUIVRE, which now reads « SUIVRE · SUIVI » with a live dot beating on the four live cues.
import {AbsoluteFill, interpolateColors, useCurrentFrame} from 'remotion';
import {armAngle, RING_RADIUS, ringPoint, STEP_DEG} from '../components/LoopSequencer';
import {Button} from '../components/Button';
import {Chip} from '../components/Chip';
import {ContainerGlyph} from '../components/ContainerGlyph';
import {Cursor} from '../components/Cursor';
import {DemoPill} from '../components/DemoPill';
import {ExamplePill} from '../components/ExamplePill';
import {CONDENSED, LABEL} from '../components/typography';
import {FRAMES_PER_BEAT, quantize} from '../lib/beat';
import {frInt} from '../lib/format';
import {cueLocal, sceneFrames, seriesLocal, wordLocal} from '../lib/timeline';
import {DecryptedText} from '../rb/DecryptedText';
import {SplitText} from '../rb/SplitText';
import {palette, SHADOW, signal} from '../theme/tokens';
import {
  DbCylinder, IDENTITY, lerp, lerpCamera, lerpPoint, lerpRect, LiveDot, MorphBox, pushOn, ramp, rectAround, rectCenter,
  rectToScreen, RingWorld, Skeleton, SMALL_PILL, StationCard, STATION_RECTS, stationHumain, stationOptimiserDone,
  stationRecommandationDone, stationRecommandationPending, stationSuivreObserve, stationSuivreSuivi, THEME, toScreen, WORLD_FADE,
  type Camera, type Point, type Rect,
} from './refrain';

const S = 'S07' as const;
const FRAMES = sceneFrames(S);
const pal = palette(THEME);
const PUSH_FRAMES = 18;
const RECOIL_FRAMES = 18;
const PUSH_SCALE = 2.4;
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The arm continues from S06: S07's frame 0 is S06's frame 300. */
export const s07ArmFrame = (f: number): number => f + sceneFrames('S06');
const armDeg = (f: number): number => ((armAngle(s07ArmFrame(f)) % 360) + 360) % 360;
/** First frame of the scene at which the arm points at `deg` (clockwise from 12 o'clock). */
const armReaches = (deg: number): number => {
  for (let f = 0; f < FRAMES; f++) if (armDeg(f) === deg) return f;
  throw new Error(`S07: the arm never reaches ${deg}°`);
};

/** Every timed event of the scene, in local frames, from the cues, the voice and the arm. */
export const S07_T = (() => {
  const push = cueLocal(S, 'S07.push');
  const po = cueLocal(S, 'S07.po');
  const live = seriesLocal(S, 'S07.live');
  const recoil = quantize(po, 'beat');
  return {
    push,
    pushEnd: push + PUSH_FRAMES,
    hero: [wordLocal(S, 'trois').start - 2, wordLocal(S, 'unités').start - 2] as const,
    supplier: wordLocal(S, 'fournisseur').start - 2,
    resolve: cueLocal(S, 'S07.resolve'),
    rows: seriesLocal(S, 'S07.rows'),
    /** « Bras à 9 h : grand bouton » */
    buttonIn: armReaches(270),
    cursorIn: wordLocal(S, 'humain').start - 2,
    hold: cueLocal(S, 'S07.hold'),
    click: cueLocal(S, 'S07.click'),
    po,
    recoil,
    recoilEnd: recoil + RECOIL_FRAMES,
    ringFrom: recoil + RECOIL_FRAMES,
    /** The order ratchets one cell per beat over the three beats before it docks, like the arm (spec § 3.5). */
    steps: [live[0] - 4 * FRAMES_PER_BEAT, live[0] - 3 * FRAMES_PER_BEAT, live[0] - 2 * FRAMES_PER_BEAT] as const,
    ringTo: live[0] - 2 * FRAMES_PER_BEAT + 6,
    dock: live[0] - FRAMES_PER_BEAT,
    dockEnd: live[0] - FRAMES_PER_BEAT + 10,
    live,
  };
})();

// ---------------------------------------------------------------------------------------------------------------------
// Layout of the pushed-in view (screen px)

export const REC_CARD: Rect = {x: 432, y: 296, w: 1056, h: 472};
export const BUTTON_RECT: Rect = {x: 680, y: 808, w: 560, h: 120};
const BUTTON_C = rectCenter(BUTTON_RECT);
const STAFF_C: Point = {x: 960, y: 196};
const STAFF_GAP = 22;

const RECOMMANDATION = STATION_RECTS[2];
const HUMAIN = STATION_RECTS[3];
const SUIVRE = STATION_RECTS[0];
const PUSHED: Camera = pushOn(rectCenter(RECOMMANDATION), PUSH_SCALE);

export const s07Camera = (f: number): Camera => {
  const {push, pushEnd, recoil, recoilEnd} = S07_T;
  if (f < push || f >= recoilEnd) return IDENTITY;
  if (f < recoil) return f < pushEnd ? lerpCamera(IDENTITY, PUSHED, ramp(f, push, PUSH_FRAMES)) : PUSHED;
  return lerpCamera(PUSHED, IDENTITY, ramp(f, recoil, RECOIL_FRAMES));
};

// ---------------------------------------------------------------------------------------------------------------------
// The click

/** The button fills linearly over the beat from S07.hold to the click. */
export const holdFill = (f: number): number => Math.min(1, Math.max(0, (f - S07_T.hold) / (S07_T.click - S07_T.hold)));

export interface ClickFx { pressed: number; zoom: number; wave: {radius: number; opacity: number; width: number} | null }
const WAVE_FRAMES = 18;
const WAVE_RADIUS = 700;
const PUNCH = 0.03;
const PUNCH_FRAMES = 12;

/** Press 0.96, shockwave 0 → 700 px and punch zoom 1 → 1.03 → 1, all at their peak on the click frame. */
export const clickFx = (f: number): ClickFx => {
  const t = f - S07_T.click;
  if (t < 0) return {pressed: 0, zoom: 1, wave: null};
  const pressed = t < 2 ? 1 : t < PUNCH_FRAMES ? 1 - ramp(t, 2, PUNCH_FRAMES - 2) : 0;
  const zoom = t < PUNCH_FRAMES ? 1 + PUNCH * (1 - ramp(t, 0, PUNCH_FRAMES)) : 1;
  const wave = t <= WAVE_FRAMES ? {radius: WAVE_RADIUS * ramp(t, 0, WAVE_FRAMES), opacity: 1 - t / WAVE_FRAMES, width: lerp(6, 1.5, t / WAVE_FRAMES)} : null;
  return {pressed, zoom, wave};
};

// ---------------------------------------------------------------------------------------------------------------------
// The cluster over the card: D-E♭-E trembling, then D-F-A stacked on the staff (spec § 5.2)

const CLUSTER: readonly Point[] = [{x: -20, y: 16}, {x: 17, y: 6}, {x: -4, y: -8}];
const CHORD: readonly Point[] = [{x: 0, y: STAFF_GAP}, {x: 0, y: 0}, {x: 0, y: -STAFF_GAP}];
const FLIP_FRAMES = 12;

/** Note positions relative to the staff centre (low to high) and their colour. */
export const clusterNotes = (f: number): {color: 'crit' | 'ok'; notes: Point[]; settled: number} => {
  const p = ramp(f, S07_T.resolve, FLIP_FRAMES);
  const tremble = 1 - p;
  const t = f / 30;
  const notes = CLUSTER.map((c, i) => {
    const jitter = {x: 3 * tremble * Math.sin(2 * Math.PI * 12 * t + 2.1 * i), y: 1.5 * tremble * Math.sin(2 * Math.PI * 9 * t + 1.3 * i)};
    const at = lerpPoint({x: c.x + jitter.x, y: c.y + jitter.y}, CHORD[i], p);
    return p >= 1 ? CHORD[i] : at;
  });
  return {color: f >= S07_T.resolve ? 'ok' : 'crit', notes, settled: p};
};

// ---------------------------------------------------------------------------------------------------------------------
// The purchase order

export const PO_W = 476;
export const PO_H = 64;
/** The order rests one cell before each step, and its three steps end at 12 o'clock. */
const PO_FIRST_STOP = 360 - 3 * STEP_DEG;
/** It rides outside the ring, clear of the SUIVRE station, then comes down onto the ring line at 12 h (and so never
 * climbs into the HUD band). */
const poRadius = (deg: number): number => (deg <= 315 ? 470 : lerp(470, RING_RADIUS, (deg - 315) / 45));

const poAngle = (f: number): number => S07_T.steps.reduce((a, s) => a + STEP_DEG * ramp(f, s, 6), PO_FIRST_STOP);

/** Where the order is on screen, or null when it is not on its own (before it is born, once docked in SUIVRE). */
export const poRect = (f: number): Rect | null => {
  const {po, recoil, steps, dock, dockEnd} = S07_T;
  if (f < po || f >= dockEnd) return null;
  // Out of the button, to the left: towards 9 o'clock, where the loop takes it.
  const out = lerpPoint(BUTTON_C, {x: BUTTON_C.x - 400, y: BUTTON_C.y}, ramp(f, po, 8));
  if (f < recoil) return rectAround(out, PO_W, PO_H);
  const deg = poAngle(f);
  const onRing = ringPoint(deg, poRadius(deg));
  if (f < steps[0]) return rectAround(lerpPoint(out, toScreen(onRing, s07Camera(f)), ramp(f, recoil, RECOIL_FRAMES)), PO_W, PO_H);
  if (f < dock) return rectAround(onRing, PO_W, PO_H);
  return lerpRect(rectAround(onRing, PO_W, PO_H), SUIVRE, ramp(f, dock, dockEnd - dock));
};

const PoCard: React.FC<{rect: Rect; opacity: number}> = ({rect, opacity}) => (
  <div
    style={{
      ...LABEL, letterSpacing: 0, position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h, boxSizing: 'border-box',
      display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px', borderRadius: 10, overflow: 'hidden', background: pal.surface2,
      border: `1px solid ${pal.muted}`, boxShadow: SHADOW[THEME].lg, color: pal.ink, opacity,
      clipPath: 'polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 0 100%)',
    }}
  >
    {/* The folded corner of a document. */}
    <span style={{position: 'absolute', right: 0, top: 0, width: 18, height: 18, background: `linear-gradient(225deg, transparent 50%, ${pal.line} 50%)`}} />
    <span>PO-2026-0418 · BROUILLON</span>
    <DemoPill theme={THEME} style={SMALL_PILL} />
  </div>
);

// ---------------------------------------------------------------------------------------------------------------------

const ROWS = [
  {label: 'RAISONS', bars: [0.58, 0.26]},
  {label: 'COÛT', bars: [0.34]},
  {label: 'HYPOTHÈSES', bars: [0.44, 0.18, 0.2]},
] as const;
const BARS_W = 720;

const RecContent: React.FC<{f: number}> = ({f}) => {
  const T = S07_T;
  const heroIn = ramp(f, T.hero[0], 8);
  const supplierIn = ramp(f, T.supplier, 8);
  return (
    <>
      <Chip theme={THEME} style={{position: 'absolute', left: 48, top: 32, height: 40}}>ORDER_NOW</Chip>
      <div style={{...LABEL, position: 'absolute', right: 48, top: 42, color: pal.muted}}>RECOMMANDATION</div>
      {/* While the recommendation is computed: skeletons where the figure and the supplier will land. */}
      <div style={{position: 'absolute', left: 48, top: 134, opacity: 1 - heroIn, display: 'flex', gap: 24}}>
        <Skeleton frame={f} width={330} height={96} radius={10} />
        <Skeleton frame={f} width={520} height={96} delay={9} radius={10} />
      </div>
      <div style={{position: 'absolute', left: 48, top: 281, opacity: 1 - supplierIn}}>
        <Skeleton frame={f} width={300} height={14} delay={4} />
      </div>
      <SplitText
        words={[{text: frInt(3000), at: T.hero[0]}, {text: 'UNITÉS', at: T.hero[1]}]} frame={f} textAlign="left" tag="div"
        style={{
          position: 'absolute', left: 44, top: 90, fontFamily: CONDENSED, fontWeight: 600, fontSize: 170, lineHeight: '170px',
          letterSpacing: '-0.02em', color: pal.ink, whiteSpace: 'nowrap',
        }}
      />
      <div
        style={{
          ...LABEL, fontSize: 32, letterSpacing: '0.06em', position: 'absolute', left: 48, top: 270, height: 36, display: 'flex',
          alignItems: 'center', gap: 16, color: pal.ink, opacity: supplierIn, transform: `translateY(${(1 - supplierIn) * 12}px)`,
        }}
      >
        FOURNISSEUR C
        <DemoPill theme={THEME} />
      </div>
      {/* EXEMPLE comes with the first figure: « 3 000 unités / fournisseur C » is an illustration (spec § 8). */}
      <ExamplePill theme={THEME} style={{position: 'absolute', right: 48, top: 270, opacity: heroIn}} />
      <div style={{position: 'absolute', left: 48, right: 48, top: 330, height: 1, background: pal.line, opacity: ramp(f, T.rows[0], 6)}} />
      {ROWS.map((row, i) => {
        const at = T.rows[i];
        const e = ramp(f, at, 8);
        const grow = ramp(f, at, 12);
        let x = 0;
        return (
          <div key={row.label} style={{position: 'absolute', left: 48, top: 346 + 36 * i, height: 28, display: 'flex', alignItems: 'center', opacity: e, transform: `translateY(${(1 - e) * 10}px)`}}>
            <span style={{...LABEL, width: 240, color: pal.muted}}>{row.label}</span>
            <span style={{position: 'relative', width: BARS_W, height: 14}}>
              {row.bars.map((b, k) => {
                const w = b * BARS_W * grow;
                const left = x;
                x += b * BARS_W + 16;
                return (
                  <span key={k} style={{position: 'absolute', left, top: 0}}>
                    <Skeleton frame={f} width={Math.max(1, w)} height={14} delay={7 * i + 5 * k} />
                  </span>
                );
              })}
            </span>
          </div>
        );
      })}
    </>
  );
};

const Staff: React.FC<{f: number}> = ({f}) => {
  const T = S07_T;
  const pushP = ramp(f, T.push, PUSH_FRAMES);
  const out = 1 - ramp(f, T.recoil, 4, (t) => t);
  const {color, notes, settled} = clusterNotes(f);
  // The notes fly out of the risk figure of the OPTIMISER station while the camera pushes in.
  const centre = lerpPoint(rectCenter(STATION_RECTS[1]), STAFF_C, pushP);
  const noteColor = signal(THEME, color);
  const stem = ramp(f, T.resolve + 8, 8);
  return (
    <div style={{position: 'absolute', inset: 0, opacity: out}}>
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
        {[-2, -1, 0, 1, 2].map((k) => (
          <line
            key={k} x1={STAFF_C.x - 160} x2={STAFF_C.x + 160} y1={STAFF_C.y + k * STAFF_GAP} y2={STAFF_C.y + k * STAFF_GAP}
            stroke={pal.dim} strokeWidth={1.5} opacity={0.55 * ramp(f, T.push + 6, 10)}
          />
        ))}
        {stem > 0 && (
          <line
            x1={STAFF_C.x + 13} x2={STAFF_C.x + 13} y1={STAFF_C.y - STAFF_GAP} y2={STAFF_C.y - STAFF_GAP - 64 * stem}
            stroke={noteColor} strokeWidth={2.5} strokeLinecap="round"
          />
        )}
      </svg>
      {notes.map((n, i) => (
        <ContainerGlyph
          key={i} size={36} color={noteColor}
          style={{position: 'absolute', left: centre.x + n.x - 18, top: centre.y + n.y - 18 - 2, transform: `scale(${1 + 0.15 * (1 - settled) * (f >= T.resolve ? 1 : 0)})`}}
        />
      ))}
    </div>
  );
};

export const S07Boucle2: React.FC = () => {
  const f = useCurrentFrame();
  const T = S07_T;
  const cam = s07Camera(f);
  const pushP = ramp(f, T.push, PUSH_FRAMES);
  const recoilP = ramp(f, T.recoil, RECOIL_FRAMES);
  const zoomed = f >= T.push && f < T.recoilEnd;
  // The world recedes during the push and is gone behind the card (a ghost of the giant arm and hub is only noise).
  const worldOpacity = f < T.recoil ? 1 - ramp(f, T.push, WORLD_FADE) : recoilP;
  const back = ramp(f, T.recoil + 6, RECOIL_FRAMES - 8, (t) => t); // stations return over the second half of the recoil
  const fx = clickFx(f);

  // The recommendation card: grows out of its station, shrinks back into it.
  const recStation = rectToScreen(RECOMMANDATION, cam);
  const recRect = f < T.recoil ? lerpRect(recStation, REC_CARD, pushP) : lerpRect(REC_CARD, recStation, recoilP);
  const recContent = f < T.recoil ? ramp(f, T.pushEnd - 6, 8) : 1 - ramp(f, T.recoil, 4, (t) => t);

  // The button: slides in from the 9 o'clock side, then shrinks back into the HUMAIN station.
  const btnIn = ramp(f, T.buttonIn, 12);
  const humain = rectToScreen(HUMAIN, cam);
  const btnMorph = lerpRect(BUTTON_RECT, humain, recoilP);

  // The cursor: glides onto the button on « humain », holds, clicks, and leaves with the recoil.
  const glide = ramp(f, T.cursorIn, T.hold - T.cursorIn);
  const cursor = lerpPoint({x: 1580, y: 1010}, {x: 1150, y: 884}, glide);
  const cursorOpacity = Math.min(ramp(f, T.cursorIn, 4, (t) => t), 1 - ramp(f, T.recoil, 3, (t) => t));

  const po = poRect(f);
  const docked = f >= T.dock + 5;
  const suivreTitle = <DecryptedText from="SUIVRE · OBSERVE" to="SUIVRE · SUIVI" frame={f} startFrame={T.dock + 5} durationFrames={8} seed={707} charset={UPPER} style={{whiteSpace: 'pre'}} />;

  return (
    <AbsoluteFill style={{background: pal.bg}}>
      <AbsoluteFill style={{transformOrigin: `${BUTTON_C.x}px ${BUTTON_C.y}px`, transform: `scale(${fx.zoom})`}}>
        <RingWorld
          armFrame={s07ArmFrame(f)} camera={cam} opacity={worldOpacity}
          highlight={f < T.dock ? {color: 'crit', cells: [0]} : f >= T.live[0] ? {color: 'live', cells: [0]} : undefined}
          stations={[
            {props: docked ? stationSuivreSuivi(suivreTitle, <LiveDot frame={f} beats={T.live} />) : stationSuivreObserve(1)},
            {props: stationOptimiserDone()},
            f < T.push ? {props: stationRecommandationPending(f)} : f >= T.recoil ? {props: stationRecommandationDone(), opacity: back} : null,
            {props: stationHumain(f >= T.recoil ? 1 : 0), opacity: f >= T.recoil ? back : 1},
          ]}
        >
          {/* Written in S06. */}
          <DbCylinder frame={f} />
        </RingWorld>
        {zoomed && <Staff f={f} />}
        {zoomed && (
          <MorphBox rect={recRect} radius={lerp(10, 14, f < T.recoil ? pushP : 1 - recoilP)} shadow="lg" style={{opacity: f < T.recoil ? 1 : 1 - back}}>
            {/* The station itself, at the start of the push: the cut from S06 is seamless. */}
            <div style={{position: 'absolute', left: -1, top: -1, opacity: 1 - ramp(f, T.push, 6, (t) => t)}}>
              <StationCard {...stationRecommandationPending(f)} style={{boxShadow: 'none'}} />
            </div>
            <div style={{position: 'absolute', left: 0, top: 0, width: REC_CARD.w, height: REC_CARD.h, opacity: recContent}}>
              <RecContent f={f} />
            </div>
          </MorphBox>
        )}
        {/* Under the button: the order slides out from beneath it, and stays under its morph during the recoil. */}
        {po && f < T.dock && <PoCard rect={po} opacity={1} />}
        {fx.wave && (
          // Behind the button: the rings come out from under it and never cross its label.
          <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
            <circle cx={BUTTON_C.x} cy={BUTTON_C.y} r={fx.wave.radius} fill="none" stroke={pal.action} strokeWidth={fx.wave.width} opacity={fx.wave.opacity} />
            <circle cx={BUTTON_C.x} cy={BUTTON_C.y} r={0.62 * fx.wave.radius} fill="none" stroke={pal.action} strokeWidth={fx.wave.width * 0.6} opacity={0.5 * fx.wave.opacity} />
          </svg>
        )}
        {f >= T.buttonIn && f < T.recoil && (
          <div style={{position: 'absolute', left: BUTTON_RECT.x, top: BUTTON_RECT.y, opacity: btnIn, transform: `translateX(${-80 * (1 - btnIn)}px)`}}>
            <Button
              theme={THEME} label="ACCEPTER ET EXÉCUTER" fill={holdFill(f)} pressed={fx.pressed}
              style={{outline: `1.5px solid ${pal.line}`, outlineOffset: -1.5}}
            />
          </div>
        )}
        {f >= T.recoil && f < T.recoilEnd && (
          <div
            style={{
              position: 'absolute', left: btnMorph.x, top: btnMorph.y, width: btnMorph.w, height: btnMorph.h, borderRadius: lerp(14, 10, recoilP),
              background: interpolateColors(recoilP, [0, 1], [pal.action, pal.surface]), boxShadow: SHADOW[THEME].lg, opacity: 1 - back,
              display: 'grid', placeItems: 'center', overflow: 'hidden',
            }}
          >
            <span style={{...LABEL, fontSize: 32, color: pal.actionText, opacity: 1 - ramp(f, T.recoil, 4, (t) => t)}}>ACCEPTER ET EXÉCUTER</span>
          </div>
        )}
        {/* Opaque while it lands on the station (the station's rows change under it), then gone. */}
        {po && f >= T.dock && <PoCard rect={po} opacity={1 - ramp(f, T.dock + 5, 4, (t) => t)} />}
        {f >= T.cursorIn && cursorOpacity > 0 && (
          <div style={{position: 'absolute', inset: 0, opacity: cursorOpacity}}>
            <div style={{position: 'absolute', left: 0, top: 0, transformOrigin: `${cursor.x}px ${cursor.y}px`, transform: `scale(${1 - 0.08 * Math.max(fx.pressed, f >= T.hold && f < T.click ? 0.6 : 0)})`}}>
              <Cursor x={cursor.x} y={cursor.y} theme={THEME} />
            </div>
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
