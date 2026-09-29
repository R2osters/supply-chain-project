'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, RotateCcw, Wifi } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Banner, Button, ErrorNote, Loading, Panel } from '@/components/ui';
import { useToast } from '@/components/toast';

export interface NetworkStatus {
  lanAccess: boolean;
  active: boolean;
  restartRequired: boolean;
  addresses: string[];
  apiPort: number;
  gpsPort: number;
  demoPasswordPublic: boolean;
}

/**
 * Local network access. Off by default: the API and the GPS gateway listen on this PC only, so
 * nobody on the same Wi-Fi can reach SCIP. Drivers' phones and GT06 trackers need it on. The
 * change applies after SCIP restarts, because the services bind their address when they start.
 */
export function NetworkPanel() {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [acknowledged, setAcknowledged] = useState(false);

  const network = useQuery({
    queryKey: ['settings', 'network'],
    queryFn: () => api<NetworkStatus>('/settings/network'),
  });

  const save = useMutation({
    mutationFn: (body: { lanAccess: boolean; acknowledgeDemoRisk?: boolean }) =>
      api<NetworkStatus>('/settings/network', { method: 'PUT', body }),
    onSuccess: (next) => {
      client.setQueryData(['settings', 'network'], next);
      setAcknowledged(false);
      toast.show({ tone: 'success', message: t('settings.network.saved') });
    },
  });

  if (network.isError) return <ErrorNote error={network.error} onRetry={() => void network.refetch()} />;
  if (!network.data) return <Loading rows={3} />;
  const status = network.data;
  const needsAck = !status.lanAccess && status.demoPasswordPublic;

  return (
    <Panel icon={Wifi} title={t('settings.network.title')}>
      <div className="flex flex-col gap-4 px-5 pb-5 pt-2">
        <p className="m-0 text-[12.5px] leading-relaxed text-[var(--color-muted)]">{t('settings.network.lead')}</p>

        <span className="flex items-center gap-2 text-[13px]">
          {status.active ? <Wifi className="h-4 w-4" /> : <Laptop className="h-4 w-4" />}
          <b className="font-medium">
            {status.active ? t('settings.network.nowLan') : t('settings.network.nowLocal')}
          </b>
        </span>

        {status.restartRequired && (
          <Banner tone="warn" icon={RotateCcw} title={t('settings.network.restartTitle')}>
            {status.lanAccess ? t('settings.network.restartOn') : t('settings.network.restartOff')}
          </Banner>
        )}

        {status.lanAccess && status.addresses.length > 0 && (
          <div className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-[var(--color-surface)] px-4 py-3">
            <span className="t-label">{t('settings.network.addresses')}</span>
            {status.addresses.map((address) => (
              <span key={address} className="t-data select-all text-[12.5px]">
                {t('settings.network.phone', { url: `http://${address}:${status.apiPort}/drive` })} ·{' '}
                {t('settings.network.tracker', { host: address, port: String(status.gpsPort) })}
              </span>
            ))}
          </div>
        )}

        {needsAck && (
          <Banner tone="alert" title={t('settings.network.demoTitle')}>
            {t('settings.network.demoBody')}
          </Banner>
        )}
        {needsAck && (
          <label className="flex cursor-pointer items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            {t('settings.network.demoAck')}
          </label>
        )}

        {save.error && <ErrorNote error={save.error} />}

        <div>
          {status.lanAccess ? (
            <Button icon={Laptop} loading={save.isPending} onClick={() => save.mutate({ lanAccess: false })}>
              {t('settings.network.disable')}
            </Button>
          ) : (
            <Button
              icon={Wifi}
              loading={save.isPending}
              disabled={needsAck && !acknowledged}
              onClick={() => save.mutate({ lanAccess: true, acknowledgeDemoRisk: needsAck ? acknowledged : undefined })}
            >
              {t('settings.network.enable')}
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}
