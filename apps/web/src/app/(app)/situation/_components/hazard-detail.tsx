'use client';

import { useQuery } from '@tanstack/react-query';
import { CloudSun, ExternalLink, FilePlus2, Newspaper, X } from 'lucide-react';
import { api } from '@/lib/api';
import {
  newsKeyword,
  safeExternalUrl,
  type Exposure,
  type Hazard,
  type NewsResponse,
  type PointWeather,
  type SourceStatus,
} from '@/lib/intel';
import { useFormat, useI18n } from '@/lib/i18n';
import { Button, DisabledReason, Facts, Panel, Provenance, SeverityIcon } from '@/components/ui';
import { SUBJECT_ICON, SUBJECT_KEY } from './exposure-panel';
import { KIND_ICON, KIND_KEY, SEVERITY_KEY, feedProvenance, hazardSeverity } from './hazard-kind';

/**
 * One hazard, with what an operator needs to judge it: which of our assets it touches, the facts
 * from the source, the weather right there now, and what local news is saying. News is a
 * location-keyword match, not a verified incident report, and the panel labels it that way.
 * The one black action is « Créer un incident »: nothing is filed without the operator's say.
 */
export function HazardDetail({
  hazard,
  exposed,
  source,
  canCreateIncident,
  onCreateIncident,
  onFocusExposure,
  onClose,
}: {
  hazard: Hazard;
  exposed: Exposure[];
  source: SourceStatus | undefined;
  canCreateIncident: boolean;
  onCreateIncident(): void;
  onFocusExposure(exposure: Exposure): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const KindIcon = KIND_ICON[hazard.kind];

  const weather = useQuery({
    queryKey: ['hazards', 'weather', hazard.latitude.toFixed(1), hazard.longitude.toFixed(1)],
    queryFn: () => api<PointWeather>(`/hazards/weather?lat=${hazard.latitude}&lon=${hazard.longitude}`),
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
      icon={KindIcon}
      title={t(KIND_KEY[hazard.kind])}
      actions={<Button variant="ghost" size="sm" icon={X} onClick={onClose} aria-label={t('common.close')} />}
    >
      <div className="flex flex-col gap-5 px-5 pb-5 pt-2">
        {/* ------------------------------------------------------------ headline */}
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5">
              <SeverityIcon severity={hazardSeverity(hazard.severity)} />
            </span>
            <p className="m-0 text-[15px] leading-snug text-[var(--color-ink)] [text-wrap:pretty]">{hazard.title}</p>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--color-muted)]">
            <span>{t(SEVERITY_KEY[hazard.severity])}</span>
            <span aria-hidden>·</span>
            <span className="t-data text-[11px]">{hazard.source}</span>
            {source && (
              <Provenance
                kind={feedProvenance(source.status)}
                label={source.status === 'OK' ? fmt.relative(source.fetchedAt) : undefined}
              />
            )}
          </div>
        </div>

        {canCreateIncident ? (
          <Button variant="primary" icon={FilePlus2} onClick={onCreateIncident} className="w-full">
            {t('sit.v3.incident.create')}
          </Button>
        ) : (
          <DisabledReason>{t('sit.v3.incident.noPermission')}</DisabledReason>
        )}

        <Facts
          items={[
            [t('sit.v3.detail.observed'), <span key="o" className="t-data">{fmt.relative(hazard.observedAt)}</span>],
            [t('sit.v3.detail.radius'), <span key="r" className="t-data">{fmt.num(hazard.radiusKm, 0)} km</span>],
            [
              t('sit.v3.detail.position'),
              <span key="p" className="t-data">
                {hazard.latitude.toFixed(2)}, {hazard.longitude.toFixed(2)}
              </span>,
            ],
            [t('sit.v3.detail.score'), <span key="s" className="t-data">{fmt.num(hazard.severityScore, 2)}</span>],
          ]}
        />

        {/* ------------------------------------------------------------ exposure */}
        <section className="flex flex-col gap-2">
          <h3 className="t-label m-0">{t('sit.v3.detail.exposed')}</h3>
          {exposed.length === 0 ? (
            <p className="m-0 text-[12.5px] text-[var(--color-muted)]">{t('sit.v3.detail.exposedNone')}</p>
          ) : (
            <ul className="tile m-0 flex list-none flex-col p-1">
              {exposed.map((item) => {
                const SubjectIcon = SUBJECT_ICON[item.subjectType];
                return (
                  <li key={`${item.subjectType}:${item.subjectId}`}>
                    <button
                      type="button"
                      onClick={() => onFocusExposure(item)}
                      className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-left text-[13px] transition-colors duration-100 hover:bg-[var(--color-surface)]"
                    >
                      <SubjectIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted)]" />
                      <span className="min-w-0 flex-1 truncate">{item.subjectLabel}</span>
                      <span className="text-[11px] text-[var(--color-dim)]">{t(SUBJECT_KEY[item.subjectType])}</span>
                      <span className="t-data text-[11px] text-[var(--color-muted)]">{fmt.num(item.distanceKm, 0)} km</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {details.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="t-label m-0">{t('sit.v3.detail.facts')}</h3>
            <dl className="m-0 flex flex-col gap-1">
              {details.slice(0, 8).map(([key, value]) => (
                <div key={key} className="flex items-baseline justify-between gap-3">
                  <dt className="t-data text-[11px] text-[var(--color-muted)]">{key}</dt>
                  <dd className="t-data m-0 truncate text-right text-[12px] text-[var(--color-ink)]">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 self-start text-[13px] text-[var(--color-info)] underline-offset-4 hover:underline"
          >
            {t('sit.hazard.officialSource')}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}

        {/* ------------------------------------------------------------- weather */}
        <section className="tile flex flex-col gap-1.5 p-4">
          <h3 className="m-0 flex items-center gap-1.5 text-[13px] font-medium">
            <CloudSun className="h-4 w-4 text-[var(--color-muted)]" />
            {t('sit.weather.title')}
          </h3>
          {weather.data ? (
            <>
              <p className="m-0 text-[13px] text-[var(--color-ink)]">
                {weather.data.condition} · <span className="t-data">{fmt.num(weather.data.temperatureC, 0)} °C</span>
              </p>
              <p className="m-0 text-[12.5px] text-[var(--color-muted)]">
                {t('sit.weather.wind', {
                  wind: fmt.num(weather.data.windKmh, 0),
                  gust: fmt.num(weather.data.windGustKmh, 0),
                })}
                {' · '}
                {t('sit.weather.severity', { pct: fmt.pct(weather.data.severity) })}
              </p>
              <span className="flex flex-wrap items-center gap-2">
                <a
                  href="https://open-meteo.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="t-data text-[11px] text-[var(--color-dim)] hover:text-[var(--color-ink)]"
                >
                  {weather.data.attribution}
                </a>
                {weather.data.stale && <Provenance kind="stale" />}
              </span>
            </>
          ) : (
            <p className="m-0 text-[12.5px] text-[var(--color-muted)]">
              {weather.isError ? t('sit.unavailable') : t('sit.loading')}
            </p>
          )}
        </section>

        {/* ---------------------------------------------------------------- news */}
        <section className="flex flex-col gap-2">
          <h3 className="m-0 flex items-center gap-1.5 text-[13px] font-medium">
            <Newspaper className="h-4 w-4 text-[var(--color-muted)]" />
            {t('sit.news.title', { q: newsQuery })}
          </h3>
          <p className="m-0 text-[12px] leading-snug text-[var(--color-dim)]">{t('sit.news.caveat')}</p>
          {news.data && news.data.articles.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {news.data.articles.slice(0, 6).map((article) => {
                const href = safeExternalUrl(article.url);
                return (
                  <li key={article.url} className="flex flex-col gap-0.5 text-[13px] leading-snug">
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--color-ink)] underline-offset-4 hover:underline"
                      >
                        {article.title}
                      </a>
                    ) : (
                      <span className="text-[var(--color-ink)]">{article.title}</span>
                    )}
                    <span className="t-data text-[11px] text-[var(--color-dim)]">
                      {article.domain}
                      {article.publishedAt ? ` · ${fmt.relative(article.publishedAt)}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="m-0 text-[12.5px] text-[var(--color-muted)]">
              {news.isLoading ? t('sit.loading') : news.isError ? t('sit.unavailable') : t('sit.news.none')}
            </p>
          )}
          <span className="t-data text-[11px] text-[var(--color-dim)]">GDELT Project</span>
        </section>
      </div>
    </Panel>
  );
}
