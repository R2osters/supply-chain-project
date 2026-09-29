'use client';

import { History, Pause, Play, X } from 'lucide-react';
import { useFormat, useI18n } from '@/lib/i18n';
import { Button, DemoTag, ErrorNote, Skeleton } from '@/components/ui';

/** One stored fix from `GET /telemetry/vehicles/:id/history`. */
export interface HistoryFix {
  id: string;
  latitude: number;
  longitude: number;
  speedKmh: number | null;
  headingDegrees: number | null;
  recordedAt: string;
  isSimulated: boolean;
}

/**
 * "Relecture de la journée": scrubs through today's stored fixes for the selected vehicle. The
 * page draws the track and the cursor on the map; this block owns only the controls.
 */
export function ReplayControls({
  active,
  onStart,
  onStop,
  fixes,
  index,
  onIndex,
  playing,
  onTogglePlay,
  loading,
  error,
  onRetry,
}: {
  active: boolean;
  onStart: () => void;
  onStop: () => void;
  fixes: HistoryFix[];
  index: number;
  onIndex: (index: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();

  if (!active) {
    return (
      <Button icon={History} onClick={onStart} className="self-start">
        {t('map.v3.replay')}
      </Button>
    );
  }

  const current = fixes[Math.min(index, fixes.length - 1)];
  const simulated = fixes.some((fix) => fix.isSimulated);

  return (
    <section className="fade-in flex flex-col gap-3 rounded-[var(--radius-md)] bg-[var(--color-surface)] p-3.5" aria-label={t('map.v3.replay')}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-muted)]">
          <History className="h-3.5 w-3.5" />
          {t('map.v3.replay')}
          {simulated && <DemoTag />}
        </span>
        <Button variant="ghost" size="sm" icon={X} onClick={onStop} aria-label={t('map.v3.replayStop')} />
      </div>

      {error ? (
        <ErrorNote error={error} onRetry={onRetry} />
      ) : loading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-2 w-full" />
        </div>
      ) : fixes.length < 2 ? (
        <p className="m-0 text-[12.5px] text-[var(--color-muted)]">{t('map.v3.replayEmpty')}</p>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-2" aria-live="polite">
            <span className="t-data text-[15px] text-[var(--color-ink)]">{fmt.time(current?.recordedAt)}</span>
            <span className="t-data text-[12px] text-[var(--color-muted)]">
              {fmt.num(current?.speedKmh ?? null, 0)} km/h
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              icon={playing ? Pause : Play}
              onClick={onTogglePlay}
              aria-label={playing ? t('map.v3.replayPause') : t('map.v3.replayPlay')}
            />
            <input
              type="range"
              min={0}
              max={fixes.length - 1}
              value={index}
              onChange={(event) => onIndex(Number(event.target.value))}
              aria-label={t('map.v3.replayScrub')}
              aria-valuetext={fmt.time(current?.recordedAt)}
              className="h-6 min-w-0 flex-1 accent-[var(--color-accent)]"
            />
          </div>
          <div className="flex justify-between gap-2">
            <span className="t-data text-[11px] text-[var(--color-dim)]">{fmt.time(fixes[0].recordedAt)}</span>
            <span className="t-data text-[11px] text-[var(--color-dim)]">
              {t('map.v3.replayFixes', { n: fmt.int(fixes.length) })}
            </span>
            <span className="t-data text-[11px] text-[var(--color-dim)]">
              {fmt.time(fixes[fixes.length - 1].recordedAt)}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
