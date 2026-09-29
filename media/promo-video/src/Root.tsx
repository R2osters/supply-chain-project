// src/Root.tsx (stub)
import {AbsoluteFill, Composition} from 'remotion';

const Blank: React.FC = () => <AbsoluteFill style={{background: '#121314'}} />;

export const Root: React.FC = () => (
  <Composition id="SignalVideo" component={Blank} durationInFrames={5100} fps={30} width={1920} height={1080} />
);
