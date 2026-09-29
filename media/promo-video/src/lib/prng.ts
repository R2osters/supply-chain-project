// src/lib/prng.ts — mulberry32 over a hashed key tuple; pure, so a frame renders identically every time.
const mix = (h: number, k: number): number => {
  h = Math.imul(h ^ Math.floor(k * 1000003), 0x9e3779b1);
  return (h ^ (h >>> 15)) >>> 0;
};
export const rand = (seed: number, ...keys: number[]): number => {
  let h = mix(0x811c9dc5, seed);
  for (const k of keys) h = mix(h, k);
  let t = (h + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
export const randRange = (min: number, max: number, seed: number, ...keys: number[]): number => min + (max - min) * rand(seed, ...keys);
