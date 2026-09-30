'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Layers, Lock, Plane, Save, Ship } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  buildFeedUpdate,
  isCoolingDown,
  isEmptyUpdate,
  type AircraftStatus,
  type FeedField,
  type FeedKey,
  type FeedSettings,
  type FeedUpdate,
  type MaritimeFeedStatus,
} from '@/lib/feeds';
import { useFormat, useI18n, type TranslationKey } from '@/lib/i18n';
import { Button, Empty, ErrorNote, Facts, Loading, PageHeader, Panel, Provenance } from '@/components/ui';
import { useToast } from '@/components/toast';
import { BackupPanel } from './_components/backup-panel';
import { DemoPanel } from './_components/demo-panel';
import { NetworkPanel } from './_components/network-panel';
import { UpdatePanel } from './_components/update-panel';
import { TrafficBudgetField } from './_components/traffic-budget';

const LABEL: Record<FeedField, TranslationKey> = {
  aisStream: 'settings.aisStream',
  marineTraffic: 'settings.marineTraffic',
  openskyClientId: 'settings.openskyId',
  openskyClientSecret: 'settings.openskySecret',
  tomtom: 'settings.tomtom',
  firms: 'settings.firms',
};

/**
 * Réglages → Sources de données. The keys that turn the map's live layers on: AISStream (free)
 * or MarineTraffic (paid) for ships, OpenSky credentials for a higher aircraft quota. Not a
 * pillar module, so it is reached from the account menu rather than the module row.
 */
export default function SettingsPage() {
  const { t } = useI18n();
  const { can } = useAuth();

  if (!can('company:update')) {
    return <Empty icon={Lock} title={t('settings.forbiddenTitle')} hint={t('settings.forbidden')} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader kicker={t('settings.kicker')} title={t('settings.title')} description={t('settings.description')} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-6">
          <DemoPanel />
          <NetworkPanel />
          <BackupPanel />
          <UpdatePanel />
          <FeedsForm />
        </div>
        {can('gps:read') && <FeedStatus />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ form */

function FeedsForm() {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [drafts, setDrafts] = useState<Partial<Record<FeedField, string>>>({});

  const feeds = useQuery({
    queryKey: ['settings', 'feeds'],
    queryFn: () => api<FeedSettings>('/settings/feeds'),
  });

  const save = useMutation({
    mutationFn: (body: FeedUpdate) => api<FeedSettings>('/settings/feeds', { method: 'PUT', body }),
    onSuccess: (next) => {
      client.setQueryData(['settings', 'feeds'], next);
      // The API applies keys at once: ask the layers and statuses again rather than wait a poll.
      void client.invalidateQueries({ queryKey: ['aircraft'] });
      void client.invalidateQueries({ queryKey: ['maritime'] });
      void client.invalidateQueries({ queryKey: ['traffic'] });
      void client.invalidateQueries({ queryKey: ['hazards'] });
    },
  });

  const update = buildFeedUpdate(drafts);
  const setDraft = (field: FeedField, value: string) => setDrafts((current) => ({ ...current, [field]: value }));

  const clear = (field: FeedField) =>
    save.mutate(buildFeedUpdate({}, { [field]: true }), {
      onSuccess: () => {
        setDrafts((current) => ({ ...current, [field]: '' }));
        toast.show({ tone: 'success', message: t('settings.cleared') });
      },
    });

  if (feeds.isError) return <ErrorNote error={feeds.error} onRetry={() => void feeds.refetch()} />;
  if (!feeds.data) return <Loading rows={6} />;

  const field = (name: FeedField, hint?: ReactNode) => (
    <KeyField
      name={name}
      state={feeds.data[name]}
      value={drafts[name] ?? ''}
      onChange={(value) => setDraft(name, value)}
      onClear={() => clear(name)}
      clearing={save.isPending}
      hint={hint}
    />
  );

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (isEmptyUpdate(update)) return;
        save.mutate(update, {
          onSuccess: () => {
            setDrafts({});
            toast.show({ tone: 'success', message: t('settings.saved') });
          },
        });
      }}
    >
      <Panel icon={Ship} title={t('settings.section.maritime')}>
        <div className="flex flex-col gap-5 px-5 pb-5 pt-2">
          {field(
            'aisStream',
            <>
              {t('settings.aisStreamHint')}{' '}
              <ExternalLink href="https://aisstream.io">aisstream.io</ExternalLink>
            </>,
          )}
          {field('marineTraffic', t('settings.marineTrafficHint'))}
        </div>
      </Panel>

      <Panel icon={Plane} title={t('settings.section.aircraft')}>
        <div className="flex flex-col gap-5 px-5 pb-5 pt-2">
          <p className="m-0 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
            {t('settings.openskyHint')}{' '}
            <ExternalLink href="https://opensky-network.org">opensky-network.org</ExternalLink>{' '}
            {t('settings.openskyHintEnd')}
          </p>
          {field('openskyClientId')}
          {field('openskyClientSecret')}
        </div>
      </Panel>

      <Panel icon={Layers} title={t('settings.section.map')}>
        <div className="flex flex-col gap-5 px-5 pb-5 pt-2">
          {field(
            'tomtom',
            <>
              {t('settings.tomtomHint')}{' '}
              <ExternalLink href="https://developer.tomtom.com">developer.tomtom.com</ExternalLink>
            </>,
          )}
          <TrafficBudgetField />
          {field(
            'firms',
            <>
              {t('settings.firmsHint')}{' '}
              <ExternalLink href="https://firms.modaps.eosdis.nasa.gov/api/map_key/">firms.modaps.eosdis.nasa.gov</ExternalLink>
            </>,
          )}
        </div>
      </Panel>

      {save.error && <ErrorNote error={save.error} />}

      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" icon={Save} loading={save.isPending} disabled={isEmptyUpdate(update)}>
          {t('settings.save')}
        </Button>
      </div>
    </form>
  );
}

function KeyField({
  name,
  state,
  value,
  onChange,
  onClear,
  clearing,
  hint,
}: {
  name: FeedField;
  state: FeedKey;
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  clearing: boolean;
  hint?: ReactNode;
}) {
  const { t } = useI18n();
  const id = `feed-${name}`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <label htmlFor={id} className="text-[12.5px] font-medium text-[var(--color-ink)]">
          {t(LABEL[name])}
        </label>
        <span className="t-data text-[11px] text-[var(--color-dim)]">
          {state.configured
            ? `${t('settings.configured', { hint: state.hint ?? '' }).trim()} · ${
                state.from === 'environment'
                  ? t('settings.fromEnv')
                  : state.from === 'bundled'
                    ? t('settings.fromBundled')
                    : t('settings.fromSettings')
              }`
            : t('settings.notConfigured')}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={state.configured ? t('settings.placeholderKeep') : t('settings.placeholderNew')}
          className="field t-data"
          autoComplete="new-password"
          spellCheck={false}
        />
        {/* Only a value saved here can be cleared here; an environment value stays the fallback. */}
        {state.configured && state.from === 'settings' && (
          <Button type="button" size="sm" variant="ghost" onClick={onClear} disabled={clearing}>
            {t('settings.clear')}
          </Button>
        )}
      </div>
      {hint && <span className="text-[12px] text-[var(--color-muted)]">{hint}</span>}
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="t-data text-[var(--color-ink)] underline decoration-dotted underline-offset-2"
    >
      {children}
    </a>
  );
}

/* ---------------------------------------------------------------------- status */

function FeedStatus() {
  const { t } = useI18n();
  const fmt = useFormat();

  const aircraft = useQuery({
    queryKey: ['aircraft', 'status'],
    queryFn: () => api<AircraftStatus>('/aircraft/status'),
    refetchInterval: 30_000,
  });
  const maritime = useQuery({
    queryKey: ['maritime', 'status'],
    queryFn: () => api<MaritimeFeedStatus>('/maritime/status'),
    refetchInterval: 30_000,
  });

  const air = aircraft.data;
  const sea = maritime.data;
  const cooling = air ? isCoolingDown(air) : false;

  return (
    <Panel icon={Activity} title={t('settings.status.title')}>
      <div className="flex flex-col gap-5 px-5 pb-5 pt-2">
        <section className="flex flex-col gap-2">
          <span className="flex items-center justify-between gap-2">
            <span className="t-label flex items-center gap-1.5">
              <Plane className="h-3.5 w-3.5" />
              {t('settings.status.aircraft')}
            </span>
            {air && (
              <Provenance
                kind={air.source === 'none' ? 'offline' : cooling ? 'stale' : 'live'}
                label={
                  air.source === 'none'
                    ? t('settings.status.none')
                    : cooling
                      ? t('prov.stale')
                      : undefined
                }
              />
            )}
          </span>
          {aircraft.isError ? (
            <ErrorNote error={aircraft.error} onRetry={() => void aircraft.refetch()} />
          ) : !air ? (
            <Loading rows={2} />
          ) : (
            <>
              <Facts
                items={[
                  [
                    t('settings.status.source'),
                    <span key="s" className="t-data">{air.source === 'none' ? t('settings.status.none') : air.source}</span>,
                  ],
                  [t('settings.status.access'), air.authenticated ? t('settings.status.authenticated') : t('settings.status.anonymous')],
                  [
                    t('settings.status.quota'),
                    air.creditsRemaining === null ? '—' : t('settings.status.credits', { n: fmt.int(air.creditsRemaining) }),
                  ],
                ]}
              />
              {cooling && air.coolingDownUntil && (
                <p className="m-0 text-[12px] text-[var(--color-warn)]">
                  {t('settings.status.cooling', { time: fmt.time(air.coolingDownUntil) })}
                </p>
              )}
              {air.attribution && <span className="t-data text-[11px] text-[var(--color-dim)]">{air.attribution}</span>}
            </>
          )}
        </section>

        <div className="h-px bg-[var(--color-line)]" />

        <section className="flex flex-col gap-2">
          <span className="flex items-center justify-between gap-2">
            <span className="t-label flex items-center gap-1.5">
              <Ship className="h-3.5 w-3.5" />
              {t('settings.status.vessels')}
            </span>
            {sea && (
              <Provenance
                kind={sea.isLive || sea.ambient?.active ? 'live' : 'offline'}
                label={sea.isLive || sea.ambient?.active ? undefined : t('settings.status.notLive')}
              />
            )}
          </span>
          {maritime.isError ? (
            <ErrorNote error={maritime.error} onRetry={() => void maritime.refetch()} />
          ) : !sea ? (
            <Loading rows={2} />
          ) : (
            <>
              {sea.ambient?.active && (
                <p className="m-0 text-[12px] leading-relaxed text-[var(--color-ink)]">{t('settings.status.ambientLive')}</p>
              )}
              <span className="t-data text-[12px] text-[var(--color-ink)]">
                {t('settings.status.trackedFeed')} {sea.source}
              </span>
              {sea.detail && <p className="m-0 text-[12px] leading-relaxed text-[var(--color-muted)]">{sea.detail}</p>}
              {sea.howToGoLive && (
                <p className="m-0 text-[12px] leading-relaxed text-[var(--color-dim)]">{sea.howToGoLive}</p>
              )}
            </>
          )}
        </section>
      </div>
    </Panel>
  );
}
