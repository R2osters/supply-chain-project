// src/lib/easing.ts
import {Easing} from 'remotion';

export const EASE_OUT = Easing.bezier(0.22, 1, 0.36, 1);
export const EASE_EXIT = Easing.bezier(0.64, 0, 0.78, 0);
export const EASE_INOUT = Easing.bezier(0.65, 0, 0.35, 1); // S05 ETA band only
export const EASE_IN = Easing.bezier(0.4, 0, 1, 1); // S03 collision only
