/** What the desktop shell reports about updates (apps/desktop/src-tauri/src/update/updater.rs). */
export type UpdateState =
  | { state: 'disabled' }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'upToDate' }
  | { state: 'downloading'; version: string; received: number; total: number }
  | { state: 'ready'; version: string; notes: string | null; pubDate: string | null }
  | { state: 'error'; message: string };

export type UpdateStatus = UpdateState & {
  current: string;
  lastCheck: string | null;
  /** The last check could not reach GitHub: offline, or no release yet. */
  offline: boolean;
};

export type UpdateTone = 'info' | 'ok' | 'warn' | 'alert';

export interface UpdateView {
  tone: UpdateTone;
  /** i18n key of the one-line summary. */
  key:
    | 'settings.update.disabled'
    | 'settings.update.idle'
    | 'settings.update.offline'
    | 'settings.update.checking'
    | 'settings.update.upToDate'
    | 'settings.update.downloading'
    | 'settings.update.ready'
    | 'settings.update.error';
  params: Record<string, string | number>;
  /** 0–100 while downloading. */
  percent: number | null;
  canCheck: boolean;
  canInstall: boolean;
}

/** One summary per state, so the panel and the toast say the same thing. */
export function updateView(status: UpdateStatus): UpdateView {
  const base = { params: {}, percent: null, canCheck: true, canInstall: false } as const;
  switch (status.state) {
    case 'disabled':
      return { ...base, tone: 'info', key: 'settings.update.disabled', canCheck: false };
    case 'idle':
      return status.offline
        ? { ...base, tone: 'info', key: 'settings.update.offline' }
        : { ...base, tone: 'info', key: 'settings.update.idle' };
    case 'checking':
      return { ...base, tone: 'info', key: 'settings.update.checking', canCheck: false };
    case 'upToDate':
      return { ...base, tone: 'ok', key: 'settings.update.upToDate', params: { version: status.current } };
    case 'downloading': {
      const percent = status.total > 0 ? Math.min(100, Math.floor((status.received / status.total) * 100)) : 0;
      return { ...base, tone: 'info', key: 'settings.update.downloading', params: { version: status.version, percent }, percent, canCheck: false };
    }
    case 'ready':
      return { ...base, tone: 'ok', key: 'settings.update.ready', params: { version: status.version }, canInstall: true };
    case 'error':
      return { ...base, tone: 'alert', key: 'settings.update.error', params: { message: status.message } };
  }
}

/** Remembers which version was already announced, so the toast shows once per version. */
export const TOASTED_KEY = 'scip.update.toasted';

export function shouldToast(status: UpdateStatus | undefined, alreadyToasted: string | null): string | null {
  if (!status || status.state !== 'ready') return null;
  return status.version === alreadyToasted ? null : status.version;
}
