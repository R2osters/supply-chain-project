// src/scenes/mapView.ts — the map camera shared by S09 (Ghana) and S10 (Baltic, world). Same semantics as WorldMap's
// `view`: scale about the frame centre, then shift by (x, y) screen pixels. The Ghana and Baltic crops are clipped exactly
// to the 1920 × 1080 frame, with no overscan (task 9): a view of either must keep scale ≥ 1 and cover the whole frame,
// otherwise the crop's hard edge would show. `coversFrame` is that rule; `coveringView` enforces it.
import type {MapView} from '../components/WorldMap';

export const FRAME_W = 1920;
export const FRAME_H = 1080;
const CX = FRAME_W / 2;
const CY = FRAME_H / 2;

export interface Point { x: number; y: number }

/** Screen position of a map point under `view`. */
export const toScreen = (p: Point, v: MapView): Point => ({x: (p.x - CX) * v.scale + CX + v.x, y: (p.y - CY) * v.scale + CY + v.y});

/** Map point under a screen position (the inverse of `toScreen`). */
export const fromScreen = (s: Point, v: MapView): Point => ({x: (s.x - CX - v.x) / v.scale + CX, y: (s.y - CY - v.y) / v.scale + CY});

/** True when the map's 1920 × 1080 extent, seen through `view`, still covers the whole frame. */
export const coversFrame = (v: MapView, eps = 1e-9): boolean =>
  v.scale >= 1 - eps && Math.abs(v.x) <= CX * (v.scale - 1) + eps && Math.abs(v.y) <= CY * (v.scale - 1) + eps;

/**
 * The view at `scale` (at least 1) that puts map point `anchor` as close as it can to screen point `target` while still
 * covering the frame.
 */
export const coveringView = (anchor: Point, target: Point, scale: number): MapView => {
  const s = Math.max(1, scale);
  const clamp = (v: number, m: number) => Math.min(m, Math.max(-m, v));
  return {
    scale: s,
    x: clamp(target.x - CX - (anchor.x - CX) * s, CX * (s - 1)),
    y: clamp(target.y - CY - (anchor.y - CY) * s, CY * (s - 1)),
  };
};

/** SVG transform of a map group under `view` (identical to WorldMap's). */
export const viewTransform = (v: MapView): string =>
  `translate(${v.x + CX} ${v.y + CY}) scale(${v.scale}) translate(${-CX} ${-CY})`;
