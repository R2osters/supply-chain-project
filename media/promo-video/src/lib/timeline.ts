import timeline from '../../timeline/timeline.json';
import cuesJson from '../../generated/cues.json';
import voJson from '../../generated/vo-timings.json';
import {barToFrame, FRAMES_PER_BAR} from './beat';
import type {SignalColor, Theme} from '../theme/tokens';

export type SceneId = 'S01'|'S02'|'S03'|'S04'|'S05'|'S06'|'S07'|'S08'|'S09'|'S10'|'S11'|'S12'|'S13'|'S14'|'S15'|'S16'|'S17'|'S18';
export interface SceneDef { id: SceneId; title: string; startBar: number; bars: number; theme: Theme; themeEnd?: Theme; section: string; vo: {screen: string; offsetSixteenths: number; rate?: string} | null }
export interface Cue { id: string; scene: SceneId; frame: number; color?: SignalColor; sound?: string; params?: Record<string, unknown>; seriesHead?: boolean }
export interface Word { screen: string; start: number; end: number }
interface Clip { file: string; startFrame: number; endFrame: number; rate: string; words: Word[] }

export const scenes = timeline.scenes as SceneDef[];
const cues = cuesJson as unknown as Record<string, Cue>;
const vo = voJson as unknown as Partial<Record<SceneId, Clip>>;

const byId = new Map(scenes.map((s) => [s.id, s]));
export const sceneDef = (id: SceneId): SceneDef => byId.get(id)!;
export const sceneStart = (id: SceneId): number => barToFrame(sceneDef(id).startBar);
export const sceneFrames = (id: SceneId): number => sceneDef(id).bars * FRAMES_PER_BAR;
export const sceneAtFrame = (frame: number): SceneDef =>
  scenes.find((s) => frame >= sceneStart(s.id) && frame < sceneStart(s.id) + sceneFrames(s.id)) ?? scenes[scenes.length - 1];
export const themeAt = (frame: number): Theme => sceneAtFrame(frame).theme;

export const cue = (id: string): Cue => {
  const c = cues[id];
  if (!c) throw new Error(`Unknown cue ${id}`);
  return c;
};
export const cueLocal = (sceneId: SceneId, id: string): number => cue(id).frame - sceneStart(sceneId);
export const seriesLocal = (sceneId: SceneId, baseId: string): number[] => {
  const out: number[] = [];
  for (let i = 1; cues[`${baseId}.${i}`]; i++) out.push(cues[`${baseId}.${i}`].frame - sceneStart(sceneId));
  return out;
};
/** Every coloured cue that is an actual event: plain cues and series elements, never a series head. */
const isSeriesHead = (id: string): boolean => cues[id]?.seriesHead === true;
export const coloredCuesStrict = (): Cue[] => Object.values(cues).filter((c) => c.color && !isSeriesHead(c.id));
/** Name used by the task interface list; identical to `coloredCuesStrict`. */
export const coloredCues = coloredCuesStrict;
export const wordsLocal = (sceneId: SceneId): Word[] => {
  const start = sceneStart(sceneId);
  return (vo[sceneId]?.words ?? []).map((w) => ({screen: w.screen, start: w.start - start, end: w.end - start}));
};
export const wordLocal = (sceneId: SceneId, screen: string, occurrence = 1): Word => {
  const hits = wordsLocal(sceneId).filter((w) => w.screen === screen);
  if (hits.length < occurrence) throw new Error(`${sceneId}: word ${screen} #${occurrence} not found`);
  return hits[occurrence - 1];
};
