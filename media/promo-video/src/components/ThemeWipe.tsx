// src/components/ThemeWipe.tsx — the only transition between themes (spec §§ 2 and 3.5): over one beat, the incoming
// scene is revealed left to right behind a 2 px playhead in its own action colour, riding just inside the revealed edge.
// Rendered inside the incoming scene's <Sequence>, so useCurrentFrame() is local to that scene.
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {EASE_OUT} from '../lib/easing';
import {sceneDef, scenes, type SceneId} from '../lib/timeline';
import {palette, type Theme} from '../theme/tokens';
import {Playhead, PLAYHEAD_WIDTH} from './Playhead';

export const WIPE_FRAMES = 15;

/** How far the wipe has travelled, in % of the frame width, `local` frames after the scene start. */
export const wipeProgress = (local: number): number =>
  interpolate(local, [0, WIPE_FRAMES], [0, 100], {easing: EASE_OUT, extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

/** Strip of incoming background, in px, between the wipe playhead and the clip edge. */
export const WIPE_PLAYHEAD_GAP = 4;

/**
 * Centre x of the wipe playhead, `local` frames after the scene start. The line is in the incoming action colour, which
 * is by construction close to the outgoing background: centred on the clip edge it would vanish into the outgoing side,
 * and flush against the edge it would only widen the outgoing region. So it rides inside the revealed region, with a
 * `WIPE_PLAYHEAD_GAP` strip of incoming background between it and the edge, and reads as a line against both sides.
 */
export const wipePlayheadX = (local: number, width: number): number =>
  (wipeProgress(local) / 100) * width - WIPE_PLAYHEAD_GAP - PLAYHEAD_WIDTH / 2;

/** A scene opens with a wipe when the previous scene ends in another theme. */
export const startsWithWipe = (id: SceneId): boolean => {
  const i = scenes.findIndex((s) => s.id === id);
  if (i <= 0) return false;
  const previous = scenes[i - 1];
  return (previous.themeEnd ?? previous.theme) !== sceneDef(id).theme;
};

export interface ThemeWipeProps {
  children: React.ReactNode;
  /** The incoming scene's theme: the playhead takes its action colour. */
  theme: Theme;
}

export const ThemeWipe: React.FC<ThemeWipeProps> = ({children, theme}) => {
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();
  const wiping = frame < WIPE_FRAMES;
  const p = wipeProgress(frame);
  // Same tree during and after the wipe, so the scene is never remounted when the clip goes away.
  return (
    <AbsoluteFill>
      <AbsoluteFill style={wiping ? {clipPath: `inset(0 ${100 - p}% 0 0)`} : undefined}>{children}</AbsoluteFill>
      {wiping && <Playhead x={wipePlayheadX(frame, width)} height={height} color={palette(theme).action} />}
    </AbsoluteFill>
  );
};
