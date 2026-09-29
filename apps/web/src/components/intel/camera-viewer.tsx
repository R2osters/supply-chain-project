'use client';

import { Cctv, ImageOff, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiBlob } from '@/lib/api';
import type { Camera } from '@/lib/intel';
import { useFormat, useI18n } from '@/lib/i18n';
import { Button, Panel, Provenance, Skeleton } from '@/components/ui';

/** Never refresh faster than this, whatever the pack claims: the API caches frames for ~10 s. */
const MIN_REFRESH_MS = 10_000;

/**
 * Shows the latest still from one public camera and keeps it current.
 *
 * Frames come through our API (the upstream URL never reaches the browser) and need the bearer
 * token, so they are fetched as blobs and shown through object URLs. Each object URL is revoked
 * when replaced or on unmount — skipping that leaks one decoded JPEG per refresh for as long as
 * the tab stays open.
 *
 * Provenance follows the charte: a fresh frame is a polled source (hollow dot + interval); a
 * failed refresh keeps the last picture but marks it stale with its age.
 */
export function CameraViewer({ camera, onClose }: { camera: Camera; onClose(): void }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [failed, setFailed] = useState(false);
  const everySeconds = Math.max(MIN_REFRESH_MS / 1000, camera.refreshSeconds);

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
      icon={Cctv}
      title={t('sit.camera.title')}
      actions={<Button variant="ghost" size="sm" icon={X} onClick={onClose} aria-label={t('common.close')} />}
    >
      <div className="flex flex-col gap-3 px-5 pb-5 pt-2">
        <div className="flex flex-col gap-1">
          <p className="m-0 text-[15px] leading-snug text-[var(--color-ink)]">{camera.name}</p>
          <p className="m-0 flex flex-wrap items-center gap-x-2 text-[12px] text-[var(--color-muted)]">
            <span className="t-data text-[11px]">{camera.pack}</span>
            {camera.direction && (
              <>
                <span aria-hidden>·</span>
                <span>{camera.direction}</span>
              </>
            )}
            {camera.distanceKm !== undefined && (
              <>
                <span aria-hidden>·</span>
                <span className="t-data text-[11px]">{fmt.num(camera.distanceKm, 1)} km</span>
              </>
            )}
          </p>
        </div>

        <div className="relative aspect-video w-full overflow-hidden rounded-[var(--radius-md)] bg-[var(--color-surface-2)]">
          {frameUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a blob URL, not an optimisable asset
            <img key={frameUrl} src={frameUrl} alt={camera.name} className="fade-in h-full w-full object-cover" />
          ) : failed ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-[12.5px] text-[var(--color-muted)]">
              <ImageOff className="h-5 w-5" strokeWidth={1.75} />
              {t('sit.camera.unavailable')}
            </div>
          ) : (
            <Skeleton className="h-full w-full" />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2" aria-live="polite">
          {failed ? (
            <Provenance
              kind={frameUrl ? 'stale' : 'offline'}
              label={
                frameUrl && loadedAt
                  ? `${t('sit.camera.frameAt', { time: fmt.relative(loadedAt) })} · ${t('sit.camera.refreshFailed')}`
                  : undefined
              }
            />
          ) : (
            <Provenance
              kind="poll"
              seconds={everySeconds}
              label={loadedAt ? t('sit.camera.frameAt', { time: fmt.relative(loadedAt) }) : undefined}
            />
          )}
          <span className="t-data text-[11px] text-[var(--color-dim)]">{t('sit.camera.every', { s: everySeconds })}</span>
        </div>

        <p className="m-0 text-[12px] leading-relaxed text-[var(--color-dim)]">{camera.attribution}</p>
        <p className="m-0 text-[12px] leading-relaxed text-[var(--color-dim)]">{t('sit.camera.privacy')}</p>
      </div>
    </Panel>
  );
}
