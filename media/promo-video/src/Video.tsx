// src/Video.tsx — the film: one <Sequence> per scene on the grid of timeline.json, the incoming scene of every theme
// change wrapped in a ThemeWipe (the outgoing scene stays 15 frames longer, visible under the wipe), then the global
// overlays (grain on the dark scenes, HUD) and the master audio.
import {AbsoluteFill, Audio, Sequence, staticFile} from 'remotion';
import {sceneDef, sceneFrames, scenes, sceneStart, type SceneId} from './lib/timeline';
import {palette} from './theme/tokens';
import {SCENES} from './scenes';
import {Grain} from './components/Grain';
import {Hud} from './components/Hud';
import {startsWithWipe, ThemeWipe, WIPE_FRAMES} from './components/ThemeWipe';

export interface SceneSpan { id: SceneId; from: number; durationInFrames: number; wipe: boolean }

export const sceneSpans = (): SceneSpan[] =>
  scenes.map((s, i) => {
    const next = scenes[i + 1];
    const tail = next && startsWithWipe(next.id) ? WIPE_FRAMES : 0;
    return {id: s.id, from: sceneStart(s.id), durationInFrames: sceneFrames(s.id) + tail, wipe: startsWithWipe(s.id)};
  });

const SPANS = sceneSpans();

export const Video: React.FC = () => (
  <AbsoluteFill style={{background: palette(scenes[0].theme).bg}}>
    {SPANS.map(({id, from, durationInFrames, wipe}) => {
      const Scene = SCENES[id];
      const scene = sceneDef(id);
      return (
        <Sequence key={id} name={`${id} ${scene.title}`} from={from} durationInFrames={durationInFrames}>
          {wipe ? (
            <ThemeWipe theme={scene.theme}>
              <Scene />
            </ThemeWipe>
          ) : (
            <Scene />
          )}
        </Sequence>
      );
    })}
    <Grain />
    <Hud />
    <Audio src={staticFile('audio/master.wav')} />
  </AbsoluteFill>
);
