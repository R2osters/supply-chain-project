// src/rb/rb.test.ts — the adapted React Bits components must be pure functions of the Remotion frame (spec § 3.7).
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {counterPlaces, Counter, digitPosition} from './Counter';
import {CountUp} from './CountUp';
import {decryptedChars, DecryptedText} from './DecryptedText';
import {HoldButton} from './HoldButton';
import {fillNoise} from './Noise';
import {rotatingIndex, RotatingText} from './RotatingText';
import {flapTiles, SplitFlapText} from './SplitFlapText';
import {splitEntry, SplitText} from './SplitText';
import {StatusMark} from './StatusMark';
import {cursorOn, typedCount, TextType} from './TextType';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const NAMES = [
  'SplitText', 'SplitFlapText', 'DecryptedText', 'CountUp', 'HoldButton', 'RotatingText',
  'Radar', 'Counter', 'Threads', 'TextType', 'StatusMark', 'Noise',
] as const;
const FORBIDDEN = [
  'Math.random', 'Date.now', 'performance.now', 'requestAnimationFrame', 'setInterval', 'setTimeout',
  "from 'motion", 'from "motion', 'gsap', 'IntersectionObserver',
];
// CSS animations and transitions run on the browser's wall clock, so they are as forbidden as timers.
const WALL_CLOCK_CSS = /@keyframes|\banimation\s*:|\btransition\s*:/;

const header = (name: string): string =>
  `// Adapted from React Bits ${name} (https://reactbits.dev), MIT + Commons Clause. Rewritten to be a pure function of the Remotion frame.`;
const sources = (): Array<[string, string]> =>
  readdirSync(DIR)
    .filter((f) => /\.(tsx|css)$/.test(f))
    .map((f) => [f, readFileSync(join(DIR, f), 'utf8')]);

describe('src/rb', () => {
  it.each(NAMES)('%s.tsx exists and keeps the origin and licence header', (name) => {
    const file = join(DIR, `${name}.tsx`);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8').split(/\r?\n/)[0]).toBe(header(name));
  });

  it('uses no wall clock, timer, observer, motion or gsap runtime', () => {
    const offenders = sources().flatMap(([f, src]) => FORBIDDEN.filter((token) => src.includes(token)).map((token) => `${f}: ${token}`));
    expect(offenders).toEqual([]);
  });

  it('uses no CSS animation or transition', () => {
    const offenders = sources().filter(([, src]) => WALL_CLOCK_CSS.test(src)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });
});

describe('frame-pure DOM components', () => {
  const html = (el: ReturnType<typeof createElement>): string => renderToStaticMarkup(el);
  // [name, element at a frame] — every one must render identically twice and move between frames 20 and 30.
  const cases: Array<[string, (frame: number) => ReturnType<typeof createElement>]> = [
    ['SplitText', (frame) => createElement(SplitText, {words: [{text: 'OÙ', at: 18}, {text: 'EST', at: 24}], frame, mode: 'chars'})],
    ['SplitFlapText', (frame) => createElement(SplitFlapText, {text: '14:02', frame, startFrame: 18, seed: 5})],
    ['DecryptedText', (frame) => createElement(DecryptedText, {from: 'EN ROUTE', to: 'EN RETARD', frame, startFrame: 20, durationFrames: 20, seed: 3})],
    ['HoldButton', (frame) => createElement(HoldButton, {label: 'ACCEPTER ET EXÉCUTER', fill: Math.min(1, frame / 40), pressed: 0, theme: 'dark'})],
    ['RotatingText', (frame) => createElement(RotatingText, {items: ['OBSERVER', 'RECALCULER'], frame, startFrame: 18, every: 10})],
    ['CountUp', (frame) => createElement(CountUp, {value: frame * 2.72, format: (n: number) => String(Math.floor(n + 0.5))})],
    ['Counter', (frame) => createElement(Counter, {value: frame * 0.7, digits: 2, decimals: 2, frame})],
    ['TextType', (frame) => createElement(TextType, {text: '@dataclass\nclass Recommendation:', frame, startFrame: 10})],
    ['StatusMark', (frame) => createElement(StatusMark, {state: 'progress', progress: frame / 40, label: 'API'})],
  ];
  it.each(cases)('%s renders the same markup for the same frame and moves with time', (_, at) => {
    expect(html(at(25))).toBe(html(at(25)));
    expect(html(at(20))).not.toBe(html(at(30)));
  });
});

describe('contract semantics', () => {
  it('Counter lands exactly on the WAPE digits of spec § 4 S12', () => {
    const places = counterPlaces(2, 2);
    expect(places).toEqual([10, 1, '.', 0.1, 0.01]);
    for (const [value, digits] of [[24.13, [2, 4, 1, 3]], [24.72, [2, 4, 7, 2]], [29.38, [2, 9, 3, 8]], [28.11, [2, 8, 1, 1]]] as const) {
      const shown = places.filter((p): p is number => p !== '.').map((p) => digitPosition(value, p, 0.01) % 10);
      expect(shown).toEqual(digits);
    }
  });

  it('Counter rolls like an odometer: a higher place moves only while the places below wrap', () => {
    expect(digitPosition(19.5, 10, 1)).toBeCloseTo(1.5); // tens roll with the units from 19 to 20
    expect(digitPosition(15, 10, 1)).toBe(1);
    expect(digitPosition(99.5, 100, 1)).toBeCloseTo(0.5);
  });

  it('DecryptedText shows `from` before its start, `to` after its end, and scrambles in between', () => {
    const at = (frame: number): string => decryptedChars('EN ROUTE', 'EN RETARD', frame, 10, {seed: 1, durationFrames: 12}).map((c) => c.char).join('');
    expect(at(9)).toBe('EN ROUTE');
    expect(at(22)).toBe('EN RETARD');
    expect(at(10)).toHaveLength(9);
    expect(at(10)).not.toBe(at(11));
  });

  it('SplitFlapText settles on its text after the last flip of the last tile', () => {
    // 5 tiles, 8 random flips + the target, 3 frames per flip, 3 frames of stagger: last tile done at 18 + 12 + 27.
    const text = (frame: number): string => flapTiles('14:02', frame, 18, {seed: 5}).map((t) => t.current).join('');
    expect(text(17)).toBe('     ');
    expect(text(18 + 12 + 27)).toBe('14:02');
    expect(flapTiles('14:02', 18 + 12 + 26, 18, {seed: 5})[4].flipping).toBe(true);
  });

  it('TextType starts on startFrame, and endFrame caps the completion', () => {
    expect(typedCount(10, 4, 5)).toBe(0);
    expect(typedCount(10, 5, 5)).toBe(1);
    expect(typedCount(100, 14, 5, 1, 14)).toBe(100);
    expect(typedCount(100, 13, 5, 1, 14)).toBeLessThan(100);
    expect(typedCount(3, 30, 5, 1, 14)).toBe(3);
    expect([0, 7, 8, 15, 16].map(cursorOn)).toEqual([true, true, false, false, true]);
  });

  it('RotatingText steps one item per `every` frames and holds the last one', () => {
    expect(rotatingIndex(9, 10, 15, 5)).toBeNull();
    expect([10, 24, 25, 70, 200].map((f) => rotatingIndex(f, 10, 15, 5))).toEqual([0, 0, 1, 4, 4]);
    expect(rotatingIndex(85, 10, 15, 5, true)).toBe(0);
  });

  it('SplitText entry starts hidden and lands at rest', () => {
    expect(splitEntry(9, 10)).toEqual({opacity: 0, y: 40, scale: 1});
    const end = splitEntry(18, 10);
    expect(end.opacity).toBe(1);
    expect(end.y).toBe(0);
    expect(end.scale).toBeCloseTo(1);
  });

  it('Noise fills the tile from the frame seed', () => {
    const tile = (frame: number): Uint8ClampedArray => {
      const data = new Uint8ClampedArray(16 * 16 * 4);
      fillNoise(data, frame);
      return data;
    };
    expect(tile(3)).toEqual(tile(3));
    expect(tile(3)).not.toEqual(tile(4));
  });
});
