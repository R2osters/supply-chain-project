// src/theme/tokens.ts — charter tokens (spec § 2). Signal colours are only used at their own cue.
export type Theme = 'light' | 'dark';
export type SignalColor = 'crit' | 'warn' | 'ok' | 'live' | 'info' | 'demo' | 'ink';
export interface Palette { bg: string; surface: string; surface2: string; line: string; ink: string; action: string; actionText: string; muted: string; dim: string; map: string }

const PALETTES: Record<Theme, Palette> = {
  light: {bg: '#e3e4e6', surface: '#f1f2f3', surface2: '#ffffff', line: '#d6d8db', ink: '#141516', action: '#141516', actionText: '#ffffff', muted: '#5c6166', dim: '#747a80', map: '#dcdee1'},
  dark: {bg: '#121314', surface: '#1b1c1e', surface2: '#242528', line: '#2c2e31', ink: '#ececec', action: '#f2f2f2', actionText: '#111213', muted: '#9a9ea3', dim: '#80858a', map: '#1a1b1d'},
};
const SIGNALS: Record<Theme, Record<Exclude<SignalColor, 'ink'>, string>> = {
  light: {crit: '#c8412f', warn: '#a8740f', ok: '#3f8a5c', live: '#2f8a55', info: '#3b6fb0', demo: '#6e56c9'},
  dark: {crit: '#e0685a', warn: '#d4a24a', ok: '#6fb58a', live: '#5fc98b', info: '#7aa7dc', demo: '#a993ec'},
};
export const palette = (t: Theme): Palette => PALETTES[t];
export const signal = (t: Theme, c: SignalColor): string => (c === 'ink' ? PALETTES[t].action : SIGNALS[t][c]);
export const demoBg = (t: Theme): string => (t === 'light' ? 'rgb(110 86 201 / 0.1)' : 'rgb(169 147 236 / 0.14)');
export const RADIUS = {xs: 4, sm: 6, md: 10, lg: 14} as const;
export const SHADOW = {
  light: {sm: '0 1px 2px rgb(0 0 0 / 0.08)', md: '0 6px 18px rgb(0 0 0 / 0.14)', lg: '0 20px 48px rgb(0 0 0 / 0.24)'},
  dark: {sm: '0 1px 2px rgb(0 0 0 / 0.4)', md: '0 6px 18px rgb(0 0 0 / 0.5)', lg: '0 20px 48px rgb(0 0 0 / 0.6)'},
} as const;
