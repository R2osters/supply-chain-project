// Adapted from React Bits Radar (https://reactbits.dev), MIT + Commons Clause. Rewritten to be a pure function of the Remotion frame.
// Original: an ogl full-screen triangle redrawn on every display frame with uTime = wall-clock seconds, plus mouse
// parallax. Here uTime = frame / fps and the canvas is redrawn synchronously in a layout effect on every render, with
// preserveDrawingBuffer so the capture sees the pixels; the render is held (delayRender) until the program has linked.
// The mouse is gone (uMouse stays centred). The shader is the original, with one added branch, `uInk`: the colour at
// alpha = intensity, so an ink-coloured sweep can darken a light scene (the original modes only add light).
import {Mesh, Program, Renderer, Triangle} from 'ogl';
import {useLayoutEffect, useRef, useState, type CSSProperties} from 'react';
import {cancelRender, continueRender, delayRender, useVideoConfig} from 'remotion';

export interface RadarProps {
  frame: number;
  fps: number;
  /** Hex colour (required: the original default was a violet, which the charter reserves for demo data). */
  color: string;
  /** CSS opacity of the whole canvas. */
  opacity?: number;
  /** Canvas size in px; defaults to the composition size. */
  width?: number;
  height?: number;
  speed?: number;
  scale?: number;
  ringCount?: number;
  spokeCount?: number;
  ringThickness?: number;
  spokeThickness?: number;
  sweepSpeed?: number;
  sweepWidth?: number;
  sweepLobes?: number;
  backgroundColor?: string;
  falloff?: number;
  brightness?: number;
  lightMode?: boolean;
  /** Draw `color` with alpha = intensity (for ink on a light scene). Takes precedence over lightMode. */
  ink?: boolean;
  style?: CSSProperties;
}

function hexToVec3(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

const vertexShader = `
attribute vec2 uv;
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0, 1);
}
`;

const fragmentShader = `
precision highp float;

uniform float uTime;
uniform vec3 uResolution;
uniform float uSpeed;
uniform float uScale;
uniform float uRingCount;
uniform float uSpokeCount;
uniform float uRingThickness;
uniform float uSpokeThickness;
uniform float uSweepSpeed;
uniform float uSweepWidth;
uniform float uSweepLobes;
uniform vec3 uColor;
uniform vec3 uBgColor;
uniform bool uLightMode;
uniform bool uInk;
uniform float uFalloff;
uniform float uBrightness;
uniform vec2 uMouse;
uniform float uMouseInfluence;
uniform bool uEnableMouse;

#define TAU 6.28318530718
#define PI 3.14159265359

void main() {
  vec2 st = gl_FragCoord.xy / uResolution.xy;
  st = st * 2.0 - 1.0;
  st.x *= uResolution.x / uResolution.y;

  if (uEnableMouse) {
    vec2 mShift = (uMouse * 2.0 - 1.0);
    mShift.x *= uResolution.x / uResolution.y;
    st -= mShift * uMouseInfluence;
  }

  st *= uScale;

  float dist = length(st);
  float theta = atan(st.y, st.x);
  float t = uTime * uSpeed;

  float ringPhase = dist * uRingCount - t;
  float ringDist = abs(fract(ringPhase) - 0.5);
  float ringGlow = 1.0 - smoothstep(0.0, uRingThickness, ringDist);

  float spokeAngle = abs(fract(theta * uSpokeCount / TAU + 0.5) - 0.5) * TAU / uSpokeCount;
  float arcDist = spokeAngle * dist;
  float spokeGlow = (1.0 - smoothstep(0.0, uSpokeThickness, arcDist)) * smoothstep(0.0, 0.1, dist);

  float sweepPhase = t * uSweepSpeed;
  float sweepBeam = pow(max(0.5 * sin(uSweepLobes * theta + sweepPhase) + 0.5, 0.0), uSweepWidth);

  float fade = smoothstep(1.05, 0.85, dist) * pow(max(1.0 - dist, 0.0), uFalloff);

  float intensity = max((ringGlow + spokeGlow + sweepBeam) * fade * uBrightness, 0.0);
  if (uInk) {
    gl_FragColor = vec4(uColor, clamp(intensity, 0.0, 1.0));
    return;
  }
  vec3 signal = uColor * intensity;
  vec3 col;
  if (uLightMode) {
    vec3 mapped = vec3(1.0) - exp(-max(signal, vec3(0.0)) * 1.45);
    float energy = clamp(max(mapped.r, max(mapped.g, mapped.b)), 0.0, 1.0);
    vec3 hue = mapped / max(energy, 0.0001);
    hue = pow(clamp(hue, 0.0, 1.0), vec3(1.2));
    col = mix(uBgColor, hue, smoothstep(0.015, 0.8, energy) * 0.96);
    gl_FragColor = vec4(col, 1.0);
  } else {
    col = signal + uBgColor;
    float alpha = clamp(length(col), 0.0, 1.0);
    gl_FragColor = vec4(col, alpha);
  }
}
`;

interface Gl { renderer: Renderer; program: Program; mesh: Mesh }

export const Radar: React.FC<RadarProps> = ({
  frame,
  fps,
  color,
  opacity = 1,
  width,
  height,
  speed = 1.0,
  scale = 0.5,
  ringCount = 10.0,
  spokeCount = 10.0,
  ringThickness = 0.05,
  spokeThickness = 0.01,
  sweepSpeed = 1.0,
  sweepWidth = 2.0,
  sweepLobes = 1.0,
  backgroundColor = '#000000',
  falloff = 2.0,
  brightness = 1.0,
  lightMode = false,
  ink = false,
  style,
}) => {
  const video = useVideoConfig();
  const w = width ?? video.width;
  const h = height ?? video.height;
  const containerRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<Gl | null>(null);
  const [handle] = useState(() => delayRender('Radar: compiling the WebGL program'));
  const held = useRef(true);

  // Context and program, once per mount.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const renderer = new Renderer({alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, dpr: 1});
    const gl = renderer.gl;
    if (!gl) {
      cancelRender(new Error('Radar: WebGL is unavailable'));
      return undefined;
    }
    gl.clearColor(0, 0, 0, 0);
    const program = new Program(gl, {
      vertex: vertexShader,
      fragment: fragmentShader,
      uniforms: {
        uTime: {value: 0},
        uResolution: {value: [1, 1, 1]},
        uSpeed: {value: speed},
        uScale: {value: scale},
        uRingCount: {value: ringCount},
        uSpokeCount: {value: spokeCount},
        uRingThickness: {value: ringThickness},
        uSpokeThickness: {value: spokeThickness},
        uSweepSpeed: {value: sweepSpeed},
        uSweepWidth: {value: sweepWidth},
        uSweepLobes: {value: sweepLobes},
        uColor: {value: hexToVec3(color)},
        uBgColor: {value: hexToVec3(backgroundColor)},
        uLightMode: {value: lightMode},
        uInk: {value: ink},
        uFalloff: {value: falloff},
        uBrightness: {value: brightness},
        uMouse: {value: new Float32Array([0.5, 0.5])},
        uMouseInfluence: {value: 0},
        uEnableMouse: {value: false},
      },
    });
    if (!gl.getProgramParameter(program.program, gl.LINK_STATUS)) {
      cancelRender(new Error(`Radar: the WebGL program did not link: ${gl.getProgramInfoLog(program.program)}`));
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
    u.uTime.value = frame / fps;
    u.uResolution.value = [canvas.width, canvas.height, canvas.width / canvas.height];
    u.uSpeed.value = speed;
    u.uScale.value = scale;
    u.uRingCount.value = ringCount;
    u.uSpokeCount.value = spokeCount;
    u.uRingThickness.value = ringThickness;
    u.uSpokeThickness.value = spokeThickness;
    u.uSweepSpeed.value = sweepSpeed;
    u.uSweepWidth.value = sweepWidth;
    u.uSweepLobes.value = sweepLobes;
    u.uColor.value = hexToVec3(color);
    u.uBgColor.value = hexToVec3(backgroundColor);
    u.uLightMode.value = lightMode;
    u.uInk.value = ink;
    u.uFalloff.value = falloff;
    u.uBrightness.value = brightness;
    renderer.render({scene: mesh});
    if (held.current) {
      held.current = false;
      continueRender(handle);
    }
  });

  return <div ref={containerRef} className="radar-container" style={{width: w, height: h, opacity, ...style}} />;
};
