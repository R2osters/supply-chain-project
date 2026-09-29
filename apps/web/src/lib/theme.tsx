'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'scip.theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitialTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/**
 * The attribute on <html> is the source of truth (set before paint by the inline script in
 * app/layout.tsx); this provider only mirrors it into React so maps and charts, which need
 * literal colours rather than CSS variables, can re-render when it changes.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('light');

  useEffect(() => {
    setThemeState(readInitialTheme());
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode: the choice lasts for the session only */
    }
  }, []);

  const toggleTheme = useCallback(
    () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    [theme, setTheme],
  );

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside <ThemeProvider>');
  return context;
}

/**
 * Literal colours for MapLibre paint properties and canvas drawing, which cannot read CSS
 * variables. Values mirror the charte tokens exactly.
 */
export interface Palette {
  bg: string;
  surface: string;
  surface2: string;
  line: string;
  ink: string;
  muted: string;
  dim: string;
  map: string;
  accent: string;
  accentTx: string;
  info: string;
  crit: string;
  warn: string;
  ok: string;
  live: string;
  sim: string;
  /** Raster paint for the OSM base layer: greyscale, quiet enough to sit under data. */
  raster: {
    'raster-opacity': number;
    'raster-saturation': number;
    'raster-contrast': number;
    'raster-brightness-min': number;
    'raster-brightness-max': number;
  };
}

export const PALETTES: Record<Theme, Palette> = {
  light: {
    bg: '#e3e4e6',
    surface: '#f1f2f3',
    surface2: '#ffffff',
    line: '#d6d8db',
    ink: '#141516',
    muted: '#5c6166',
    dim: '#747a80',
    map: '#dcdee1',
    accent: '#141516',
    accentTx: '#ffffff',
    info: '#3b6fb0',
    crit: '#c8412f',
    warn: '#a8740f',
    ok: '#3f8a5c',
    live: '#2f8a55',
    sim: '#6e56c9',
    raster: {
      'raster-opacity': 0.9,
      'raster-saturation': -1,
      'raster-contrast': -0.15,
      'raster-brightness-min': 0.12,
      'raster-brightness-max': 1,
    },
  },
  dark: {
    bg: '#121314',
    surface: '#1b1c1e',
    surface2: '#242528',
    line: '#2c2e31',
    ink: '#ececec',
    muted: '#9a9ea3',
    dim: '#80858a',
    map: '#1a1b1d',
    accent: '#f2f2f2',
    accentTx: '#111213',
    info: '#7aa7dc',
    crit: '#e0685a',
    warn: '#d4a24a',
    ok: '#6fb58a',
    live: '#5fc98b',
    sim: '#a993ec',
    // Invert the brightness range so the light OSM tiles read as a dark map.
    raster: {
      'raster-opacity': 0.55,
      'raster-saturation': -1,
      'raster-contrast': 0.05,
      'raster-brightness-min': 1,
      'raster-brightness-max': 0.08,
    },
  },
};

export function usePalette(): Palette {
  return PALETTES[useTheme().theme];
}
