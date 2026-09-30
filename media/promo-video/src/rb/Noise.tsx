// Adapted from React Bits Noise (https://reactbits.dev), MIT + Commons Clause. Rewritten to be a pure function of the Remotion frame.
// Original: a per-display-frame loop fills a 1024² canvas with unseeded random grey levels every other frame and
// stretches it over the viewport. Here a `size`² tile is filled from rand(frame, i), so the grain is seeded per frame,
// and tiled 1:1 over the canvas (createPattern) in a layout effect on every frame. The per-pixel alpha of the
// original becomes a single CSS opacity; the stylesheet is inlined.
import {useLayoutEffect, useRef, type CSSProperties} from 'react';
import {useVideoConfig} from 'remotion';
import {rand} from '../lib/prng';

export interface NoiseProps {
  frame: number;
  opacity?: number;
  /** Side of the noise tile in px. */
  size?: number;
  /** Canvas size in px; defaults to the composition size. */
  width?: number;
  height?: number;
  style?: CSSProperties;
}

/** Grey level of every pixel of the tile for `frame`, as opaque RGBA. */
export const fillNoise = (data: Uint8ClampedArray, frame: number): void => {
  for (let i = 0; i < data.length / 4; i++) {
    const v = Math.floor(rand(frame, i) * 256);
    data[4 * i] = v;
    data[4 * i + 1] = v;
    data[4 * i + 2] = v;
    data[4 * i + 3] = 255;
  }
};

export const Noise: React.FC<NoiseProps> = ({frame, opacity = 0.025, size = 256, width, height, style}) => {
  const video = useVideoConfig();
  const w = width ?? video.width;
  const h = height ?? video.height;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tileRef = useRef<HTMLCanvasElement | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const tile = tileRef.current ?? document.createElement('canvas');
    tileRef.current = tile;
    tile.width = size;
    tile.height = size;
    const tctx = tile.getContext('2d');
    if (!tctx) return;
    const image = tctx.createImageData(size, size);
    fillNoise(image.data, frame);
    tctx.putImageData(image, 0, 0);
    const pattern = ctx.createPattern(tile, 'repeat');
    if (!pattern) return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, w, h);
  }, [frame, size, w, h]);

  return (
    <canvas
      ref={canvasRef}
      className="noise-overlay"
      width={w}
      height={h}
      style={{position: 'absolute', left: 0, top: 0, width: w, height: h, pointerEvents: 'none', imageRendering: 'pixelated', opacity, ...style}}
    />
  );
};
