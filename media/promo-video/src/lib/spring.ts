// src/lib/spring.ts — closed-form damped harmonic oscillator, identical to scripts/music/springs.py.
export interface SpringCfg { from: number; to: number; damping: number; stiffness: number; mass?: number }

export const dampedSpring = (frame: number, {from, to, damping, stiffness, mass = 1}: SpringCfg): number => {
  if (frame <= 0) return from;
  const t = frame / 30;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const x0 = from - to;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return to + Math.exp(-zeta * w0 * t) * x0 * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  return to + x0 * (1 + w0 * t) * Math.exp(-w0 * t); // critically damped fallback
};
