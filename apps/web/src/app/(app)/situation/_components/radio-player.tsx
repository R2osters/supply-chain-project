'use client';

import { ExternalLink, Radio, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { safeExternalUrl, type RadioStation } from '@/lib/intel';
import { useFormat, useI18n } from '@/lib/i18n';
import { Button, Panel, Provenance } from '@/components/ui';

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
      icon={Radio}
      title={t('sit.radio.title')}
      actions={<Button variant="ghost" size="sm" icon={X} onClick={onClose} aria-label={t('common.close')} />}
    >
      <div className="flex flex-col gap-4 px-5 pb-5 pt-2">
        <div className="flex flex-col gap-1">
          <p className="m-0 text-[15px] text-[var(--color-ink)]">{station.name}</p>
          <p className="m-0 flex flex-wrap items-center gap-x-2 text-[12px] text-[var(--color-muted)]">
            <span>{[station.state, station.country].filter(Boolean).join(', ') || '—'}</span>
            <span aria-hidden>·</span>
            <span className="t-data text-[11px]">{fmt.num(station.distanceKm, 0)} km</span>
          </p>
        </div>

        {station.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
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
        <span className="flex items-center gap-2" aria-live="polite">
          {state === 'playing' && <Provenance kind="live" />}
          {state === 'error' && <Provenance kind="offline" label={t('sit.radio.error')} />}
        </span>

        <div className="flex items-center justify-between gap-3">
          <span className="t-data text-[11px] text-[var(--color-dim)]">
            {[station.codec, station.bitrate ? `${station.bitrate} kbps` : null].filter(Boolean).join(' · ') || '—'}
          </span>
          {homepage && (
            <a
              href={homepage}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[12.5px] text-[var(--color-info)] underline-offset-4 hover:underline"
            >
              {t('sit.radio.homepage')}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
        <p className="m-0 text-[12px] leading-relaxed text-[var(--color-dim)]">{t('sit.radio.privacy')}</p>
      </div>
    </Panel>
  );
}
