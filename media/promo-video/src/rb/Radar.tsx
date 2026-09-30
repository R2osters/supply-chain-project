// Adapted from React Bits Radar (https://reactbits.dev), MIT + Commons Clause. Rewritten to be a pure function of the Remotion frame.
// Original: an ogl full-screen triangle redrawn on every display frame with uTime = wall-clock seconds, plus mouse
// parallax. Here uTime = frame / fps, and the WebGL lifecycle (render hold until the program links, synchronous
// redraw on every render, preserveDrawingBuffer) is the shared one in ./useOglFrame. The mouse is gone (uMouse stays
// centred). The shader is the original, with one added branch, `uInk`: the colour at alpha = intensity, so an
// ink-coloured sweep can darken a light scene (the original modes only add light).
import type {CSSProperties} from 'react';
import {useVideoConfig} from 'remotion';
import {useOglFrame} from './useOglFrame';

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

const CENTRED = new Float32Array([0.5, 0.5]);

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
  const containerRef = useOglFrame({
    name: 'Radar',
    vertex: vertexShader,
    fragment: fragmentShader,
    width: w,
    height: h,
    uniforms: (canvas) => ({
      uTime: frame / fps,
      uResolution: [canvas.width, canvas.height, canvas.width / canvas.height],
      uSpeed: speed,
      uScale: scale,
      uRingCount: ringCount,
      uSpokeCount: spokeCount,
      uRingThickness: ringThickness,
      uSpokeThickness: spokeThickness,
      uSweepSpeed: sweepSpeed,
      uSweepWidth: sweepWidth,
      uSweepLobes: sweepLobes,
      uColor: hexToVec3(color),
      uBgColor: hexToVec3(backgroundColor),
      uLightMode: lightMode,
      uInk: ink,
      uFalloff: falloff,
      uBrightness: brightness,
      uMouse: CENTRED,
      uMouseInfluence: 0,
      uEnableMouse: false,
    }),
  });

  return <div ref={containerRef} className="radar-container" style={{width: w, height: h, opacity, ...style}} />;
};
