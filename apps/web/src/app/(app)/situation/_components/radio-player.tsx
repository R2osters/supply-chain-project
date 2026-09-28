'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { safeExternalUrl, type RadioStation } from '@/lib/intel';
import { useFormat, useI18n } from '@/lib/i18n';
import { Panel } from '@/components/ui';

/**
 * Plays one station straight from its broadcaster.
 *
 * Audio is deliberately not proxied: relaying live streams would make this API a radio
 * rebroadcaster, with the bandwidth and rights questions that come with it. The cost is that the
 * listener's IP address reaches the broadcaster, which the panel says plainly.
 */
export function RadioPlayer({ station, onClose }: { station: RadioStation; onClose(): void }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const audio = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<'idle' | 'playing' | 'error'>('idle');
  const counted = useRef(false);
  const homepage = safeExternalUrl(station.homepage);

  useEffect(() => {
    counted.current = false;
    setState('idle');
    const element = audio.current;
    return () => {
      // Stopping the element is not enough to close the network stream in every browser;
      // clearing the source is.
      element?.pause();
      element?.removeAttribute('src');
      element?.load();
    };
  }, [station.id]);

  const handlePlay = (): void => {
    setState('playing');
    if (counted.current) return;
    counted.current = true;
    // The directory ranks stations by listens; reporting ours keeps the ranking honest. Best
    // effort — a failure here must not interrupt playback.
    void api(`/radio/stations/${encodeURIComponent(station.id)}/click`, { method: 'POST' }).catch(
      () => undefined,
    );
  };

  return (
    <Panel
      title={t('sit.radio.title')}
      actions={
        <button onClick={onClose} className="hover:text-[var(--color-signal)]">
          {t('sit.close')}
        </button>
      }
    >
      <div className="space-y-2.5 p-3.5">
        <div>
          <div className="text-[0.8125rem] text-[var(--color-ink)]">{station.name}</div>
          <div className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
            {[station.state, station.country].filter(Boolean).join(', ') || '—'} ·{' '}
            {fmt.num(station.distanceKm, 0)} km
          </div>
        </div>

        {station.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {station.tags.slice(0, 6).map((tag) => (
              <span key={tag} className="chip chip-neutral">
                {tag}
              </span>
            ))}
          </div>
        )}

        <audio
          ref={audio}
          src={station.streamUrl}
          controls
          preload="none"
          onPlay={handlePlay}
          onPause={() => setState('idle')}
          onError={() => setState('error')}
          className="w-full"
        />
        {state === 'error' && (
          <p className="text-[0.6875rem] text-[var(--color-alert)]">{t('sit.radio.error')}</p>
        )}

        <div className="flex items-center justify-between font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
          <span>
            {[station.codec, station.bitrate ? `${station.bitrate} kbps` : null].filter(Boolean).join(' · ') ||
              '—'}
          </span>
          {homepage && (
            <a
              href={homepage}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[var(--color-signal)]"
            >
              {t('sit.radio.homepage')} ↗
            </a>
          )}
        </div>
        <p className="text-[0.625rem] leading-relaxed text-[var(--color-ink-faint)]">{t('sit.radio.privacy')}</p>
      </div>
    </Panel>
  );
}
