// src/rb/useOglFrame.ts — the frame-pure WebGL lifecycle shared by the ogl components (Radar, Threads).
// Written for this project, not adapted from React Bits. The rules of spec § 3.7 that make a WebGL still deterministic
// live here, once:
// - the render is held (delayRender) from the first render until the first draw;
// - the context is created once per mount, with preserveDrawingBuffer so the capture sees the pixels, and dpr 1 so
//   the canvas is exactly width × height;
// - a missing container, a missing WebGL context or a program that does not link cancels the render at once, with the
//   component's name, instead of leaving the hold to time out;
// - every render resizes if needed, writes every uniform and draws, synchronously, in a layout effect;
// - the canvas is resized only when its size really changes, because a resize clears the drawing buffer.
// `createOglFrame` holds that logic without React, so useOglFrame.test.ts checks it without a DOM; the hook only wires
// it to two layout effects.
import {Mesh, Program, Renderer, Triangle} from 'ogl';
import {useLayoutEffect, useRef, useState, type RefObject} from 'react';
import {cancelRender, continueRender, delayRender} from 'remotion';

export type UniformValue = number | boolean | number[] | Float32Array;
export type Uniforms = Record<string, UniformValue>;
/** Drawing-buffer size in device px (equal to the CSS size, since dpr is 1). */
export interface CanvasSize { width: number; height: number }
export interface OglShaders { vertex: string; fragment: string }
/** Every uniform the shaders read, for the current render, from the drawing-buffer size. */
export type UniformsAt = (canvas: CanvasSize) => Uniforms;

export interface OglFrame {
  /** Creates the context, the program and a full-screen triangle inside `container`; returns the teardown. */
  mount: (container: HTMLElement | null, shaders: OglShaders, width: number, height: number) => () => void;
  /** Resizes on a real change, writes every uniform, draws, and releases the render hold after the first draw. */
  draw: (width: number, height: number, uniforms: UniformsAt) => void;
}

interface Gl { renderer: Renderer; program: Program; mesh: Mesh }

const loseContext = (renderer: Renderer): void => {
  (renderer.gl.getExtension('WEBGL_lose_context') as WEBGL_lose_context | null)?.loseContext();
};

export const createOglFrame = (name: string): OglFrame => {
  const handle = delayRender(`${name}: compiling the WebGL program`);
  const fail = (reason: string): never => cancelRender(new Error(`${name}: ${reason}`));
  let held = true;
  let current: Gl | null = null;

  return {
    mount(container, {vertex, fragment}, width, height) {
      if (!container) return fail('no container to hold the WebGL canvas');
      let renderer: Renderer;
      try {
        // ogl throws a bare TypeError when neither webgl2 nor webgl is available.
        renderer = new Renderer({alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, dpr: 1, width, height});
      } catch (error) {
        return fail(`WebGL is unavailable (${error instanceof Error ? error.message : String(error)})`);
      }
      const {gl} = renderer;
      gl.clearColor(0, 0, 0, 0);
      // The uniform slots are filled by the first draw, which runs before anything reads them.
      const program = new Program(gl, {vertex, fragment, uniforms: {}});
      if (!gl.getProgramParameter(program.program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program.program);
        loseContext(renderer);
        return fail(`the WebGL program did not link: ${log}`);
      }
      const mesh = new Mesh(gl, {geometry: new Triangle(gl), program});
      gl.canvas.style.display = 'block';
      container.appendChild(gl.canvas);
      current = {renderer, program, mesh};
      return () => {
        current = null;
        container.removeChild(gl.canvas);
        loseContext(renderer);
      };
    },

    draw(width, height, uniforms) {
      if (!current) return;
      const {renderer, program, mesh} = current;
      // Compared with the size ogl was given (not the canvas's integer px), so a fractional size does not resize
      // on every frame.
      if (renderer.width !== width || renderer.height !== height) renderer.setSize(width, height);
      const {canvas} = renderer.gl;
      for (const [key, value] of Object.entries(uniforms({width: canvas.width, height: canvas.height}))) {
        const slot = program.uniforms[key] as {value: UniformValue} | undefined;
        if (slot) slot.value = value;
        else program.uniforms[key] = {value};
      }
      renderer.render({scene: mesh});
      if (held) {
        held = false;
        continueRender(handle);
      }
    },
  };
};

export interface OglFrameOptions extends OglShaders {
  /** Component name, for the delayRender label and the error messages. */
  name: string;
  /** Canvas size in CSS px. */
  width: number;
  height: number;
  uniforms: UniformsAt;
}

/** Mounts an ogl canvas in the returned container ref and redraws it on every render. */
export const useOglFrame = ({name, vertex, fragment, width, height, uniforms}: OglFrameOptions): RefObject<HTMLDivElement | null> => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ogl] = useState(() => createOglFrame(name));
  // Once per mount: the shaders and the first size are read here; the draw below resizes and writes every uniform.
  useLayoutEffect(() => ogl.mount(containerRef.current, {vertex, fragment}, width, height), [ogl]);
  // Every render (every frame and every prop change), synchronously, so the capture sees this frame's pixels.
  useLayoutEffect(() => ogl.draw(width, height, uniforms));
  return containerRef;
};
