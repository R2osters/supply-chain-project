// src/theme/fonts.ts — the 7 local faces, loaded once at module import.
// loadFont() holds the render (delayRender) until each face is ready, so the first frame never falls back.
import {loadFont} from '@remotion/fonts';
import sans400 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2';
import sans500 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2';
import sans600 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2';
import cond500 from '@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-500-normal.woff2';
import cond600 from '@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-600-normal.woff2';
import mono400 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2';
import mono500 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2';

export const FONT = {sans: '"IBM Plex Sans"', condensed: '"IBM Plex Sans Condensed"', mono: '"IBM Plex Mono"'} as const;

const faces: Array<[string, string, string]> = [
  ['IBM Plex Sans', sans400, '400'], ['IBM Plex Sans', sans500, '500'], ['IBM Plex Sans', sans600, '600'],
  ['IBM Plex Sans Condensed', cond500, '500'], ['IBM Plex Sans Condensed', cond600, '600'],
  ['IBM Plex Mono', mono400, '400'], ['IBM Plex Mono', mono500, '500'],
];
export const fontsReady = Promise.all(faces.map(([family, url, weight]) => loadFont({family, url, weight, format: 'woff2'})));
