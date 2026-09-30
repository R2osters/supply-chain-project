// src/Root.tsx — registers the film. theme/fonts is imported for its side effect: it loads the seven Plex faces and
// holds the render until they are ready.
import {Composition} from 'remotion';
import './theme/fonts';
import {FPS, TOTAL_FRAMES} from './lib/beat';
import {Video} from './Video';

export const Root: React.FC = () => (
  <Composition id="SignalVideo" component={Video} durationInFrames={TOTAL_FRAMES} fps={FPS} width={1920} height={1080} />
);
