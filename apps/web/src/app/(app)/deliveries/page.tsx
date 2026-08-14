'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Chip, Empty, ErrorNote, Loading, Meter, Panel, fmt, statusTone } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

interface DeliveryRow {
  id: string;
  status: string;
  assignedAt: string;
  deliveredAt: string | null;
  failureReason: string | null;
  attemptCount: number;
  shipment: {
    id?: string;
    trackingNumber: string;
    destinationName: string;
    estimatedArrivalAt: string | null;
    status: string;
  };
  customer: { name: string } | null;
}

interface TodayResponse {
  date: string;
  total: number;
  completed: number;
  pending: number;
  failed: number;
  deliveries: DeliveryRow[];
}

export default function DeliveriesPage() {
  const { t } = useI18n();

  const today = useQuery({
    queryKey: ['deliveries', 'today'],
    queryFn: () => api<TodayResponse>('/deliveries/today'),
    refetchInterval: 30_000,
  });

  const data = today.data;
  const completion = data && data.total > 0 ? data.completed / data.total : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label={t('del.scheduled')} value={fmt.int(data?.total ?? 0)} />
        <Tile label={t('del.completed')} value={fmt.int(data?.completed ?? 0)} tone="ok" />
        <Tile label={t('del.outstanding')} value={fmt.int(data?.pending ?? 0)} tone="signal" />
        <Tile
          label={t('del.failed')}
          value={fmt.int(data?.failed ?? 0)}
          tone={data?.failed ? 'alert' : 'ok'}
        />
      </div>

      <Panel
        title={`${t('del.run')} · ${data?.date ?? ''}`}
        actions={
          data ? (
            <span className="flex w-40 items-center gap-2">
              <Meter value={completion} tone={completion === 1 ? 'ok' : 'signal'} />
              <span className="tnum">{fmt.pct(completion)}</span>
            </span>
          ) : null
        }
        loading={today.isFetching}
      >
        {today.isError ? (
          <ErrorNote error={today.error} />
        ) : today.isLoading ? (
          <Loading />
        ) : data && data.deliveries.length > 0 ? (
          <table className="grid-table">
            <thead>
              <tr>
                <th>{t('del.shipment')}</th>
                <th>{t('del.status')}</th>
                <th>{t('del.customer')}</th>
                <th>{t('del.destination')}</th>
                <th className="text-right">ETA</th>
                <th className="text-right">{t('del.attempts')}</th>
                <th>{t('del.note')}</th>
              </tr>
            </thead>
            <tbody>
              {data.deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td className="font-mono text-[0.75rem]">
                    {delivery.shipment.id ? (
                      <Link
                        href={`/shipments/${delivery.shipment.id}`}
                        className="hover:text-[var(--color-signal)]"
                      >
                        {delivery.shipment.trackingNumber}
                      </Link>
                    ) : (
                      delivery.shipment.trackingNumber
                    )}
                  </td>
                  <td>
                    <Chip tone={statusTone(delivery.status)}>{delivery.status}</Chip>
                  </td>
                  <td className="text-[var(--color-ink-dim)]">{delivery.customer?.name ?? '—'}</td>
                  <td className="text-[var(--color-ink-dim)]">{delivery.shipment.destinationName}</td>
                  <td className="tnum text-right font-mono text-[0.6875rem] text-[var(--color-ink-dim)]">
                    {delivery.deliveredAt
                      ? fmt.time(delivery.deliveredAt)
                      : fmt.relative(delivery.shipment.estimatedArrivalAt)}
                  </td>
                  <td className="tnum text-right font-mono text-[0.75rem]">
                    {delivery.attemptCount || '—'}
                  </td>
                  <td className="max-w-[240px] truncate text-[0.75rem] text-[var(--color-alert)]">
                    {delivery.failureReason ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title={t('del.none')} hint={t('del.noneHint')} />
        )}
      </Panel>

      {/* The endpoint stays a literal inside the sentence: an API path is not translatable, and
          splitting it out keeps it monospaced in both languages. */}
      <div className="border border-[var(--color-hairline)] bg-[var(--color-panel)] px-3.5 py-2.5 text-[0.75rem] leading-relaxed text-[var(--color-ink-faint)]">
        {t('del.podNote', { endpoint: 'POST /deliveries/:id/proof' })}
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'alert' | 'signal' | 'neutral';
}) {
  const colour = {
    ok: 'var(--color-ok)',
    alert: 'var(--color-alert)',
    signal: 'var(--color-signal)',
    neutral: 'var(--color-ink)',
  }[tone];

  return (
    <div className="panel px-3.5 py-2.5">
      <div className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
        {label}
      </div>
      <div className="tnum mt-1 font-mono text-lg" style={{ color: colour }}>
        {value}
      </div>
    </div>
  );
}
