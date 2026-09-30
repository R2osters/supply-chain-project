// src/components/Hud.tsx — the heads-up display of spec § 3.6, rendered once over the whole film (absolute frames).
// Top left: « ♩ = 120 · MESURE 009/085 » and, from frame 795, the 40 px logo the S04 logo flies into. Top right: seven
// 16 px pads, each lit for 8 frames from every cue of its colour, and only then. Bottom: the section tape, the current
// section in ink and the others dim. Mono 24 px throughout.
// Colours follow themeAt(frame). Two refinements keep the HUD readable where the theme changes: under a wipe it is split
// at the wipe edge like the scenes, and over the last 60 frames of a scene with a `themeEnd` (S05) it fades to the end
// theme's colours along with the background.
import {AbsoluteFill, interpolateColors, useCurrentFrame} from 'remotion';
import {barAt, barToFrame, BPM, TOTAL_BARS} from '../lib/beat';
import {coloredCuesStrict, sceneAtFrame, sceneFrames, scenes, sceneStart} from '../lib/timeline';
import {palette, signal, type SignalColor, type Theme} from '../theme/tokens';
import {Logo} from './Logo';
import {startsWithWipe, WIPE_FRAMES, wipeProgress} from './ThemeWipe';
import {LABEL} from './typography';

/** Frame from which the logo sits in the HUD: the S04 logo lands there at that frame. */
export const HUD_LOGO_FROM = 795;
/** Top-left corner, size and stroke of the HUD logo, for the S04 flight to land on it exactly. */
export const HUD_LOGO = {x: 96, y: 40, size: 40, stroke: 1.5} as const;
/** Frames over which a `themeEnd` scene darkens (or lightens) at its end; S05 moves its background over the same span. */
export const THEME_END_FRAMES = 60;
export const PADS = ['crit', 'warn', 'ok', 'live', 'info', 'demo', 'ink'] as const satisfies readonly SignalColor[];
export const PAD_LIT_FRAMES = 8;
/** The sections, in film order (spec § 3.6). */
export const SECTIONS: readonly string[] = scenes.map((s) => s.section).filter((s, i, all) => all.indexOf(s) === i);

const ROW_Y = 60;
const TAPE_Y = 1020;
const MARGIN = 96;
const TEXT_X = HUD_LOGO.x + HUD_LOGO.size + 16;
const PAD = 16;
const COLORED = coloredCuesStrict();
const FIN_FROM = barToFrame(TOTAL_BARS);

const pad3 = (n: number): string => String(n).padStart(3, '0');

export const hudText = (frame: number): string =>
  `♩ = ${BPM} · MESURE ${pad3(barAt(frame))}/${pad3(TOTAL_BARS)}${frame >= FIN_FROM ? ' · FIN' : ''}`;

/** Pads lit at `frame`, in pad order. */
export const litPads = (frame: number): SignalColor[] =>
  PADS.filter((c) => COLORED.some((q) => q.color === c && frame >= q.frame && frame < q.frame + PAD_LIT_FRAMES));

export interface HudColors { ink: string; muted: string; dim: string }
export interface HudLayer { theme: Theme; colors: HudColors; clip?: string }

const colorsOf = (t: Theme): HudColors => {
  const {ink, muted, dim} = palette(t);
  return {ink, muted, dim};
};

/** The HUD layers at `frame`: one, or the outgoing and incoming themes clipped at the wipe edge. */
export const hudLayers = (frame: number): HudLayer[] => {
  const scene = sceneAtFrame(frame);
  const start = sceneStart(scene.id);
  const end = start + sceneFrames(scene.id);
  if (startsWithWipe(scene.id) && frame - start < WIPE_FRAMES) {
    const previous = scenes[scenes.indexOf(scene) - 1];
    const outgoing = previous.themeEnd ?? previous.theme;
    const p = wipeProgress(frame - start);
    return [
      {theme: outgoing, colors: colorsOf(outgoing), clip: `inset(0 0 0 ${p}%)`},
      {theme: scene.theme, colors: colorsOf(scene.theme), clip: `inset(0 ${100 - p}% 0 0)`},
    ];
  }
  if (scene.themeEnd && scene.themeEnd !== scene.theme && frame >= end - THEME_END_FRAMES) {
    const t = (frame - (end - THEME_END_FRAMES)) / THEME_END_FRAMES;
    const from = colorsOf(scene.theme);
    const to = colorsOf(scene.themeEnd);
    const mix = (k: keyof HudColors): string => interpolateColors(t, [0, 1], [from[k], to[k]]);
    return [{theme: scene.theme, colors: {ink: mix('ink'), muted: mix('muted'), dim: mix('dim')}}];
  }
  return [{theme: scene.theme, colors: colorsOf(scene.theme)}];
};

/** ♩ drawn as a path: the pinned Plex faces have no U+2669 glyph, and a system fallback would break the charter. */
const QuarterNote: React.FC<{color: string}> = ({color}) => (
  <svg width={12} height={24} viewBox="0 0 12 24" style={{display: 'block', flex: 'none'}}>
    <ellipse cx={5.2} cy={19} rx={4.4} ry={3.2} transform="rotate(-22 5.2 19)" fill={color} />
    <rect x={8.1} y={1.5} width={1.6} height={17.5} fill={color} />
  </svg>
);

const HudView: React.FC<{frame: number; layer: HudLayer}> = ({frame, layer}) => {
  const {theme, colors, clip} = layer;
  const lit = litPads(frame);
  const section = sceneAtFrame(frame).section;
  return (
    <AbsoluteFill style={clip ? {clipPath: clip} : undefined}>
      {frame >= HUD_LOGO_FROM && (
        <Logo size={HUD_LOGO.size} stroke={HUD_LOGO.stroke} color={colors.ink} style={{position: 'absolute', left: HUD_LOGO.x, top: HUD_LOGO.y}} />
      )}
      <div style={{...LABEL, position: 'absolute', left: TEXT_X, top: ROW_Y - 12, height: 24, display: 'flex', alignItems: 'center', gap: 14, color: colors.muted}}>
        <QuarterNote color={colors.muted} />
        <span>{hudText(frame).replace(/^♩ /, '')}</span>
      </div>
      <div style={{position: 'absolute', right: MARGIN, top: ROW_Y - PAD / 2, display: 'flex', gap: 12}}>
        {PADS.map((c) => {
          const on = lit.includes(c);
          return (
            <div
              key={c}
              style={{
                width: PAD, height: PAD, boxSizing: 'border-box', borderRadius: PAD / 2,
                border: `1.5px solid ${on ? signal(theme, c) : colors.dim}`, background: on ? signal(theme, c) : 'transparent',
              }}
            />
          );
        })}
      </div>
      <div style={{position: 'absolute', left: MARGIN, right: MARGIN, top: TAPE_Y - 12, display: 'flex', justifyContent: 'space-between'}}>
        {SECTIONS.map((s) => (
          <div key={s} style={{...LABEL, letterSpacing: 0, position: 'relative', color: s === section ? colors.ink : colors.dim}}>
            {s}
            {s === section && <div style={{position: 'absolute', left: 0, right: 0, top: 32, height: 2, background: colors.ink}} />}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

export const Hud: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{pointerEvents: 'none'}}>
      {hudLayers(frame).map((layer) => (
        <HudView key={layer.theme} frame={frame} layer={layer} />
      ))}
    </AbsoluteFill>
  );
};
