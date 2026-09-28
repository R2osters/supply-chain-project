'use client';

import { useEffect, useState } from 'react';
import { apiBlob } from '@/lib/api';
import type { Camera } from '@/lib/intel';
import { useFormat, useI18n } from '@/lib/i18n';
import { Panel } from '@/components/ui';

/** Never refresh faster than this, whatever the pack claims: the API caches frames for ~10 s. */
const MIN_REFRESH_MS = 10_000;

/**
 * Shows the latest still from one public camera and keeps it current.
 *
 * Frames come through our API (the upstream URL never reaches the browser) and need the bearer
 * token, so they are fetched as blobs and shown through object URLs. Each object URL is revoked
 * when replaced or on unmount — skipping that leaks one decoded JPEG per refresh for as long as
 * the tab stays open.
 */
export function CameraViewer({ camera, onClose }: { camera: Camera; onClose(): void }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current: string | null = null;
    let controller: AbortController | null = null;
    let cancelled = false;

    const load = async (): Promise<void> => {
      // A background tab has nobody watching; spending the camera's bandwidth on it is waste.
      if (document.visibilityState === 'hidden') return;
      controller?.abort();
      controller = new AbortController();
      try {
        const blob = await apiBlob(`/cameras/${encodeURIComponent(camera.id)}/frame`, controller.signal);
        if (cancelled) return;
        const next = URL.createObjectURL(blob);
        if (current) URL.revokeObjectURL(current);
        current = next;
        setFrameUrl(next);
        setLoadedAt(new Date());
        setFailed(false);
      } catch (error) {
        // Keep the last good picture on screen: a stale frame labelled with its time beats a
        // blank box when one refresh fails.
        if (!cancelled && !(error instanceof DOMException && error.name === 'AbortError')) setFailed(true);
      }
    };

    setFrameUrl(null);
    setLoadedAt(null);
    setFailed(false);
    void load();
    const timer = window.setInterval(load, Math.max(MIN_REFRESH_MS, camera.refreshSeconds * 1000));
    document.addEventListener('visibilitychange', load);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
      controller?.abort();
      if (current) URL.revokeObjectURL(current);
    };
  }, [camera.id, camera.refreshSeconds]);

  return (
    <Panel
      title={t('sit.camera.title')}
      actions={
        <button onClick={onClose} className="hover:text-[var(--color-signal)]">
          {t('sit.close')}
        </button>
      }
    >
      <div className="space-y-2.5 p-3.5">
        <div>
          <div className="text-[0.8125rem] text-[var(--color-ink)]">{camera.name}</div>
          <div className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
            {camera.pack}
            {camera.direction ? ` · ${camera.direction}` : ''}
            {camera.distanceKm !== undefined ? ` · ${fmt.num(camera.distanceKm, 1)} km` : ''}
          </div>
        </div>

        <div className="relative aspect-video w-full overflow-hidden border border-[var(--color-hairline)] bg-[var(--color-void)]">
          {frameUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a blob URL, not an optimisable asset
            <img src={frameUrl} alt={camera.name} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center font-mono text-[0.625rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
              {failed ? t('sit.camera.unavailable') : t('sit.camera.loading')}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
          <span>
            {loadedAt ? t('sit.camera.frameAt', { time: fmt.relative(loadedAt) }) : '—'}
            {failed && frameUrl ? ` · ${t('sit.camera.refreshFailed')}` : ''}
          </span>
          <span>{t('sit.camera.every', { s: Math.max(10, camera.refreshSeconds) })}</span>
        </div>

        <p className="text-[0.625rem] leading-relaxed text-[var(--color-ink-faint)]">{camera.attribution}</p>
        <p className="text-[0.625rem] leading-relaxed text-[var(--color-ink-faint)]">{t('sit.camera.privacy')}</p>
      </div>
    </Panel>
  );
}
