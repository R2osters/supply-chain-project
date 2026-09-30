// src/components/Console.tsx — the S11 mixing console (spec § 4 S11): ten 150 × 760 px strips (surface, radius 10) and
// a MASTER set apart, inside the 96 px margins. Each strip has an icon, its name on a strip of console tape that runs
// across the ten channels (the widest name, INONDATIONS, is as wide as a strip at the 24 px floor, so names sit on a
// shared tape rather than inside their box), a 16-segment VU meter, a fader, an « M » button, its source and a
// « CLÉ : — » field. The VU level comes from the caller; `vuEnvelope` is the deterministic envelope the brief asks for,
// 0.55 + 0.35·|sin(f·0.9 + i)| damped by the seeded rand. A signal colour only reaches the VU crest (`peak`), and only
// when the caller passes it at its cue.
import {rand} from '../lib/prng';
import {palette, type SignalColor, type Theme} from '../theme/tokens';
import {ContainerGlyph} from './ContainerGlyph';
import {VuLane} from './VuLane';
import {CONDENSED, LABEL} from './typography';

export const STRIPS_COUNT = 10;
export const STRIP_W = 150;
export const STRIP_H = 760;
const LEFT = 96;
const GAP = 6;
const MASTER_GAP = 24;
export const stripX = (i: number): number => LEFT + i * (STRIP_W + GAP);
export const MASTER_X = stripX(STRIPS_COUNT - 1) + STRIP_W + MASTER_GAP;
export const CONSOLE_TOP = 160;

/** Level of an open fader (spec: « le curseur monte à 70 % »). */
export const FADER_UP = 0.7;
export const VU_SEED = 4811;
export const VU_DAMP = 0.2;

/** The brief's envelope: 0.55 + 0.35·|sin(f·0.9 + i)|, damped by up to VU_DAMP by rand(VU_SEED, i, f). */
export const vuEnvelope = (f: number, i: number): number =>
  (0.55 + 0.35 * Math.abs(Math.sin(f * 0.9 + i))) * (1 - VU_DAMP * rand(VU_SEED, i, f));

// Inside a strip (y from the strip's top).
const ICON_Y = 20;
const ICON = 44;
export const TAPE_Y = 80;
export const TAPE_H = 44;
const METER_Y = 146;
const METER_H = 416;
const MUTE_Y = 582;
const SOURCE_BOTTOM = 690;
const KEY_Y = 702;
const KEY_H = 42;
const VU_X = 20;
/** Channel names on the tape: Condensed SemiBold; INONDATIONS is then about 150 px, a strip's width. */
const NAME_SIZE = 25;
const VU_T = 22;
const TRACK_X = 100;
const KNOB_W = 56;
const KNOB_H = 28;

/** Centre y of the fader knob (from the strip's top) for a level 0..1. */
export const faderY = (level: number): number => METER_Y + KNOB_H / 2 + (METER_H - KNOB_H) * (1 - level);

export type IconName = 'ship' | 'plane' | 'quake' | 'cyclone' | 'flood' | 'fire' | 'weather' | 'camera' | 'radio' | 'satellite';

/** Line icons on a 48-unit grid, drawn with round 2.25 px strokes. */
const ICONS: Record<IconName, string[]> = {
  ship: ['M30 24 14 17.5 18 24 14 30.5Z', 'M34 15a13 13 0 0 1 0 18', 'M39 10a20 20 0 0 1 0 28'],
  plane: ['M34 24 14 14 20 24 14 34Z', 'M16 24H4', 'M12 19H6', 'M12 29H6'],
  quake: ['M4 26h8l3-7 4 15 5-24 4 28 4-17 3 5h9'],
  cyclone: ['M24 30a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z', 'M18 24c0-10 6-16 16-16', 'M30 24c0 10-6 16-16 16'],
  flood: ['M5 17c4.75-4 9.5-4 14.25 0s9.5 4 14.25 0 9.5-4 14.25 0', 'M5 26c4.75-4 9.5-4 14.25 0s9.5 4 14.25 0 9.5-4 14.25 0', 'M5 35c4.75-4 9.5-4 14.25 0s9.5 4 14.25 0 9.5-4 14.25 0'],
  fire: ['M24 5c1 7 11 12 11 23a11 11 0 0 1-22 0c0-6 3-9 5-12 1 4 2 6 4 7 3-4 3-11 2-18Z', 'M24 42a5 5 0 0 1-5-5c0-3 3-5 5-8 2 3 5 5 5 8a5 5 0 0 1-5 5Z'],
  weather: ['M18 21a6 6 0 1 1 11-3', 'M18 8v-3', 'M8 18H5', 'M11 11 9 9', 'M26 11l2-2', 'M15 40h19a7 7 0 0 0 0-14 10 10 0 0 0-19 2 6 6 0 0 0 0 12Z'],
  camera: ['M6 16h9l3-5h12l3 5h9v22H6Z', 'M24 34a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'M36 21h2'],
  radio: ['M24 22v20', 'M18 42h12', 'M24 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M16 10a11 11 0 0 0 0 14', 'M32 10a11 11 0 0 1 0 14', 'M11 5a18 18 0 0 0 0 24', 'M37 5a18 18 0 0 1 0 24'],
  satellite: ['M24 17l7 7-7 7-7-7Z', 'M29 15l8-8 6 6-8 8Z', 'M19 33l-8 8-6-6 8-8Z', 'M33 11l6 6', 'M9 31l6 6', 'M27.5 20.5 31 17', 'M20.5 27.5 17 31', 'M27.5 27.5 32 32', 'M29 38a8 8 0 0 0 9-9'],
};

export interface StripView {
  name: string;
  /** One or two lines. */
  source: readonly string[];
  icon: IconName;
  fader: number;
  /** 0..1 of the 16 segments. */
  vu: number;
  peak?: SignalColor;
  muted: boolean;
  /** Scale of the icon (the trigger pop on the unmute). */
  pulse: number;
  keyFlash: boolean;
}

export interface MasterView { fader: number; vuL: number; vuR: number; keyFlash: boolean }

export interface ConsoleProps { theme: Theme; strips: readonly StripView[]; master: MasterView }

const StripBody: React.FC<{theme: Theme; x: number; children: React.ReactNode}> = ({theme, x, children}) => {
  const pal = palette(theme);
  return (
    <div
      style={{
        position: 'absolute', left: x, top: CONSOLE_TOP, width: STRIP_W, height: STRIP_H, boxSizing: 'border-box', borderRadius: 10,
        background: pal.surface, border: `1px solid ${pal.line}`,
      }}
    >
      {children}
    </div>
  );
};

const Fader: React.FC<{theme: Theme; level: number; live: boolean; x?: number}> = ({theme, level, live, x = TRACK_X}) => {
  const pal = palette(theme);
  const y = faderY(level);
  return (
    <>
      <div style={{position: 'absolute', left: x - 3, top: METER_Y, width: 6, height: METER_H, borderRadius: 3, background: pal.bg, boxShadow: `inset 0 0 0 1px ${pal.line}`}} />
      {Array.from({length: 11}, (_, k) => (
        <div key={k} style={{position: 'absolute', left: x - 44, top: METER_Y + KNOB_H / 2 + ((METER_H - KNOB_H) * k) / 10, width: k % 5 === 0 ? 12 : 7, height: 1.5, background: pal.line}} />
      ))}
      <div
        style={{
          position: 'absolute', left: x - KNOB_W / 2, top: y - KNOB_H / 2, width: KNOB_W, height: KNOB_H, boxSizing: 'border-box', borderRadius: 4,
          background: pal.surface2, border: `1.5px solid ${live ? pal.muted : pal.line}`, boxShadow: '0 4px 10px rgb(0 0 0 / 0.45)',
        }}
      >
        <div style={{position: 'absolute', left: 8, right: 8, top: KNOB_H / 2 - 2.5, height: 2, background: live ? pal.ink : pal.dim}} />
      </div>
    </>
  );
};

const KeyField: React.FC<{theme: Theme; flash: boolean; x?: number}> = ({theme, flash}) => {
  const pal = palette(theme);
  return (
    <div
      style={{
        ...LABEL, position: 'absolute', left: 8, right: 8, top: KEY_Y, height: KEY_H, boxSizing: 'border-box', borderRadius: 4,
        display: 'flex', alignItems: 'center', justifyContent: 'center', letterSpacing: '0.04em',
        background: flash ? pal.action : pal.surface2, color: flash ? pal.actionText : pal.muted, border: `1px solid ${flash ? pal.action : pal.line}`,
      }}
    >
      CLÉ&nbsp;: —
    </div>
  );
};

const Icon: React.FC<{name: IconName; color: string; scale: number}> = ({name, color, scale}) => (
  <svg
    width={ICON} height={ICON} viewBox="0 0 48 48"
    style={{position: 'absolute', left: (STRIP_W - ICON) / 2, top: ICON_Y, overflow: 'visible', transform: `scale(${scale})`}}
  >
    {ICONS[name].map((d) => (
      <path key={d} d={d} fill="none" stroke={color} strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" />
    ))}
  </svg>
);

export const Console: React.FC<ConsoleProps> = ({theme, strips, master}) => {
  const pal = palette(theme);
  return (
    <>
      {strips.map((s, i) => (
        <StripBody key={s.name} theme={theme} x={stripX(i)}>
          <Icon name={s.icon} color={s.muted ? pal.dim : pal.ink} scale={s.pulse} />
          <VuLane
            theme={theme} label="" value={s.vu} max={1} orientation="vertical" length={METER_H} thickness={VU_T} peakColor={s.peak}
            style={{position: 'absolute', left: VU_X, top: METER_Y}}
          />
          <Fader theme={theme} level={s.fader} live={!s.muted} />
          <div
            style={{
              ...LABEL, position: 'absolute', left: (STRIP_W - 60) / 2, top: MUTE_Y, width: 60, height: 38, boxSizing: 'border-box', borderRadius: 6,
              display: 'flex', alignItems: 'center', justifyContent: 'center', letterSpacing: 0,
              background: s.muted ? pal.muted : 'transparent', color: s.muted ? pal.actionText : pal.dim, border: `1.5px solid ${s.muted ? pal.muted : pal.line}`,
            }}
          >
            M
          </div>
          <div
            style={{
              position: 'absolute', left: 4, right: 4, bottom: STRIP_H - SOURCE_BOTTOM, textAlign: 'center', fontFamily: CONDENSED, fontWeight: 500,
              fontSize: 24, lineHeight: '26px', color: s.muted ? pal.dim : pal.muted, whiteSpace: 'nowrap',
            }}
          >
            {s.source.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
          <KeyField theme={theme} flash={s.keyFlash} />
        </StripBody>
      ))}

      {/* The tape across the ten channels, and its own piece on the MASTER */}
      {[[stripX(0), stripX(STRIPS_COUNT - 1) + STRIP_W], [MASTER_X, MASTER_X + STRIP_W]].map(([x0, x1]) => (
        <div
          key={x0}
          style={{
            position: 'absolute', left: x0, top: CONSOLE_TOP + TAPE_Y, width: x1 - x0, height: TAPE_H, background: pal.surface2,
            borderTop: `1px solid ${pal.line}`, borderBottom: `1px solid ${pal.line}`, boxShadow: '0 2px 6px rgb(0 0 0 / 0.35)',
          }}
        />
      ))}
      {strips.map((s, i) => (
        <div
          key={`n${s.name}`}
          style={{
            position: 'absolute', left: stripX(i) - 20, width: STRIP_W + 40, top: CONSOLE_TOP + TAPE_Y, height: TAPE_H, display: 'flex',
            alignItems: 'center', justifyContent: 'center', fontFamily: CONDENSED, fontWeight: 600, fontSize: NAME_SIZE, lineHeight: 1,
            letterSpacing: '-0.01em', color: s.muted ? pal.dim : pal.ink, whiteSpace: 'nowrap',
          }}
        >
          {s.name}
        </div>
      ))}

      {/* MASTER: the logo's container, a stereo meter, its fader */}
      <StripBody theme={theme} x={MASTER_X}>
        <ContainerGlyph size={ICON} color={pal.ink} style={{position: 'absolute', left: (STRIP_W - ICON) / 2, top: ICON_Y}} />
        {[master.vuL, master.vuR].map((vu, k) => (
          <VuLane
            key={k} theme={theme} label="" value={vu} max={1} orientation="vertical" length={METER_H} thickness={14}
            style={{position: 'absolute', left: 14 + k * 18, top: METER_Y}}
          />
        ))}
        <Fader theme={theme} level={master.fader} live x={TRACK_X + 4} />
        <KeyField theme={theme} flash={master.keyFlash} />
      </StripBody>
      <div
        style={{
          position: 'absolute', left: MASTER_X, width: STRIP_W, top: CONSOLE_TOP + TAPE_Y, height: TAPE_H, display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontFamily: CONDENSED, fontWeight: 600, fontSize: NAME_SIZE, lineHeight: 1, letterSpacing: '-0.01em', color: pal.ink,
        }}
      >
        MASTER
      </div>
    </>
  );
};
