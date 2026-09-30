'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Button, ErrorNote } from '@/components/ui';
import { useToast } from '@/components/toast';
import { parseBudget } from './traffic-budget-value';

interface TrafficSettings {
  dailyTileBudget: number;
  from: 'settings' | 'environment' | 'default';
}


/**
 * TomTom tiles allowed per day. It sits in the keys form but saves on its own (a nested form is
 * not valid HTML): the button is a plain button and Enter saves this field only.
 */
export function TrafficBudgetField() {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);

  const settings = useQuery({
    queryKey: ['settings', 'traffic'],
    queryFn: () => api<TrafficSettings>('/settings/traffic'),
  });

  const save = useMutation({
    mutationFn: (dailyTileBudget: number | null) =>
      api<TrafficSettings>('/settings/traffic', { method: 'PUT', body: { dailyTileBudget } }),
    onSuccess: (next) => {
      client.setQueryData(['settings', 'traffic'], next);
      void client.invalidateQueries({ queryKey: ['traffic'] });
      setDraft(null);
      toast.show({ tone: 'success', message: t('settings.trafficBudget.saved') });
    },
  });

  if (settings.isError) return <ErrorNote error={settings.error} onRetry={() => void settings.refetch()} />;
  if (!settings.data) return null;

  const current = settings.data;
  const value = draft ?? String(current.dailyTileBudget);
  const parsed = parseBudget(value);
  const changed = parsed !== null && parsed !== current.dailyTileBudget;
  const submit = () => {
    if (changed) save.mutate(parsed);
  };
  const origin =
    current.from === 'settings'
      ? t('settings.trafficBudget.fromSettings')
      : current.from === 'environment'
        ? t('settings.trafficBudget.fromEnv')
        : t('settings.trafficBudget.fromDefault');
  const inForce =
    current.dailyTileBudget === 0
      ? t('settings.trafficBudget.unlimited')
      : new Intl.NumberFormat(intlLocale).format(current.dailyTileBudget);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <label htmlFor="traffic-budget" className="text-[12.5px] font-medium text-[var(--color-ink)]">
          {t('settings.trafficBudget.label')}
        </label>
        <span className="t-data text-[11px] text-[var(--color-dim)]">
          {inForce} · {origin}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          id="traffic-budget"
          inputMode="numeric"
          value={value}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
          className="field t-data"
          aria-invalid={parsed === null}
        />
        <Button type="button" size="sm" loading={save.isPending} disabled={!changed} onClick={submit}>
          {t('settings.save')}
        </Button>
        {current.from === 'settings' && (
          <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
            {t('settings.trafficBudget.reset')}
          </Button>
        )}
      </div>
      <span className="text-[12px] text-[var(--color-muted)]">{t('settings.trafficBudget.hint')}</span>
      {parsed === null && <span className="text-[12px] text-[var(--color-crit)]">{t('settings.trafficBudget.invalid')}</span>}
      {save.error && <ErrorNote error={save.error} />}
    </div>
  );
}
