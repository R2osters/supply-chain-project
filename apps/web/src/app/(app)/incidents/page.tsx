'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { CircleCheck, FilterX, Package, Sparkles, TriangleAlert, UserX } from 'lucide-react';
import { api, type Paginated } from '@/lib/api';
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
  PageHeader,
  Panel,
  SeverityIcon,
  statusTone,
  toSeverity,
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

interface IncidentRow {
  id: string;
  type: string;
  severity: string;
  status: string;
  title: string;
  description: string;
  occurredAt: string;
  resolvedAt: string | null;
  estimatedCost: string | null;
  /** Returned by the list endpoint (every scalar is), optional for older API builds. */
  resolution?: string | null;
  isDemoData?: boolean;
  shipment: { id: string; trackingNumber: string; status: string } | null;
  reportedBy: { firstName: string; lastName: string } | null;
  assignedTo: { firstName: string; lastName: string } | null;
}

interface Summary {
  windowDays: number;
  total: number;
  open: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
  estimatedCost: number;
}

const STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'] as const;
const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const isOpen = (status: string) => status === 'OPEN' || status === 'INVESTIGATING';

/** CRITICAL and HIGH both draw the octagon; MEDIUM the triangle; LOW stays a neutral circle. */
const severityOf = (severity: string) => toSeverity(severity === 'CRITICAL' ? 'HIGH' : severity);

export default function IncidentsPage() {
  const { t } = useI18n();
  const f = useFormat();
  const client = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [demoOnly, setDemoOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const summary = useQuery({
    queryKey: ['incidents', 'summary'],
    queryFn: () => api<Summary>('/incidents/summary?days=90'),
  });

  const incidents = useQuery({
    queryKey: ['incidents', { status, page }],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: '30' });
      if (status) params.set('status', status);
      return api<Paginated<IncidentRow>>(`/incidents?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  // One count query per status pill (limit=1 → just the total), not windowed like the summary.
  const counts = useQuery({
    queryKey: ['incidents', 'counts'],
    queryFn: async () => {
      const totals = await Promise.all(
        ['', ...STATUSES].map((value) =>
          api<Paginated<IncidentRow>>(`/incidents?limit=1${value ? `&status=${value}` : ''}`).then(
            (response) => [value, response.meta.total] as const,
          ),
        ),
      );
      return Object.fromEntries(totals) as Record<string, number>;
    },
    refetchInterval: 60_000,
  });

  const resolve = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api(`/incidents/${id}`, { method: 'PATCH', body }),
    onSettled: () => client.invalidateQueries({ queryKey: ['incidents'] }),
  });

  /**
   * Resolve at once and offer Undo (charte "annuler plutôt que confirmer"). The API wants a
   * resolution text before closing; when the incident has none, a neutral one records where the
   * decision was taken. Undo puts the previous status back.
   */
  const markResolved = (incident: IncidentRow) => {
    const previous = incident.status;
    resolve.mutate(
      {
        id: incident.id,
        body: {
          status: 'RESOLVED',
          ...(incident.resolution ? {} : { resolution: t('inc.v3.defaultResolution') }),
        },
      },
      {
        onSuccess: () =>
          toast.show({
            message: t('inc.v3.resolvedToast', { title: incident.title }),
            tone: 'success',
            onUndo: () =>
              resolve.mutate(
                { id: incident.id, body: { status: previous } },
                {
                  onSuccess: () => toast.show({ message: t('inc.v3.reopenedToast'), tone: 'info' }),
                  onError: (error) => toast.show({ message: String((error as Error).message ?? error), tone: 'error' }),
                },
              ),
          }),
        onError: (error) =>
          toast.show({ message: t('inc.v3.resolveFailed', { reason: (error as Error).message ?? String(error) }), tone: 'error' }),
      },
    );
  };

  const loaded = incidents.data?.data ?? [];
  const rows = loaded.filter(
    (row) => (!unassignedOnly || (!row.assignedTo && isOpen(row.status))) && (!demoOnly || row.isDemoData),
  );
  const unassignedOnPage = loaded.filter((row) => !row.assignedTo && isOpen(row.status)).length;
  const demoOnPage = loaded.filter((row) => row.isDemoData).length;
  const ids = useMemo(() => rows.map((row) => row.id), [rows]);
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const select = useCallback((id: string | null) => setSelectedId(id), []);
  useListKeys(ids, selectedId, select);

  const openTotal = counts.data ? (counts.data.OPEN ?? 0) + (counts.data.INVESTIGATING ?? 0) : undefined;
  const title =
    openTotal === undefined
      ? t('inc.title')
      : openTotal === 0
        ? t('inc.v3.titleNone')
        : unassignedOnPage > 0
          ? t('inc.v3.titleUnassigned', { n: f.int(openTotal), u: f.int(unassignedOnPage) })
          : t(openTotal === 1 ? 'inc.v3.titleOne' : 'inc.v3.titleMany', { n: f.int(openTotal) });

  const filtered = Boolean(status || unassignedOnly || demoOnly);
  const clearFilters = () => {
    setStatus('');
    setUnassignedOnly(false);
    setDemoOnly(false);
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader kicker={t('inc.v3.kicker')} title={title} description={t('inc.v3.question')} />

      {summary.isError ? (
        <div className="panel">
          <ErrorNote error={summary.error} onRetry={() => summary.refetch()} />
        </div>
      ) : (
        <div className="stagger grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi
            label={t('inc.window', { days: summary.data?.windowDays ?? 90 })}
            value={summary.data ? f.int(summary.data.total) : '—'}
          />
          <Kpi
            label={t('inc.stillOpen')}
            value={summary.data ? f.int(summary.data.open) : '—'}
            tone={summary.data && summary.data.open > 0 ? 'warn' : 'neutral'}
          />
          <Kpi
            label={t('inc.estimatedCost')}
            value={summary.data ? f.money(summary.data.estimatedCost) : '—'}
          />
          <div className="panel rise flex min-w-0 flex-col gap-2 p-4">
            <span className="text-[12.5px] text-[var(--color-muted)]">{t('inc.bySeverity')}</span>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {summary.data &&
                SEVERITY_ORDER.filter((severity) => summary.data!.bySeverity[severity]).map((severity) => (
                  <span key={severity} className="flex items-center gap-1.5 text-[13px]">
                    <SeverityIcon severity={severityOf(severity)} size={14} />
                    <span className="text-[var(--color-muted)]">{severity.toLowerCase()}</span>
                    <span className="t-data">{f.int(summary.data!.bySeverity[severity])}</span>
                  </span>
                ))}
              {summary.data && Object.keys(summary.data.bySeverity).length === 0 && (
                <span className="text-[13px] text-[var(--color-muted)]">—</span>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="rise flex flex-wrap items-center gap-2">
        <FilterPill
          active={!status}
          count={counts.data?.['']}
          onClick={() => {
            setStatus('');
            setPage(1);
          }}
        >
          {t('inc.v3.pillAll')}
        </FilterPill>
        {STATUSES.map((value) => (
          <FilterPill
            key={value}
            active={status === value}
            count={counts.data?.[value]}
            onClick={() => {
              setStatus(status === value ? '' : value);
              setPage(1);
            }}
          >
            {t(`inc.v3.status.${value}` as 'inc.v3.status.OPEN')}
          </FilterPill>
        ))}
        {(unassignedOnPage > 0 || unassignedOnly) && (
          <FilterPill
            active={unassignedOnly}
            count={unassignedOnPage}
            icon={<UserX />}
            onClick={() => setUnassignedOnly((on) => !on)}
          >
            {t('inc.v3.unassigned')}
          </FilterPill>
        )}
        {(demoOnPage > 0 || demoOnly) && (
          <FilterPill demo active={demoOnly} count={demoOnPage} onClick={() => setDemoOnly((on) => !on)}>
            {t('prov.demo')}
          </FilterPill>
        )}
      </div>

      <ListDetailLayout
        list={
          <Panel icon={TriangleAlert} title={t('inc.title')} loading={incidents.isFetching}>
            {incidents.isError ? (
              <ErrorNote error={incidents.error} onRetry={() => incidents.refetch()} />
            ) : incidents.isLoading ? (
              <Loading rows={8} />
            ) : rows.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="grid-table">
                  <thead>
                    <tr>
                      <th>
                        <span className="sr-only">{t('inc.severity')}</span>
                      </th>
                      <th>{t('inc.what')}</th>
                      <th>{t('inc.status')}</th>
                      <th>{t('inc.assignedTo')}</th>
                      <th>{t('inc.shipment')}</th>
                      <th className="text-right">{t('inc.cost')}</th>
                      <th className="text-right">{t('inc.when')}</th>
                    </tr>
                  </thead>
                  <tbody className="stagger">
                    {rows.map((incident) => (
                      <tr
                        key={incident.id}
                        data-row-id={incident.id}
                        aria-selected={incident.id === selectedId}
                        tabIndex={0}
                        className="cursor-pointer"
                        onClick={() => setSelectedId(incident.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && event.target === event.currentTarget) setSelectedId(incident.id);
                        }}
                      >
                        <td className="w-8" title={incident.severity.toLowerCase()}>
                          <SeverityIcon severity={severityOf(incident.severity)} size={14} />
                        </td>
                        <td className="min-w-[220px]">
                          <span className="flex flex-col gap-0.5">
                            <span className="flex flex-wrap items-center gap-2">
                              <b className="font-medium">{incident.title}</b>
                              {incident.isDemoData && <DemoTag />}
                            </span>
                            <span className="t-label">{incident.type.replace(/_/g, ' ')}</span>
                          </span>
                        </td>
                        <td>
                          <Chip tone={isOpen(incident.status) ? 'neutral' : statusTone(incident.status)}>
                            {t(`inc.v3.status.${incident.status}` as 'inc.v3.status.OPEN')}
                          </Chip>
                        </td>
                        <td className="whitespace-nowrap">
                          {incident.assignedTo ? (
                            `${incident.assignedTo.firstName} ${incident.assignedTo.lastName}`
                          ) : isOpen(incident.status) ? (
                            <span className="flex items-center gap-1.5 text-[var(--color-muted)]">
                              <SeverityIcon severity="warning" size={14} />
                              {t('inc.v3.unassigned')}
                            </span>
                          ) : (
                            <span className="text-[var(--color-dim)]">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap">
                          {incident.shipment ? (
                            <Link
                              href={shipmentHref(incident.shipment.id)}
                              onClick={(event) => event.stopPropagation()}
                              className="t-data text-[12px] text-[var(--color-ink)] hover:underline"
                            >
                              {incident.shipment.trackingNumber}
                            </Link>
                          ) : (
                            <span className="text-[var(--color-dim)]">—</span>
                          )}
                        </td>
                        <td className="t-data whitespace-nowrap text-right text-[12px]">
                          {incident.estimatedCost ? f.money(incident.estimatedCost) : '—'}
                        </td>
                        <td className="t-data whitespace-nowrap text-right text-[12px] text-[var(--color-muted)]">
                          {f.relative(incident.occurredAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                icon={filtered ? FilterX : CircleCheck}
                title={t('inc.none')}
                hint={t('inc.noneHint')}
                action={
                  filtered ? (
                    <Button size="sm" icon={FilterX} onClick={clearFilters}>
                      {t('ship.v3.clearFilters')}
                    </Button>
                  ) : undefined
                }
              />
            )}

            {incidents.data && incidents.data.meta.totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-[var(--color-line)] px-5 py-3">
                <span className="t-label">
                  {t('tbl.page', { page: incidents.data.meta.page, total: incidents.data.meta.totalPages })}
                </span>
                <div className="flex gap-2">
                  <Button size="sm" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
                    {t('tbl.prev')}
                  </Button>
                  <Button
                    size="sm"
                    disabled={!incidents.data.meta.hasNextPage}
                    onClick={() => setPage((current) => current + 1)}
                  >
                    {t('tbl.next')}
                  </Button>
                </div>
              </div>
            )}
          </Panel>
        }
        detail={
          selected ? (
            <IncidentDetail
              key={selected.id}
              incident={selected}
              onClose={() => setSelectedId(null)}
              onResolve={() => markResolved(selected)}
              resolving={resolve.isPending}
            />
          ) : (
            <DetailHint>{t('inc.v3.pickHint')}</DetailHint>
          )
        }
      />
    </div>
  );
}

function IncidentDetail({
  incident,
  onClose,
  onResolve,
  resolving,
}: {
  incident: IncidentRow;
  onClose: () => void;
  onResolve: () => void;
  resolving: boolean;
}) {
  const { t } = useI18n();
  const f = useFormat();
  const open = isOpen(incident.status);

  return (
    <DetailPanel
      onClose={onClose}
      kicker={`${t('inc.v3.kickerDetail')} · ${incident.type.replace(/_/g, ' ').toLowerCase()}`}
      title={incident.title}
      status={
        <>
          <SeverityIcon severity={severityOf(incident.severity)} size={16} />
          <Chip tone={open ? 'neutral' : statusTone(incident.status)}>
            {t(`inc.v3.status.${incident.status}` as 'inc.v3.status.OPEN')}
          </Chip>
          {incident.isDemoData && <DemoTag />}
        </>
      }
      actions={
        open ? (
          <Button variant="primary" icon={CircleCheck} loading={resolving} onClick={onResolve}>
            {t('inc.v3.markResolved')}
          </Button>
        ) : undefined
      }
    >
      {incident.isDemoData && (
        <Banner tone="demo" title={t('inc.v3.demoTitle')}>
          {t('inc.v3.demoHint')}
        </Banner>
      )}
      {open && !incident.assignedTo && (
        <Banner tone="warn" icon={UserX} title={t('inc.v3.unassignedTitle')}>
          {t('inc.v3.unassignedHint')}
        </Banner>
      )}

      <p className="m-0 text-[13.5px] leading-relaxed text-[var(--color-muted)] [text-wrap:pretty]">
        {incident.description}
      </p>

      <div className="tile p-4">
        <Facts
          items={[
            [t('inc.severity'), incident.severity.toLowerCase()],
            [t('inc.assignedTo'), incident.assignedTo ? `${incident.assignedTo.firstName} ${incident.assignedTo.lastName}` : t('inc.v3.unassigned')],
            [t('inc.cost'), <span key="c" className="t-data">{incident.estimatedCost ? f.money(incident.estimatedCost) : '—'}</span>],
            [t('inc.when'), <span key="w" className="t-data">{f.dateTime(incident.occurredAt)}</span>],
          ]}
        />
      </div>

      <DetailSection title={t('inc.v3.history')}>
        <History
          items={[
            {
              label: incident.reportedBy
                ? t('inc.reportedByName', { name: `${incident.reportedBy.firstName} ${incident.reportedBy.lastName}` })
                : t('inc.v3.evReported'),
              at: f.dateTime(incident.occurredAt),
              done: true,
            },
            {
              label: incident.assignedTo
                ? t('inc.assignedToName', { name: `${incident.assignedTo.firstName} ${incident.assignedTo.lastName}` })
                : t('inc.v3.evUnassigned'),
              at: '',
              done: Boolean(incident.assignedTo),
            },
            {
              label: incident.resolvedAt
                ? t('inc.resolvedWhen', { when: f.relative(incident.resolvedAt) })
                : t('inc.v3.evNotResolved'),
              at: incident.resolvedAt ? f.dateTime(incident.resolvedAt) : '',
              done: Boolean(incident.resolvedAt) && !open,
            },
          ]}
        />
        {incident.resolution && (
          <p className="m-0 text-[12.5px] text-[var(--color-muted)]">
            <span className="t-label mr-2">{t('inc.v3.resolution')}</span>
            {incident.resolution}
          </p>
        )}
      </DetailSection>

      {/* The decision loop: an incident is TRACK; what to do about it lives in OPTIMISE. */}
      <DetailSection title={t('inc.v3.loop')}>
        <div className="flex flex-col gap-1.5">
          {incident.shipment && (
            <Link
              href={shipmentHref(incident.shipment.id)}
              className="flex items-center gap-2 text-[13px] text-[var(--color-ink)] hover:underline"
            >
              <Package className="h-4 w-4 text-[var(--color-muted)]" />
              {t('inc.v3.relatedShipment')}
              <span className="t-data">{incident.shipment.trackingNumber}</span>
            </Link>
          )}
          <Link
            href="/recommendations"
            className="flex items-center gap-2 text-[13px] text-[var(--color-ink)] hover:underline"
          >
            <Sparkles className="h-4 w-4 text-[var(--color-muted)]" />
            {t('inc.v3.toRecommendations')}
          </Link>
        </div>
      </DetailSection>
    </DetailPanel>
  );
}
