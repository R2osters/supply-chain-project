import type { CameraPack } from '../camera.types';
import { calgaryPack } from './calgary.pack';
import { drivebcPack } from './drivebc.pack';
import { fintrafficPack } from './fintraffic.pack';
import { nswPack } from './nsw.pack';
import { ontario511Pack } from './ontario511.pack';
import { tflPack } from './tfl.pack';

/** Every pack this build knows. Which of them load is decided by `intel.cameraPacks`. */
export const ALL_CAMERA_PACKS: readonly CameraPack[] = [
  tflPack,
  fintrafficPack,
  ontario511Pack,
  drivebcPack,
  nswPack,
  calgaryPack,
];
