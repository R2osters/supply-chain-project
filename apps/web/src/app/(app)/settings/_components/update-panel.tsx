'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { desktopInvoke, errorText } from '@/lib/desktop';
import { useFormat, useI18n } from '@/lib/i18n';
import { Banner, Button, ErrorNote, Loading, Panel } from '@/components/ui';
import { updateView, type UpdateStatus } from './update-format';

/**
 * Réglages → Mises à jour. The desktop shell checks GitHub on its own; this panel shows where it
 * stands, checks on demand and installs a ready update. Installing backs the data
 * up, closes SCIP for a minute or two while the installer runs, then reopens it.
 */
export function UpdatePanel() {
  const { t } = useI18n();
  const fmt = useFormat();
  const client = useQueryClient();
  const invoke = desktopInvoke();

  const status = useQuery({
    queryKey: ['desktop', 'update'],
    queryFn: () => invoke!<UpdateStatus>('update_status'),
    enabled: invoke !== null,
    // Quick while something moves, calm otherwise.
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'checking' || state === 'downloading' ? 1_500 : 60_000;
    },
  });

  const check = useMutation({
    mutationFn: () => invoke!<UpdateStatus>('check_for_update'),
    onMutate: () => void client.setQueryData<UpdateStatus>(['desktop', 'update'], (old) => (old ? { ...old, state: 'checking' } : old)),
    onSettled: () => void client.invalidateQueries({ queryKey: ['desktop', 'update'] }),
  });

  const install = useMutation({ mutationFn: () => invoke!<void>('install_update') });

  if (!invoke) return null;
  if (status.isError) return <ErrorNote error={new Error(errorText(status.error))} onRetry={() => void status.refetch()} />;
  if (!status.data) return <Loading rows={2} />;

  const current = status.data;
  const view = updateView(current);
  return (
    <Panel icon={Download} title={t('settings.update.title')} meta={t('settings.update.current', { version: current.current })}>
      <div className="flex flex-col gap-4 px-5 pb-5 pt-2">
        <Banner tone={view.tone} title={t(view.key, view.params)}>
          {current.lastCheck && t('settings.update.lastCheck', { time: fmt.dateTime(current.lastCheck) })}
        </Banner>

        {view.percent !== null && (
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-line)]" role="progressbar" aria-valuenow={view.percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-[var(--color-ink)] transition-[width]" style={{ width: `${view.percent}%` }} />
          </div>
        )}

        {current.state === 'ready' && current.notes && (
          <div className="flex flex-col gap-1">
            <span className="t-label">{t('settings.update.notes')}</span>
            <p className="m-0 whitespace-pre-line text-[12.5px] leading-relaxed text-[var(--color-muted)]">{current.notes}</p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {view.canInstall && (
            <Button variant="primary" icon={Download} loading={install.isPending} onClick={() => install.mutate()}>
              {t('settings.update.install')}
            </Button>
          )}
          {view.canCheck && (
            <Button icon={RefreshCw} loading={check.isPending} onClick={() => check.mutate()}>
              {t('settings.update.check')}
            </Button>
          )}
        </div>
        {view.canInstall && <p className="m-0 text-[12px] text-[var(--color-muted)]">{t('settings.update.installHint')}</p>}
        {install.error && <ErrorNote error={new Error(errorText(install.error))} />}
      </div>
    </Panel>
  );
}
