// src/components/Grain.tsx — the film grain of the dark scenes (spec § 3.7: 2-3 %, seeded per frame). Rendered outside
// any <Sequence>, so the frame is absolute; the light scenes get none.
import {useCurrentFrame} from 'remotion';
import {themeAt} from '../lib/timeline';
import {Noise} from '../rb/Noise';

export const GRAIN_OPACITY = 0.025;

export const Grain: React.FC = () => {
  const frame = useCurrentFrame();
  return themeAt(frame) === 'dark' ? <Noise frame={frame} opacity={GRAIN_OPACITY} /> : null;
};
