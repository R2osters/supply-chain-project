'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import {
  HAZARD_COLOUR,
  newsKeyword,
  safeExternalUrl,
  type Hazard,
  type NewsResponse,
  type PointWeather,
} from '@/lib/intel';
import { useFormat, useI18n, type TranslationKey } from '@/lib/i18n';
import { Chip, Panel } from '@/components/ui';
import { severityTone } from './severity';

const KIND_KEY: Record<Hazard['kind'], TranslationKey> = {
  CYCLONE: 'sit.kind.cyclone',
  EARTHQUAKE: 'sit.kind.earthquake',
  FIRE: 'sit.kind.fire',
  SEVERE_WEATHER: 'sit.kind.weather',
};

/**
 * One hazard, with what an operator needs to judge it: the facts from the source, the weather
 * right there now, and what local news is saying. News is a location-keyword match, not a
 * verified incident report, and the panel labels it that way.
 */
export function HazardDetail({ hazard, onClose }: { hazard: Hazard; onClose(): void }) {
  const { t } = useI18n();
  const fmt = useFormat();

  const weather = useQuery({
    queryKey: ['hazards', 'weather', hazard.latitude.toFixed(1), hazard.longitude.toFixed(1)],
    queryFn: () =>
      api<PointWeather>(`/hazards/weather?lat=${hazard.latitude}&lon=${hazard.longitude}`),
    staleTime: 10 * 60_000,
  });

  const newsQuery = newsKeyword(hazard);
  const news = useQuery({
    queryKey: ['hazards', 'news', newsQuery],
    queryFn: () => api<NewsResponse>(`/hazards/news?q=${encodeURIComponent(newsQuery)}`),
    enabled: newsQuery.length > 2,
    staleTime: 15 * 60_000,
  });

  const sourceUrl = safeExternalUrl(hazard.url);
  const details = Object.entries(hazard.details).filter(([, value]) => value !== null && value !== '');

  return (
    <Panel
      title={t(KIND_KEY[hazard.kind])}
      actions={
        <button onClick={onClose} className="hover:text-[var(--color-signal)]">
          {t('sit.close')}
        </button>
      }
    >
      <div className="max-h-[calc(100vh-240px)] space-y-3 overflow-y-auto p-3.5">
        <div className="flex items-start justify-between gap-2">
          <div className="text-[0.8125rem] leading-snug text-[var(--color-ink)]">{hazard.title}</div>
          <Chip tone={severityTone(hazard.severity)}>{hazard.severity}</Chip>
        </div>
        <div className="flex items-center gap-2 font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: HAZARD_COLOUR[hazard.kind] }} />
          {hazard.source} · {fmt.relative(hazard.observedAt)} · r {fmt.num(hazard.radiusKm, 0)} km
        </div>

        {details.length > 0 && (
          <dl className="space-y-1">
            {details.slice(0, 8).map(([key, value]) => (
              <div key={key} className="flex items-baseline justify-between gap-3">
                <dt className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
                  {key}
                </dt>
                <dd className="truncate text-right font-mono text-[0.6875rem] text-[var(--color-ink-dim)]">
                  {String(value)}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block font-mono text-[0.625rem] uppercase tracking-[0.12em] text-[var(--color-info)] hover:text-[var(--color-signal)]"
          >
            {t('sit.hazard.officialSource')} ↗
          </a>
        )}

        <section className="border-t border-[var(--color-hairline)] pt-3">
          <h3 className="mb-1.5 font-mono text-[0.5625rem] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
            {t('sit.weather.title')}
          </h3>
          {weather.data ? (
            <div className="space-y-1 text-[0.75rem] text-[var(--color-ink-dim)]">
              <div>
                {weather.data.condition} · {fmt.num(weather.data.temperatureC, 0)} °C ·{' '}
                {t('sit.weather.wind', {
                  wind: fmt.num(weather.data.windKmh, 0),
                  gust: fmt.num(weather.data.windGustKmh, 0),
                })}
              </div>
              <div className="font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
                {t('sit.weather.severity', { pct: fmt.pct(weather.data.severity) })}
                {weather.data.stale ? ` · ${t('sit.stale')}` : ''}
              </div>
              <a
                href="https://open-meteo.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[0.5625rem] text-[var(--color-ink-faint)] hover:text-[var(--color-signal)]"
              >
                {weather.data.attribution}
              </a>
            </div>
          ) : (
            <p className="text-[0.6875rem] text-[var(--color-ink-faint)]">
              {weather.isError ? t('sit.unavailable') : t('sit.loading')}
            </p>
          )}
        </section>

        <section className="border-t border-[var(--color-hairline)] pt-3">
          <h3 className="mb-1 font-mono text-[0.5625rem] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
            {t('sit.news.title', { q: newsQuery })}
          </h3>
          <p className="mb-2 text-[0.625rem] leading-snug text-[var(--color-ink-faint)]">{t('sit.news.caveat')}</p>
          {news.data && news.data.articles.length > 0 ? (
            <ul className="space-y-2">
              {news.data.articles.slice(0, 6).map((article) => {
                const href = safeExternalUrl(article.url);
                return (
                  <li key={article.url} className="text-[0.75rem] leading-snug">
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--color-ink)] hover:text-[var(--color-signal)]">
                        {article.title}
                      </a>
                    ) : (
                      <span className="text-[var(--color-ink)]">{article.title}</span>
                    )}
                    <div className="font-mono text-[0.5625rem] text-[var(--color-ink-faint)]">
                      {article.domain}
                      {article.publishedAt ? ` · ${fmt.relative(article.publishedAt)}` : ''}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[0.6875rem] text-[var(--color-ink-faint)]">
              {news.isLoading ? t('sit.loading') : t('sit.news.none')}
            </p>
          )}
          <p className="mt-2 font-mono text-[0.5625rem] text-[var(--color-ink-faint)]">GDELT Project</p>
        </section>
      </div>
    </Panel>
  );
}

