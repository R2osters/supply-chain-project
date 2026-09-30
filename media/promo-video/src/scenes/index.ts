// src/scenes/index.ts — the scene registry, in film order. Scene tasks replace their own Sxx file, never this one.
import type {SceneId} from '../lib/timeline';
import {S01Contretemps} from './S01Contretemps';
import {S02Partition} from './S02Partition';
import {S03DeuxQuestions} from './S03DeuxQuestions';
import {S04Relier} from './S04Relier';
import {S05FausseNote} from './S05FausseNote';
import {S06Boucle1} from './S06Boucle1';
import {S07Boucle2} from './S07Boucle2';
import {S08Drop} from './S08Drop';
import {S09Route} from './S09Route';
import {S10MerAir} from './S10MerAir';
import {S11Console} from './S11Console';
import {S12Modeles} from './S12Modeles';
import {S13Clavier} from './S13Clavier';
import {S14Pont} from './S14Pont';
import {S15Fichier} from './S15Fichier';
import {S16HorsLigne} from './S16HorsLigne';
import {S17Reprise} from './S17Reprise';
import {S18Coda} from './S18Coda';

export const SCENES: Record<SceneId, React.FC> = {
  S01: S01Contretemps,
  S02: S02Partition,
  S03: S03DeuxQuestions,
  S04: S04Relier,
  S05: S05FausseNote,
  S06: S06Boucle1,
  S07: S07Boucle2,
  S08: S08Drop,
  S09: S09Route,
  S10: S10MerAir,
  S11: S11Console,
  S12: S12Modeles,
  S13: S13Clavier,
  S14: S14Pont,
  S15: S15Fichier,
  S16: S16HorsLigne,
  S17: S17Reprise,
  S18: S18Coda,
};
