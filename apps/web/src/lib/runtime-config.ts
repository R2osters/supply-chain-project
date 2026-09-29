/**
 * Where the API lives, decided at runtime.
 *
 * The desktop app starts its own API on a free port chosen at launch, so the address cannot be
 * baked in at build time. Resolution order:
 * 1. `scip.runtime`, written by the Tauri splash screen before it opens the interface;
 * 2. the NEXT_PUBLIC_* variables of a browser build;
 * 3. the page's own origin — a driver's phone loads /drive from the desktop API itself;
 * 4. the `next dev` default, API on :3001 beside the UI on :3000.
 */

const RUNTIME_KEY = 'scip.runtime';

interface RuntimeConfig {
  apiUrl: string;
  wsUrl: string;
}

function readInjected(): Partial<RuntimeConfig> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(RUNTIME_KEY);
    return raw ? (JSON.parse(raw) as Partial<RuntimeConfig>) : {};
  } catch {
    // Unreadable storage or a malformed value: behave like a plain browser build.
    return {};
  }
}

const DEV_API_ORIGIN = 'http://localhost:3001';

/** Origin of the API when the page was served by the API itself; null under `next dev`. */
function sameOrigin(): string | null {
  if (typeof window === 'undefined' || !window.location.protocol.startsWith('http')) return null;
  return window.location.port === '3000' ? null : window.location.origin;
}

export function apiUrl(): string {
  return (
    readInjected().apiUrl ??
    process.env.NEXT_PUBLIC_API_URL ??
    `${sameOrigin() ?? DEV_API_ORIGIN}/api/v1`
  );
}

export function wsUrl(): string {
  return readInjected().wsUrl ?? process.env.NEXT_PUBLIC_WS_URL ?? sameOrigin() ?? DEV_API_ORIGIN;
}
