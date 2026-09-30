// src/components/ThemeWipe.tsx — the only transition between themes (spec §§ 2 and 3.5): over one beat, the incoming
// scene is revealed left to right behind a 2 px playhead in its own action colour. Rendered inside the incoming
// scene's <Sequence>, so useCurrentFrame() is local to that scene.
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {EASE_OUT} from '../lib/easing';
import {sceneDef, scenes, type SceneId} from '../lib/timeline';
import {palette, type Theme} from '../theme/tokens';
import {Playhead} from './Playhead';

export const WIPE_FRAMES = 15;

/** How far the wipe has travelled, in % of the frame width, `local` frames after the scene start. */
export const wipeProgress = (local: number): number =>
  interpolate(local, [0, WIPE_FRAMES], [0, 100], {easing: EASE_OUT, extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

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
      {wiping && <Playhead x={(p / 100) * width} height={height} color={palette(theme).action} />}
    </AbsoluteFill>
  );
};
