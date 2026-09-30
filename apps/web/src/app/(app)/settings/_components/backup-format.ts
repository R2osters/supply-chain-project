/** What the desktop shell returns for Settings → Sauvegarde (apps/desktop/src-tauri/src/backup). */
export interface BackupCounts {
  shipments: number;
  purchaseOrders: number;
  users: number;
}

export interface BackupInfo {
  name: string;
  createdAt: string;
  sizeBytes: number;
  company: string | null;
  appVersion: string;
  latestMigration: string | null;
  counts: BackupCounts;
  files: number;
  safety: boolean;
}

export interface RestoreResult {
  ok: boolean;
  archive: string;
  at: string;
  message: string;
}

export interface BackupsView {
  directory: string;
  embedded: boolean;
  backups: BackupInfo[];
  lastRestore: RestoreResult | null;
}

export { desktopInvoke } from '@/lib/desktop';

const UNITS = { fr: ['o', 'ko', 'Mo', 'Go'], en: ['B', 'kB', 'MB', 'GB'] } as const;

/** 1 275 904 → "1,3 Mo" (fr) or "1.3 MB" (en); decimal units, one decimal from kilo up. */
export function formatBytes(bytes: number, locale: string): string {
  const units = locale.startsWith('fr') ? UNITS.fr : UNITS.en;
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : 1;
  return `${value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[unit]}`;
}
