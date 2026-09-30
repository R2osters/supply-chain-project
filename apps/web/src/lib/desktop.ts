/** Bridge to the desktop shell (Tauri commands), present only inside SCIP's own window. */

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** The shell's command bridge, or null on a phone or in a plain browser. */
export function desktopInvoke(): Invoke | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__?.core?.invoke ?? null;
}

/** Tauri errors arrive as plain strings; anything else is shown as best we can. */
export function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
