export const FPS = 30;
export const BPM = 120;
export const FRAMES_PER_BEAT = 15;
export const FRAMES_PER_BAR = 60;
export const SIXTEENTH = 3.75;
export const TOTAL_BARS = 85;
export const TOTAL_FRAMES = TOTAL_BARS * FRAMES_PER_BAR;

export type QuantizeUnit = '16th' | '8th' | 'beat' | 'bar';
const UNIT: Record<QuantizeUnit, number> = {'16th': SIXTEENTH, '8th': 7.5, beat: FRAMES_PER_BEAT, bar: FRAMES_PER_BAR};

export const roundHalfUp = (x: number): number => Math.floor(x + 0.5);

/** Bars, beats and sixteenths are 1-based, like a score. */
export const barToFrame = (bar: number, beat = 1, sixteenth = 1): number =>
  roundHalfUp((bar - 1) * FRAMES_PER_BAR + (beat - 1) * FRAMES_PER_BEAT + (sixteenth - 1) * SIXTEENTH);

export const barAt = (frame: number): number => Math.floor(frame / FRAMES_PER_BAR) + 1;
export const beatAt = (frame: number): number => Math.floor(frame / FRAMES_PER_BEAT);
export const beatPhase = (frame: number): number => (frame % FRAMES_PER_BEAT) / FRAMES_PER_BEAT;

export const quantize = (frame: number, unit: QuantizeUnit): number => {
  const u = UNIT[unit];
  return roundHalfUp(roundHalfUp(frame / u) * u);
};
