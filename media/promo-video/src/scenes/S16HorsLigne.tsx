// src/scenes/S16HorsLigne.tsx — S16 · Hors ligne, 148-154 s, light (spec § 4 S16).
// The embedded world base map (Natural Earth: coasts, borders, rivers, lakes, city dots) lies under a grid of pale
// square « online » tiles, like a web map. On the downbeat the Wi-Fi is struck through in crit, « HORS LIGNE ». From the
// next beat the tiles fall away in a diagonal wave, one diagonal per sixteenth (the 28 descending tile clicks of the
// score, over 105 frames), and the map underneath does not move: it stays readable. On « carte » the caption
// « FOND DE CARTE EMBARQUÉ · NATURAL EARTH » settles in the bottom-left corner. No live layer (ships, planes, disasters)
// is shown here: only the base map is available offline (spec § 8).
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import geo from '../../generated/geo.json';
import {WorldMap} from '../components/WorldMap';
import {Chip} from '../components/Chip';
import {LABEL} from '../components/typography';
import {quantize, roundHalfUp, SIXTEENTH} from '../lib/beat';
import {EASE_EXIT, EASE_OUT} from '../lib/easing';
import {rand} from '../lib/prng';
import {cueLocal, sceneDef, wordLocal} from '../lib/timeline';
import {palette, signal} from '../theme/tokens';
import {clamp01, pop} from './refrain';

const S = 'S16' as const;
const theme = sceneDef(S).theme;
const pal = palette(theme);

export const TILE = 120;
export const TILE_COLS = 1920 / TILE;
export const TILE_ROWS = 1080 / TILE;
const DIAGONALS = TILE_COLS + TILE_ROWS - 1;
/** The score's tile clicks: one per sixteenth over 105 frames from S16.tiles (scripts/music/score.py, place_tiles). */
const CLICKS = roundHalfUp(105 / SIXTEENTH);
const FALL_FRAMES = 14;
const FALL_DROP = 110;
const FALL_TILT = 7;

export const S16_T = (() => {
  const tiles = cueLocal(S, 'S16.tiles');
  const lastFall = tiles + roundHalfUp((CLICKS - 1) * SIXTEENTH);
  return {
    offline: cueLocal(S, 'S16.offline'),
    tiles,
    lastFall,
    /** Every tile is gone from this frame on. */
    clear: lastFall + FALL_FRAMES,
    /** « la carte du monde reste lisible »: on the nearest sixteenth, 2 frames early (spec § 3.5). */
    caption: quantize(wordLocal(S, 'carte').start, '16th') - 2,
  };
})();

/** Frame at which tile (col, row) starts to fall: its diagonal (col + row), spread over the clicks, on a sixteenth. */
export const tileFall = (col: number, row: number): number => {
  const click = roundHalfUp(((col + row) * (CLICKS - 1)) / (DIAGONALS - 1));
  return S16_T.tiles + roundHalfUp(click * SIXTEENTH);
};

export interface TileState { y: number; rotate: number; scale: number; opacity: number }
const AT_REST: TileState = {y: 0, rotate: 0, scale: 1, opacity: 1};

/** A tile at rest, falling (ease-in exit, a small seeded tilt), or gone (null). */
export const tileState = (col: number, row: number, f: number): TileState | null => {
  const t = f - tileFall(col, row);
  if (t < 0) return AT_REST;
  if (t >= FALL_FRAMES) return null;
  const e = EASE_EXIT(t / FALL_FRAMES);
  const side = rand(1616, col, row) < 0.5 ? -1 : 1;
  return {y: FALL_DROP * e, rotate: side * FALL_TILT * e, scale: 1 - 0.1 * e, opacity: 1 - e};
};

/** Draw-in of the crit strike across the Wi-Fi: visible on the offline cue itself, whole 8 frames later. */
export const wifiStrike = (f: number): number => EASE_OUT(clamp01((f - S16_T.offline + 1) / 8));

/** The Wi-Fi pictogram (three arcs and a dot), with an optional strike from top-left to bottom-right. */
export const WifiGlyph: React.FC<{size: number; color: string; strike?: number; strikeColor?: string; knockout?: string}> = ({
  size, color, strike = 0, strikeColor, knockout,
}) => {
  const arc = (r: number) => `M${16 - r * Math.SQRT1_2} ${24 - r * Math.SQRT1_2}A${r} ${r} 0 0 1 ${16 + r * Math.SQRT1_2} ${24 - r * Math.SQRT1_2}`;
  const len = Math.hypot(24, 22);
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" style={{display: 'block', flex: 'none', overflow: 'visible'}}>
      <g fill="none" stroke={color} strokeWidth={2.6} strokeLinecap="round">
        <path d={arc(8)} />
        <path d={arc(14)} />
        <path d={arc(20)} />
      </g>
      <circle cx={16} cy={24.5} r={2.6} fill={color} />
      {strike > 0 && strikeColor && (
        <g strokeLinecap="round" strokeDasharray={`${len} ${len}`} strokeDashoffset={len * (1 - strike)}>
          {knockout && <line x1={4} y1={4} x2={28} y2={26} stroke={knockout} strokeWidth={7} />}
          <line x1={4} y1={4} x2={28} y2={26} stroke={strikeColor} strokeWidth={3} />
        </g>
      )}
    </svg>
  );
};

export const S16HorsLigne: React.FC = () => {
  const f = useCurrentFrame();
  const crit = signal(theme, 'crit');
  const captionIn = EASE_OUT(clamp01((f - S16_T.caption + 1) / 10));
  const tiles: React.ReactNode[] = [];
  for (let c = 0; c < TILE_COLS; c++) {
    for (let r = 0; r < TILE_ROWS; r++) {
      const s = tileState(c, r, f);
      if (!s) continue;
      tiles.push(
        <div
          key={`${c}-${r}`}
          style={{
            position: 'absolute', left: c * TILE, top: r * TILE, width: TILE, height: TILE, boxSizing: 'border-box',
            background: pal.surface, border: `1px solid ${pal.line}`, opacity: 0.9 * s.opacity,
            transform: `translateY(${s.y}px) rotate(${s.rotate}deg) scale(${s.scale})`,
          }}
        />,
      );
    }
  }
  return (
    <AbsoluteFill style={{background: pal.bg}}>
      {/* The embedded base map: it never moves. The charter's hairlines (#d6d8db on the #dcdee1 land) are made to be
          quiet behind live layers; here the map is the subject, so its coasts, borders and rivers are drawn again in
          the charter's neutral greys, strong enough to read at the back of a classroom. */}
      <WorldMap theme={theme} layers={['land', 'lakes', 'rivers', 'borders', 'cities']} />
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
        <path d={geo.world.rivers} fill="none" stroke={pal.dim} strokeOpacity={0.45} strokeWidth={1} strokeLinejoin="round" />
        <path d={geo.world.lakes} fill="none" stroke={pal.dim} strokeOpacity={0.6} strokeWidth={1} />
        <path d={geo.world.borders} fill="none" stroke={pal.dim} strokeOpacity={0.55} strokeWidth={1} strokeLinejoin="round" />
        <path d={geo.world.land} fill="none" stroke={pal.muted} strokeWidth={1.4} strokeLinejoin="round" />
        {geo.world.cities.map((c, i) => (
          <circle key={i} cx={c.x} cy={c.y} r={c.r + 0.5} fill={pal.ink} stroke={pal.map} strokeWidth={1.5} />
        ))}
      </svg>
      <AbsoluteFill>{tiles}</AbsoluteFill>
      <div
        style={{
          ...LABEL, position: 'absolute', right: 96, top: 112, height: 48, display: 'flex', alignItems: 'center', gap: 14,
          padding: '0 18px 0 14px', boxSizing: 'border-box', borderRadius: 6, background: pal.surface2, border: `1.5px solid ${crit}`,
          color: pal.ink, transform: `scale(${pop(f, S16_T.offline, 1.12)})`, transformOrigin: '100% 50%',
        }}
      >
        <WifiGlyph size={34} color={pal.ink} strike={wifiStrike(f)} strikeColor={crit} knockout={pal.surface2} />
        HORS LIGNE
      </div>
      <div style={{position: 'absolute', left: 96, top: 916, opacity: captionIn, transform: `translateY(${(1 - captionIn) * 10}px)`}}>
        <Chip theme={theme} style={{background: pal.surface2}}>FOND DE CARTE EMBARQUÉ · NATURAL EARTH</Chip>
      </div>
    </AbsoluteFill>
  );
};
