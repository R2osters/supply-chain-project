'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Presentation } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { Banner, Button, ErrorNote, Panel } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useSetupStatus } from '@/app/login/_components/first-run';
import { rehearsalSummary, type RehearsalResult } from './demo-summary';

/**
 * "Préparer la démo": stages the demo world again at this moment, as many times as wanted. The
 * trucks leave their origin now, two of them cannot keep their promise (the ETA engine finds the
 * delays live), SKU-006 is short again, and what a previous run left (open advice, orders
 * accepted from it) is cleared. Shown on a demo install to whoever may manage the company; the
 * API still refuses anyone but the demo company's administrator.
 */
export function DemoPanel() {
  const { t } = useI18n();
  const { can } = useAuth();
  const toast = useToast();
  const client = useQueryClient();
  const setup = useSetupStatus();

  const rehearse = useMutation({
    mutationFn: () => api<RehearsalResult>('/setup/demo/rehearse', { method: 'POST' }),
    onSuccess: () => {
      // Shipments, fleet, stock, orders and advice all changed: every screen must read afresh.
      void client.invalidateQueries();
      toast.show({ tone: 'success', message: t('settings.demo.done') });
    },
  });

  if (!setup.data?.demoAccounts || !can('company:update')) return null;

  return (
    <Panel icon={Presentation} title={t('settings.demo.title')}>
      <div className="flex flex-col gap-4 px-5 pb-5 pt-2">
        <p className="m-0 text-[12.5px] leading-relaxed text-[var(--color-muted)]">{t('settings.demo.lead')}</p>

        {rehearse.data && (
          <Banner tone="ok" icon={Clock} title={t('settings.demo.resultTitle')}>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {rehearsalSummary(rehearse.data).map((line) => (
                <li key={line.key}>{t(line.key, line.params)}</li>
              ))}
            </ul>
            <p className="m-0 mt-2">{t('settings.demo.hint')}</p>
          </Banner>
        )}

        {rehearse.error && <ErrorNote error={rehearse.error} />}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button variant="primary" icon={Presentation} loading={rehearse.isPending} onClick={() => rehearse.mutate()}>
            {t('settings.demo.prepare')}
          </Button>
          <span className="text-[12px] text-[var(--color-muted)]">
            {t('settings.demo.script', { file: 'docs/DEMO-scenario.md' })}
          </span>
        </div>
      </div>
    </Panel>
  );
}
