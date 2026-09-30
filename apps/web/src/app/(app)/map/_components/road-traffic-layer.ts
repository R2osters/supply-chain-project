/**
 * The simulated road traffic, drawn as points in a MapLibre custom WebGL layer.
 *
 * A GeoJSON source rebuilt every frame would re-tile thousands of points in a worker sixty times a
 * second; a custom layer uploads one small buffer instead. Being a map layer, it sits in the map's
 * own layer order: below the aircraft and vessels (inserted before them) and, like every GL layer,
 * below the fleet's HTML markers. The fleet can never be hidden by the traffic around it.
 */

import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';

export type DotBucket = 'free' | 'slow' | 'jam';
export type Rgba = readonly [number, number, number, number];
export type DotColours = Record<'none' | DotBucket, Rgba>;

/** What the layer needs from the simulation (structurally, `TrafficSimulation`). */
export interface DotSource {
  step(dtSeconds: number): void;
  forEachDot(visit: (lon: number, lat: number, bucket: DotBucket | null) => void): void;
}

/** Mercator x, y, then premultiplied r, g, b, a. */
export const FLOATS_PER_DOT = 6;
/** A frame longer than this (tab switch, breakpoint) must not teleport every car. */
const MAX_FRAME_S = 0.25;

/** Longitude/latitude to MapLibre's mercator world square (0..1 on both axes). */
export function mercator(lon: number, lat: number): [number, number] {
  const phi = (Math.max(-85.051129, Math.min(85.051129, lat)) * Math.PI) / 180;
  return [(lon + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2];
}

/** `#rrggbb` or `#rgb` to 0..1 channels; anything else reads as a neutral grey. */
export function hexToRgba(hex: string, alpha: number): Rgba {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return [0.5, 0.5, 0.5, alpha];
  const digits = match[1].length === 3 ? [...match[1]].map((d) => d + d).join('') : match[1];
  const channel = (i: number) => parseInt(digits.slice(i * 2, i * 2 + 2), 16) / 255;
  return [channel(0), channel(1), channel(2), alpha];
}

/**
 * Charter colours: estimated roads in the muted ink, quieter than the measured ones, which take
 * the status colours (ok / warn / crit), so a real jam reads at a glance.
 */
export function trafficColours(palette: { muted: string; ok: string; warn: string; crit: string }): DotColours {
  return {
    none: hexToRgba(palette.muted, 0.7),
    free: hexToRgba(palette.ok, 0.95),
    slow: hexToRgba(palette.warn, 0.95),
    jam: hexToRgba(palette.crit, 0.95),
  };
}

/**
 * Writes every dot into `out` (grown if too small) and returns the buffer and the dot count.
 * Positions are relative to `origin` (mercator, float64): float32 steps near 0.5 are ~6e-8, which
 * is several pixels at street zoom, while offsets from the view centre stay tiny and exact.
 */
export function packDots(
  source: DotSource,
  colours: DotColours,
  out?: Float32Array,
  origin: readonly [number, number] = [0, 0],
): { data: Float32Array; count: number } {
  let data = out ?? new Float32Array(1024 * FLOATS_PER_DOT);
  let count = 0;
  source.forEachDot((lon, lat, bucket) => {
    if ((count + 1) * FLOATS_PER_DOT > data.length) {
      const grown = new Float32Array(Math.max(data.length * 2, (count + 1) * FLOATS_PER_DOT));
      grown.set(data);
      data = grown;
    }
    const [x, y] = mercator(lon, lat);
    const [r, g, b, a] = colours[bucket ?? 'none'];
    const at = count * FLOATS_PER_DOT;
    data[at] = x - origin[0];
    data[at + 1] = y - origin[1];
    data[at + 2] = r * a;
    data[at + 3] = g * a;
    data[at + 4] = b * a;
    data[at + 5] = a;
    count += 1;
  });
  return { data, count };
}

/**
 * `matrix × translate(ox, oy, 0)` in float64, for dots packed relative to (ox, oy). Column-major,
 * as WebGL and MapLibre store matrices: only the translation column changes.
 */
export function translateMatrix(matrix: ArrayLike<number>, ox: number, oy: number): Float32Array {
  const out = Float32Array.from(matrix as ArrayLike<number>);
  for (let row = 0; row < 4; row += 1) {
    out[12 + row] = matrix[row] * ox + matrix[4 + row] * oy + matrix[12 + row];
  }
  return out;
}

/** Dot diameter in CSS pixels: a speck at city scale, a small car at street scale. */
export function dotSize(zoom: number): number {
  return Math.min(6, Math.max(1.5, 1.5 + (zoom - 12) * 0.9));
}

const VERTEX_SHADER = `
attribute vec2 a_pos;
attribute vec4 a_color;
uniform mat4 u_matrix;
uniform float u_size;
varying vec4 v_color;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
  gl_PointSize = u_size;
  v_color = a_color;
}`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec4 v_color;
void main() {
  vec2 offset = gl_PointCoord - vec2(0.5);
  if (dot(offset, offset) > 0.25) discard;
  gl_FragColor = v_color;
}`;

export interface RoadTrafficLayer extends CustomLayerInterface {
  /** Off: nothing is drawn or stepped, and the map stops repainting for us. */
  setActive(active: boolean): void;
}

export function createRoadTrafficLayer(id: string, source: DotSource, colours: () => DotColours): RoadTrafficLayer {
  let map: MapLibreMap | null = null;
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let locations: { pos: number; color: number; matrix: WebGLUniformLocation | null; size: WebGLUniformLocation | null } | null =
    null;
  let packed: Float32Array | undefined;
  /** Bytes allocated on the GPU; grown when the dots outgrow it, otherwise updated in place. */
  let capacity = 0;
  let lastFrame = 0;
  let active = true;

  return {
    id,
    type: 'custom',
    renderingMode: '2d',

    onAdd(instance: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
      map = instance;
      program = link(gl, VERTEX_SHADER, FRAGMENT_SHADER);
      buffer = gl.createBuffer();
      if (program) {
        locations = {
          pos: gl.getAttribLocation(program, 'a_pos'),
          color: gl.getAttribLocation(program, 'a_color'),
          matrix: gl.getUniformLocation(program, 'u_matrix'),
          size: gl.getUniformLocation(program, 'u_size'),
        };
      }
    },

    render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput) {
      if (!active || !program || !buffer || !locations || !map) return;

      const now = performance.now();
      const dt = lastFrame === 0 ? 0 : Math.min(MAX_FRAME_S, (now - lastFrame) / 1000);
      lastFrame = now;
      source.step(dt);

      const centre = map.getCenter();
      const origin = mercator(centre.lng, centre.lat);
      const { data, count } = packDots(source, colours(), packed, origin);
      packed = data;
      if (count === 0) return; // nothing to move: no repaint loop until setActive or new roads

      const stride = FLOATS_PER_DOT * Float32Array.BYTES_PER_ELEMENT;
      const view = data.subarray(0, count * FLOATS_PER_DOT);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      if (view.byteLength > capacity) {
        capacity = data.byteLength;
        gl.bufferData(gl.ARRAY_BUFFER, capacity, gl.DYNAMIC_DRAW);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, view);
      gl.enableVertexAttribArray(locations.pos);
      gl.vertexAttribPointer(locations.pos, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(locations.color);
      gl.vertexAttribPointer(locations.color, 4, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
      // mainMatrix takes mercator 0..1 coordinates (modelViewProjectionMatrix expects world pixels).
      gl.uniformMatrix4fv(locations.matrix, false, translateMatrix(options.defaultProjectionData.mainMatrix, origin[0], origin[1]));
      gl.uniform1f(locations.size, dotSize(map.getZoom()) * (window.devicePixelRatio || 1));
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.disableVertexAttribArray(locations.pos);
      gl.disableVertexAttribArray(locations.color);

      // Keep the cars moving. A hidden tab pauses animation frames on its own.
      map.triggerRepaint();
    },

    onRemove(_instance: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
      capacity = 0;
      if (buffer) gl.deleteBuffer(buffer);
      if (program) gl.deleteProgram(program);
      buffer = null;
      program = null;
      locations = null;
      map = null;
    },

    setActive(next: boolean) {
      if (next && active) {
        map?.triggerRepaint(); // new roads: restart a loop that stopped on an empty view
        return;
      }
      active = next;
      lastFrame = 0;
      if (next) map?.triggerRepaint();
    },
  };
}

function link(gl: WebGLRenderingContext | WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram | null {
  const compile = (type: number, text: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, text);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('Road traffic shader failed to compile', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };
  const vs = compile(gl.VERTEX_SHADER, vertex);
  const fs = compile(gl.FRAGMENT_SHADER, fragment);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('Road traffic shader failed to link', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}
