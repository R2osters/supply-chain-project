'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, FolderOpen, History, RotateCcw, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useFormat, useI18n } from '@/lib/i18n';
import { Banner, Button, ErrorNote, Loading, Panel } from '@/components/ui';
import { useToast } from '@/components/toast';
import { errorText } from '@/lib/desktop';
import { desktopInvoke, formatBytes, type BackupInfo, type BackupsView } from './backup-format';

/**
 * Réglages → Sauvegarde. Backups are taken and restored by the desktop shell, which owns the
 * PostgreSQL tools: in SCIP's own window only. A restore replaces everything (accounts included),
 * takes a safety backup first and restarts SCIP's services.
 */
export function BackupPanel() {
  const { t, intlLocale } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const client = useQueryClient();
  const invoke = desktopInvoke();
  const [confirming, setConfirming] = useState<string | null>(null);

  const backups = useQuery({
    queryKey: ['desktop', 'backups'],
    queryFn: () => invoke!<BackupsView>('list_backups'),
    enabled: invoke !== null,
  });

  const create = useMutation({
    mutationFn: () => invoke!<BackupInfo>('create_backup'),
    onSuccess: (backup) => {
      void client.invalidateQueries({ queryKey: ['desktop', 'backups'] });
      toast.show({ tone: 'success', message: t('settings.backup.created', { size: formatBytes(backup.sizeBytes, intlLocale) }) });
    },
  });

  const restore = useMutation({
    mutationFn: (name: string) => invoke!<void>('schedule_restore', { name }),
  });

  const openFolder = () => {
    void invoke?.('open_backups_folder').catch((error: unknown) => toast.show({ tone: 'error', message: errorText(error) }));
  };

  if (!invoke) {
    return (
      <Panel icon={Archive} title={t('settings.backup.title')}>
        <p className="m-0 px-5 pb-5 pt-2 text-[12.5px] leading-relaxed text-[var(--color-muted)]">{t('settings.backup.windowOnly')}</p>
      </Panel>
    );
  }

  const view = backups.data;
  return (
    <Panel
      icon={Archive}
      title={t('settings.backup.title')}
      actions={
        view?.embedded ? (
          <Button size="sm" variant="ghost" icon={FolderOpen} onClick={openFolder}>
            {t('settings.backup.openFolder')}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4 px-5 pb-5 pt-2">
        <p className="m-0 text-[12.5px] leading-relaxed text-[var(--color-muted)]">{t('settings.backup.lead')}</p>

        {backups.isError && <ErrorNote error={backups.error} onRetry={() => void backups.refetch()} />}
        {!view && !backups.isError && <Loading rows={2} />}

        {view && !view.embedded && <Banner tone="info" title={t('settings.backup.externalTitle')}>{t('settings.backup.external')}</Banner>}

        {view?.lastRestore && (
          <Banner
            tone={view.lastRestore.ok ? 'ok' : 'alert'}
            icon={History}
            title={view.lastRestore.ok ? t('settings.backup.lastOk') : t('settings.backup.lastFailed')}
          >
            {view.lastRestore.message} · {fmt.dateTime(view.lastRestore.at)}
          </Banner>
        )}

        {view?.embedded && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" icon={Archive} loading={create.isPending} onClick={() => create.mutate()}>
                {t('settings.backup.create')}
              </Button>
              <span className="t-data text-[11px] text-[var(--color-dim)]">{view.directory}</span>
            </div>
            {create.error && <ErrorNote error={new Error(errorText(create.error))} />}

            {view.backups.length === 0 ? (
              <p className="m-0 text-[12.5px] text-[var(--color-muted)]">{t('settings.backup.none')}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col divide-y divide-[var(--color-line)] p-0">
                {view.backups.map((backup) => (
                  <li key={backup.name} className="flex flex-col gap-2 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-ink)]">
                          {backup.safety && <ShieldCheck className="h-3.5 w-3.5 text-[var(--color-muted)]" aria-hidden />}
                          {fmt.dateTime(backup.createdAt)}
                          {backup.safety && <span className="t-label">{t('settings.backup.safety')}</span>}
                        </span>
                        <span className="t-data text-[11px] text-[var(--color-dim)]">
                          {[
                            backup.company,
                            t('settings.backup.counts', {
                              shipments: fmt.int(backup.counts.shipments),
                              orders: fmt.int(backup.counts.purchaseOrders),
                              users: fmt.int(backup.counts.users),
                            }),
                            formatBytes(backup.sizeBytes, intlLocale),
                            `v${backup.appVersion}`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </div>
                      {confirming !== backup.name && (
                        <Button size="sm" icon={RotateCcw} disabled={restore.isPending} onClick={() => setConfirming(backup.name)}>
                          {t('settings.backup.restore')}
                        </Button>
                      )}
                    </div>
                    {confirming === backup.name && (
                      <Banner
                        tone="warn"
                        title={t('settings.backup.confirmTitle', { date: fmt.dateTime(backup.createdAt) })}
                        actions={
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="primary"
                              loading={restore.isPending}
                              onClick={() => restore.mutate(backup.name)}
                            >
                              {t('settings.backup.confirm')}
                            </Button>
                            <Button size="sm" variant="ghost" disabled={restore.isPending} onClick={() => setConfirming(null)}>
                              {t('common.cancel')}
                            </Button>
                          </div>
                        }
                      >
                        {t('settings.backup.confirmBody')}
                      </Banner>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {restore.error && <ErrorNote error={new Error(errorText(restore.error))} />}
            <p className="m-0 text-[12px] text-[var(--color-muted)]">{t('settings.backup.keepSafe')}</p>
          </>
        )}
      </div>
    </Panel>
  );
}
