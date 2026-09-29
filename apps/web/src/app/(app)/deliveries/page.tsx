'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { CircleCheck, ExternalLink, FileSignature, FilterX, Truck } from 'lucide-react';
import { api } from '@/lib/api';
import {
  Banner,
  Button,
  Chip,
  DemoTag,
  Empty,
  ErrorNote,
  Facts,
  Kpi,
  Loading,
  Meter,
  PageHeader,
  Panel,
  Provenance,
  SeverityIcon,
  statusTone,
} from '@/components/ui';
import { useToast } from '@/components/toast';
import { useFormat, useI18n } from '@/lib/i18n';
import {
  DetailHint,
  DetailPanel,
  DetailSection,
  FilterPill,
  History,
  ListDetailLayout,
  useListKeys,
} from '../shipments/_components/track-kit';
import { shipmentHref } from '@/lib/routes';

interface DeliveryRow {
  id: string;
  status: string;
  assignedAt: string;
  deliveredAt: string | null;
  failureReason: string | null;
  attemptCount: number;
  /** Every Delivery scalar comes back from /today; optional for older API builds. */
  shipmentId?: string;
  pickedUpAt?: string | null;
  arrivedAt?: string | null;
  failedAt?: string | null;
  isDemoData?: boolean;
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

/** GET /deliveries/:id — the only read that carries the proof, with short-lived presigned links. */
interface DeliveryDetail {
  id: string;
  status: string;
  allowedTransitions: string[];
  shipment: {
    id: string;
    trackingNumber: string;
    driver: { firstName: string; lastName: string; phone?: string | null } | null;
  };
  proof: {
    receiverName: string;
    capturedAt: string;
    notes: string | null;
    distanceToDestinationM: number | null;
    signatureUrl: string | null;
    photos: string[];
    isDemoData: boolean;
  } | null;
}

/** Same threshold the API uses to flag a proof captured away from the destination. */
const POD_DISTANCE_WARNING_M = 1_000;
const CLOSED = ['DELIVERED', 'FAILED'];
/** POST /deliveries/:id/proof accepts a delivery in one of these states. */
const CONFIRMABLE = ['ARRIVED', 'IN_TRANSIT', 'PICKED_UP'];

/**
 * "At risk": still open while the shipment is DELAYED or its ETA has already passed. There is no
 * booked time slot in the data, so the ETA is the best available promise.
 */
function isAtRisk(delivery: DeliveryRow, now: number): boolean {
  if (CLOSED.includes(delivery.status)) return false;
  if (delivery.shipment.status === 'DELAYED') return true;
  const eta = delivery.shipment.estimatedArrivalAt;
  return Boolean(eta && new Date(eta).getTime() < now && delivery.status !== 'ARRIVED');
}

type Filter = 'all' | 'risk' | 'open' | 'done' | 'failed' | 'demo';

export default function DeliveriesPage() {
  const { t } = useI18n();
  const f = useFormat();
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const today = useQuery({
    queryKey: ['deliveries', 'today'],
    queryFn: () => api<TodayResponse>('/deliveries/today'),
    refetchInterval: 30_000,
  });

  const data = today.data;
  const all = data?.deliveries ?? [];
  const now = today.dataUpdatedAt || Date.now();
  const completion = data && data.total > 0 ? data.completed / data.total : 0;

  const matches: Record<Filter, (row: DeliveryRow) => boolean> = {
    all: () => true,
    risk: (row) => isAtRisk(row, now),
    open: (row) => !CLOSED.includes(row.status),
    done: (row) => row.status === 'DELIVERED',
    failed: (row) => row.status === 'FAILED',
    demo: (row) => Boolean(row.isDemoData),
  };
  const countOf = (key: Filter) => all.filter(matches[key]).length;
  const rows = all.filter(matches[filter]);
  const atRisk = countOf('risk');

  const ids = useMemo(() => rows.map((row) => row.id), [rows]);
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const select = useCallback((id: string | null) => setSelectedId(id), []);
  useListKeys(ids, selectedId, select);

  const title = !data
    ? t('nav.deliveries')
    : data.total === 0
      ? t('del.none')
      : data.pending === 0
        ? t('del.v3.titleDone')
        : atRisk > 0
          ? t('del.v3.titleRisk', { n: f.int(data.pending), r: f.int(atRisk) })
          : t('del.v3.titleOnTrack', { n: f.int(data.pending) });

  const PILLS: Array<[Filter, string]> = [
    ['all', t('del.v3.pillAll')],
    ['risk', t('del.v3.pillRisk')],
    ['open', t('del.outstanding')],
    ['done', t('del.completed')],
    ['failed', t('del.failed')],
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={t('del.v3.kicker')}
        title={title}
        description={t('del.v3.question')}
        meta={<Provenance kind="poll" seconds={30} />}
      />

      <div className="stagger grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label={t('del.scheduled')} value={f.int(data?.total ?? 0)} />
        <Kpi label={t('del.completed')} value={f.int(data?.completed ?? 0)} />
        <Kpi
          label={t('del.outstanding')}
          value={f.int(data?.pending ?? 0)}
          tone={atRisk > 0 ? 'warn' : 'neutral'}
          sub={atRisk > 0 ? t('del.v3.riskSub', { n: f.int(atRisk) }) : undefined}
        />
        <Kpi label={t('del.failed')} value={f.int(data?.failed ?? 0)} tone={data?.failed ? 'alert' : 'neutral'} />
      </div>

      <div className="rise flex flex-wrap items-center gap-2">
        {PILLS.map(([key, label]) => (
          <FilterPill
            key={key}
            active={filter === key}
            count={data ? countOf(key) : null}
            icon={key === 'risk' && atRisk > 0 ? <SeverityIcon severity="warning" size={14} /> : undefined}
            onClick={() => setFilter(filter === key && key !== 'all' ? 'all' : key)}
          >
            {label}
          </FilterPill>
        ))}
        {countOf('demo') > 0 && (
          <FilterPill
            demo
            active={filter === 'demo'}
            count={countOf('demo')}
            onClick={() => setFilter(filter === 'demo' ? 'all' : 'demo')}
          >
            {t('prov.demo')}
          </FilterPill>
        )}
      </div>

      <ListDetailLayout
        list={
          <Panel
            icon={Truck}
            title={`${t('del.run')} · ${data ? f.date(data.date) : ''}`}
            actions={
              data ? (
                <span className="flex w-44 items-center gap-2">
                  <Meter value={completion} tone="signal" />
                  <span className="t-data text-[12px]">{f.pct(completion)}</span>
                </span>
              ) : null
            }
            loading={today.isFetching}
          >
            {today.isError ? (
              <ErrorNote error={today.error} onRetry={() => today.refetch()} />
            ) : today.isLoading ? (
              <Loading rows={8} />
            ) : rows.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="grid-table">
                  <thead>
                    <tr>
                      <th>{t('del.shipment')}</th>
                      <th>{t('del.status')}</th>
                      <th>{t('del.customer')}</th>
                      <th>{t('del.destination')}</th>
                      <th className="text-right">ETA</th>
                      <th className="text-right">{t('del.v3.arrival')}</th>
                      <th className="text-right">{t('del.attempts')}</th>
                      <th>{t('del.note')}</th>
                      <th>
                        <span className="sr-only">{t('prov.demo')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="stagger">
                    {rows.map((delivery) => {
                      const shipmentId = delivery.shipment.id ?? delivery.shipmentId;
                      const risk = isAtRisk(delivery, now);
                      return (
                        <tr
                          key={delivery.id}
                          data-row-id={delivery.id}
                          aria-selected={delivery.id === selectedId}
                          tabIndex={0}
                          className="cursor-pointer"
                          onClick={() => setSelectedId(delivery.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && event.target === event.currentTarget) setSelectedId(delivery.id);
                          }}
                        >
                          <td className="whitespace-nowrap">
                            {shipmentId ? (
                              <Link
                                href={shipmentHref(shipmentId)}
                                onClick={(event) => event.stopPropagation()}
                                className="t-data text-[13px] text-[var(--color-ink)] hover:underline"
                              >
                                {delivery.shipment.trackingNumber}
                              </Link>
                            ) : (
                              <span className="t-data text-[13px]">{delivery.shipment.trackingNumber}</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap">
                            <span className="flex items-center gap-1.5">
                              {risk && <SeverityIcon severity="warning" size={14} />}
                              {delivery.status === 'FAILED' && <SeverityIcon severity="critical" size={14} />}
                              <Chip tone={delivery.status === 'DELIVERED' ? 'ok' : CLOSED.includes(delivery.status) ? statusTone(delivery.status) : 'neutral'}>
                                {delivery.status.replace(/_/g, ' ').toLowerCase()}
                              </Chip>
                            </span>
                          </td>
                          <td className="text-[var(--color-muted)]">{delivery.customer?.name ?? '—'}</td>
                          <td className="text-[var(--color-muted)]">{delivery.shipment.destinationName}</td>
                          <td className="t-data whitespace-nowrap text-right text-[12px] text-[var(--color-muted)]">
                            {delivery.deliveredAt
                              ? f.time(delivery.deliveredAt)
                              : f.relative(delivery.shipment.estimatedArrivalAt)}
                          </td>
                          <td className="t-data whitespace-nowrap text-right text-[12px]">
                            {delivery.arrivedAt ? f.time(delivery.arrivedAt) : '—'}
                          </td>
                          <td className="t-data text-right text-[12px]">
                            <span className="inline-flex items-center gap-1">
                              {delivery.attemptCount > 1 && <SeverityIcon severity="warning" size={14} />}
                              {delivery.attemptCount || '—'}
                            </span>
                          </td>
                          <td className="max-w-[240px] truncate text-[12.5px] text-[var(--color-ink)]" title={delivery.failureReason ?? undefined}>
                            {delivery.failureReason ?? ''}
                          </td>
                          <td className="text-right">{delivery.isDemoData && <DemoTag />}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : filter !== 'all' ? (
              <Empty
                icon={FilterX}
                title={t('del.v3.emptyFiltered')}
                action={
                  <Button size="sm" icon={FilterX} onClick={() => setFilter('all')}>
                    {t('ship.v3.clearFilters')}
                  </Button>
                }
              />
            ) : (
              <Empty title={t('del.none')} hint={t('del.noneHint')} />
            )}
          </Panel>
        }
        detail={
          selected ? (
            <DeliveryPanel key={selected.id} delivery={selected} atRisk={isAtRisk(selected, now)} onClose={() => setSelectedId(null)} />
          ) : (
            <DetailHint>{t('del.v3.pickHint')}</DetailHint>
          )
        }
      />

      {/* The endpoint stays a literal inside the sentence: an API path is not translatable, and
          splitting it out keeps it monospaced in both languages. */}
      <p className="rise m-0 max-w-[880px] text-[12.5px] leading-relaxed text-[var(--color-muted)]">
        {t('del.podNote', { endpoint: 'POST /deliveries/:id/proof' })}
      </p>
    </div>
  );
}

function DeliveryPanel({
  delivery,
  atRisk,
  onClose,
}: {
  delivery: DeliveryRow;
  atRisk: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const f = useFormat();
  const toast = useToast();
  const client = useQueryClient();
  const [receiver, setReceiver] = useState('');
  const [notes, setNotes] = useState('');

  // The proof and the driver only come with the single-record read.
  const detail = useQuery({
    queryKey: ['deliveries', 'detail', delivery.id],
    queryFn: () => api<DeliveryDetail>(`/deliveries/${delivery.id}`),
  });

  const confirm = useMutation({
    mutationFn: () =>
      api<{ warning: string | null }>(`/deliveries/${delivery.id}/proof`, {
        method: 'POST',
        body: { receiverName: receiver.trim(), ...(notes.trim() ? { notes: notes.trim() } : {}) },
      }),
    onSuccess: (result) => {
      toast.show({
        message: result?.warning ?? t('del.v3.confirmedToast', { tracking: delivery.shipment.trackingNumber }),
        tone: result?.warning ? 'info' : 'success',
      });
      client.invalidateQueries({ queryKey: ['deliveries'] });
      client.invalidateQueries({ queryKey: ['shipments'] });
    },
    onError: (error) =>
      toast.show({ message: t('del.v3.confirmFailed', { reason: (error as Error).message ?? String(error) }), tone: 'error' }),
  });

  const shipmentId = delivery.shipment.id ?? delivery.shipmentId ?? detail.data?.shipment.id;
  const proof = detail.data?.proof ?? null;
  const driver = detail.data?.shipment.driver;
  const canConfirm = CONFIRMABLE.includes(delivery.status);
  const farAway = proof?.distanceToDestinationM !== null && proof?.distanceToDestinationM !== undefined
    ? proof.distanceToDestinationM > POD_DISTANCE_WARNING_M
    : false;

  return (
    <DetailPanel
      onClose={onClose}
      kicker={t('del.v3.kickerDetail')}
      title={<span className="t-data text-[18px]">{delivery.shipment.trackingNumber}</span>}
      status={
        <>
          {atRisk && <SeverityIcon severity="warning" size={16} />}
          {delivery.status === 'FAILED' && <SeverityIcon severity="critical" size={16} />}
          <Chip tone={delivery.status === 'DELIVERED' ? 'ok' : CLOSED.includes(delivery.status) ? statusTone(delivery.status) : 'neutral'}>
            {delivery.status.replace(/_/g, ' ').toLowerCase()}
          </Chip>
          {atRisk && <span className="text-[12px] text-[var(--color-muted)]">{t('del.v3.atRisk')}</span>}
          {delivery.isDemoData && <DemoTag />}
        </>
      }
      actions={
        shipmentId ? (
          <Link href={shipmentHref(shipmentId)} className="btn">
            <ExternalLink />
            {t('del.v3.openShipment')}
          </Link>
        ) : undefined
      }
    >
      <p className="m-0 text-[13.5px]">
        {delivery.customer?.name ?? '—'} <span className="text-[var(--color-dim)]">·</span>{' '}
        <span className="text-[var(--color-muted)]">{delivery.shipment.destinationName}</span>
      </p>

      {delivery.failureReason && (
        <Banner tone="alert" title={t('del.v3.failedTitle')}>
          {delivery.failureReason}
        </Banner>
      )}

      <div className="tile p-4">
        <Facts
          items={[
            ['ETA', <span key="e" className="t-data">{f.dateTime(delivery.shipment.estimatedArrivalAt)}</span>],
            [t('del.v3.arrival'), <span key="a" className="t-data">{f.dateTime(delivery.arrivedAt ?? null)}</span>],
            [t('del.v3.proof'), proof ? t('del.v3.proofYes') : delivery.status === 'DELIVERED' ? t('del.v3.proofMissing') : '—'],
            [t('del.attempts'), <span key="n" className="t-data">{delivery.attemptCount || '—'}</span>],
          ]}
        />
      </div>

      {driver && (
        <Facts items={[[t('del.v3.driver'), `${driver.firstName} ${driver.lastName}`], [t('del.v3.phone'), <span key="p" className="t-data">{driver.phone ?? '—'}</span>]]} />
      )}

      <DetailSection title={t('del.v3.history')}>
        <History
          items={[
            { label: t('del.v3.evAssigned'), at: f.time(delivery.assignedAt), done: true },
            { label: t('del.v3.evPickedUp'), at: f.time(delivery.pickedUpAt ?? null), done: Boolean(delivery.pickedUpAt) },
            { label: t('del.v3.evArrived'), at: f.time(delivery.arrivedAt ?? null), done: Boolean(delivery.arrivedAt) },
            delivery.status === 'FAILED'
              ? { label: t('del.v3.evFailed'), at: f.time(delivery.failedAt ?? null), done: true, exception: true }
              : { label: t('del.v3.evDelivered'), at: f.time(delivery.deliveredAt), done: Boolean(delivery.deliveredAt) },
          ]}
        />
      </DetailSection>

      <DetailSection title={t('del.v3.proof')}>
        {detail.isLoading ? (
          <Loading rows={2} />
        ) : detail.isError ? (
          <ErrorNote error={detail.error} onRetry={() => detail.refetch()} />
        ) : proof ? (
          <div className="flex flex-col gap-3">
            <Facts
              items={[
                [t('del.v3.receiver'), proof.receiverName],
                [t('del.v3.captured'), <span key="c" className="t-data">{f.dateTime(proof.capturedAt)}</span>],
              ]}
            />
            {proof.distanceToDestinationM !== null && (
              <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-muted)]">
                {farAway && <SeverityIcon severity="warning" size={14} />}
                {t('del.v3.distance', { km: f.num(proof.distanceToDestinationM / 1000, 1) })}
              </span>
            )}
            {proof.isDemoData && <DemoTag />}
            {proof.notes && <p className="m-0 text-[12.5px] text-[var(--color-muted)]">{proof.notes}</p>}
            {(proof.signatureUrl || proof.photos.length > 0) && (
              <div className="flex flex-wrap gap-2">
                {proof.signatureUrl && (
                  <a href={proof.signatureUrl} target="_blank" rel="noreferrer" className="tile lift block p-1.5">
                    {/* eslint-disable-next-line @next/next/no-img-element -- presigned, short-lived object URL */}
                    <img src={proof.signatureUrl} alt={t('del.v3.signature')} className="h-16 w-28 object-contain" />
                  </a>
                )}
                {proof.photos.map((url, index) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer" className="tile lift block overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element -- presigned, short-lived object URL */}
                    <img src={url} alt={t('del.v3.photo', { n: index + 1 })} className="h-16 w-16 object-cover" />
                  </a>
                ))}
              </div>
            )}
            <span className="text-[11px] text-[var(--color-dim)]">{t('del.v3.linksExpire')}</span>
          </div>
        ) : canConfirm ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (receiver.trim().length >= 2) confirm.mutate();
            }}
          >
            <label className="flex flex-col gap-1 text-[12.5px] text-[var(--color-muted)]">
              {t('del.v3.receiver')}
              <input
                className="field"
                value={receiver}
                onChange={(event) => setReceiver(event.target.value)}
                minLength={2}
                maxLength={160}
                required
              />
            </label>
            <label className="flex flex-col gap-1 text-[12.5px] text-[var(--color-muted)]">
              {t('del.v3.notes')}
              <input className="field" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} />
            </label>
            <span className="text-[12px] text-[var(--color-dim)]">{t('del.v3.confirmHint')}</span>
            <div>
              <Button
                type="submit"
                variant="primary"
                icon={FileSignature}
                loading={confirm.isPending}
                disabled={receiver.trim().length < 2}
              >
                {t('del.v3.confirm')}
              </Button>
            </div>
          </form>
        ) : (
          <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-muted)]">
            {delivery.status === 'DELIVERED' ? <CircleCheck className="h-3.5 w-3.5" /> : null}
            {delivery.status === 'ASSIGNED' ? t('del.v3.notYetPicked') : t('del.v3.noProof')}
          </span>
        )}
      </DetailSection>
    </DetailPanel>
  );
}
