// Adapted from React Bits Threads (https://reactbits.dev), MIT + Commons Clause. Rewritten to be a pure function of the Remotion frame.
// Original: an ogl full-screen triangle redrawn on every display frame (paused off-screen by a visibility observer) with
// iTime = wall-clock seconds and mouse-driven drift. Here iTime = frame / fps, the caller drives `amplitude` (pluck
// envelopes), and the canvas is redrawn synchronously in a layout effect on every render, with preserveDrawingBuffer
// so the capture sees the pixels; the render is held (delayRender) until the program has linked. The mouse is gone
// (uMouse stays centred). The shader is the original.
import {Color, Mesh, Program, Renderer, Triangle} from 'ogl';
import {useLayoutEffect, useRef, useState, type CSSProperties} from 'react';
import {cancelRender, continueRender, delayRender, useVideoConfig} from 'remotion';

export interface ThreadsProps {
  frame: number;
  fps: number;
  /** Line amplitude (shader units, the original default was 1). */
  amplitude: number;
  /** Hex colour. */
  color: string;
  distance?: number;
  /** Canvas size in px; defaults to the composition size. */
  width?: number;
  height?: number;
  style?: CSSProperties;
}

const vertexShader = `
attribute vec2 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragmentShader = `
precision highp float;

uniform float iTime;
uniform vec3 iResolution;
uniform vec3 uColor;
uniform float uAmplitude;
uniform float uDistance;
uniform vec2 uMouse;

#define PI 3.1415926538

const int u_line_count = 40;
const float u_line_width = 7.0;
const float u_line_blur = 10.0;

float Perlin2D(vec2 P) {
    vec2 Pi = floor(P);
    vec4 Pf_Pfmin1 = P.xyxy - vec4(Pi, Pi + 1.0);
    vec4 Pt = vec4(Pi.xy, Pi.xy + 1.0);
    Pt = Pt - floor(Pt * (1.0 / 71.0)) * 71.0;
    Pt += vec2(26.0, 161.0).xyxy;
    Pt *= Pt;
    Pt = Pt.xzxz * Pt.yyww;
    vec4 hash_x = fract(Pt * (1.0 / 951.135664));
    vec4 hash_y = fract(Pt * (1.0 / 642.949883));
    vec4 grad_x = hash_x - 0.49999;
    vec4 grad_y = hash_y - 0.49999;
    vec4 grad_results = inversesqrt(grad_x * grad_x + grad_y * grad_y)
        * (grad_x * Pf_Pfmin1.xzxz + grad_y * Pf_Pfmin1.yyww);
    grad_results *= 1.4142135623730950;
    vec2 blend = Pf_Pfmin1.xy * Pf_Pfmin1.xy * Pf_Pfmin1.xy
               * (Pf_Pfmin1.xy * (Pf_Pfmin1.xy * 6.0 - 15.0) + 10.0);
    vec4 blend2 = vec4(blend, vec2(1.0 - blend));
    return dot(grad_results, blend2.zxzx * blend2.wwyy);
}

float pixel(float count, vec2 resolution) {
    return (1.0 / max(resolution.x, resolution.y)) * count;
}

float lineFn(vec2 st, float width, float perc, float offset, vec2 mouse, float time, float amplitude, float distance) {
    float split_offset = (perc * 0.4);
    float split_point = 0.1 + split_offset;

    float amplitude_normal = smoothstep(split_point, 0.7, st.x);
    float amplitude_strength = 0.5;
    float finalAmplitude = amplitude_normal * amplitude_strength
                           * amplitude * (1.0 + (mouse.y - 0.5) * 0.2);

    float time_scaled = time / 10.0 + (mouse.x - 0.5) * 1.0;
    float blur = smoothstep(split_point, split_point + 0.05, st.x) * perc;

    float xnoise = mix(
        Perlin2D(vec2(time_scaled, st.x + perc) * 2.5),
        Perlin2D(vec2(time_scaled, st.x + time_scaled) * 3.5) / 1.5,
        st.x * 0.3
    );

    float y = 0.5 + (perc - 0.5) * distance + xnoise / 2.0 * finalAmplitude;

    float line_start = smoothstep(
        y + (width / 2.0) + (u_line_blur * pixel(1.0, iResolution.xy) * blur),
        y,
        st.y
    );

    float line_end = smoothstep(
        y,
        y - (width / 2.0) - (u_line_blur * pixel(1.0, iResolution.xy) * blur),
        st.y
    );

    return clamp(
        (line_start - line_end) * (1.0 - smoothstep(0.0, 1.0, pow(perc, 0.3))),
        0.0,
        1.0
    );
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;

    float line_strength = 1.0;
    for (int i = 0; i < u_line_count; i++) {
        float p = float(i) / float(u_line_count);
        line_strength *= (1.0 - lineFn(
            uv,
            u_line_width * pixel(1.0, iResolution.xy) * (1.0 - p),
            p,
            (PI * 1.0) * p,
            uMouse,
            iTime,
            uAmplitude,
            uDistance
        ));
    }

    float colorVal = 1.0 - line_strength;
    fragColor = vec4(uColor * colorVal, colorVal);
}

void main() {
    mainImage(gl_FragColor, gl_FragCoord.xy);
}
`;

interface Gl { renderer: Renderer; program: Program; mesh: Mesh }

export const Threads: React.FC<ThreadsProps> = ({frame, fps, amplitude, color, distance = 0, width, height, style}) => {
  const video = useVideoConfig();
  const w = width ?? video.width;
  const h = height ?? video.height;
  const containerRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<Gl | null>(null);
  const [handle] = useState(() => delayRender('Threads: compiling the WebGL program'));
  const held = useRef(true);

  // Context and program, once per mount.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const renderer = new Renderer({alpha: true, preserveDrawingBuffer: true, dpr: 1});
    const gl = renderer.gl;
    if (!gl) {
      cancelRender(new Error('Threads: WebGL is unavailable'));
      return undefined;
    }
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const program = new Program(gl, {
      vertex: vertexShader,
      fragment: fragmentShader,
      uniforms: {
        iTime: {value: 0},
        iResolution: {value: new Color(1, 1, 1)},
        uColor: {value: new Color(color)},
        uAmplitude: {value: amplitude},
        uDistance: {value: distance},
        uMouse: {value: new Float32Array([0.5, 0.5])},
      },
    });
    if (!gl.getProgramParameter(program.program, gl.LINK_STATUS)) {
      cancelRender(new Error(`Threads: the WebGL program did not link: ${gl.getProgramInfoLog(program.program)}`));
      return undefined;
    }
    const mesh = new Mesh(gl, {geometry: new Triangle(gl), program});
    gl.canvas.style.display = 'block';
    container.appendChild(gl.canvas);
    glRef.current = {renderer, program, mesh};
    return () => {
      glRef.current = null;
      container.removeChild(gl.canvas);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
    // The context lives as long as the component; the draw effect below writes every uniform.
  }, []);

  // Draw, synchronously, on every render (every frame change and every prop change).
  useLayoutEffect(() => {
    const g = glRef.current;
    if (!g) return;
    const {renderer, program, mesh} = g;
    const {canvas} = renderer.gl;
    // Resizing clears the drawing buffer, so only when the size really changes.
    if (canvas.width !== w || canvas.height !== h) renderer.setSize(w, h);
    const u = program.uniforms;
    u.iTime.value = frame / fps;
    u.iResolution.value.set(canvas.width, canvas.height, canvas.width / canvas.height);
    u.uColor.value.set(color);
    u.uAmplitude.value = amplitude;
    u.uDistance.value = distance;
    renderer.render({scene: mesh});
    if (held.current) {
      held.current = false;
      continueRender(handle);
    }
  });

  return <div ref={containerRef} className="threads-container" style={{position: 'relative', width: w, height: h, ...style}} />;
};
