'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ExternalLink, FilterX, Map as MapIcon, Package, Ship, Truck } from 'lucide-react';
import { api, type Paginated, type ShipmentRow } from '@/lib/api';
import {
  Banner,
  Button,
  Chip,
  DemoTag,
  Empty,
  ErrorNote,
  Facts,
  Loading,
  Meter,
  PageHeader,
  Panel,
  Provenance,
  SeverityIcon,
  riskTone,
  statusTone,
  toSeverity,
} from '@/components/ui';
import { useFormat, useI18n } from '@/lib/i18n';
import {
  DetailHint,
  DetailPanel,
  DetailSection,
  FilterPill,
  History,
  ListDetailLayout,
  formatGap,
  useListKeys,
} from './_components/track-kit';
import { shipmentHref } from '@/lib/routes';

const STATUSES = [
  'PLANNED',
  'LOADING',
  'DEPARTED',
  'IN_TRANSIT',
  'DELAYED',
  'ARRIVED',
  'DELIVERED',
  'CANCELLED',
] as const;

/**
 * The list endpoint returns every Shipment scalar; the shared `ShipmentRow` type only names the
 * ones older screens used. These are the extra ones this screen reads, all optional so an older
 * API build simply shows "—".
 */
type Row = ShipmentRow & {
  voyageId?: string | null;
  cargoValue?: string | number | null;
  currency?: string | null;
  actualDepartureAt?: string | null;
  actualArrivalAt?: string | null;
  etaConfidence?: number | null;
  purchaseOrder?: { id: string; orderNumber: string } | null;
};

/** Minutes a gap must exceed before it earns an icon — below that it is GPS and traffic noise. */
const LATE_WARN_MIN = 15;
const LATE_CRIT_MIN = 120;

/** ETA − promised, in minutes. Null when there is no live ETA to compare. */
function gapMinutes(row: Row): number | null {
  const eta = row.deliveredAt ?? row.estimatedArrivalAt;
  if (!eta) return null;
  return (new Date(eta).getTime() - new Date(row.plannedArrivalAt).getTime()) / 60_000;
}

function gapSeverity(minutes: number | null): 'critical' | 'warning' | null {
  if (minutes === null || minutes <= LATE_WARN_MIN) return null;
  return minutes > LATE_CRIT_MIN ? 'critical' : 'warning';
}

export default function ShipmentsPage() {
  return (
    // useSearchParams needs a Suspense boundary so the route can still be prerendered.
    <Suspense fallback={<Loading rows={8} />}>
      <ShipmentsView />
    </Suspense>
  );
}

function ShipmentsView() {
  const { t } = useI18n();
  const f = useFormat();
  const params = useSearchParams();
  const [status, setStatus] = useState<string>('');
  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const [activeOnly, setActiveOnly] = useState(true);
  const [demoOnly, setDemoOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['shipments', { status, search, activeOnly, page }],
    queryFn: () => {
      const qs = new URLSearchParams({ page: String(page), limit: '30' });
      if (status) qs.set('status', status);
      if (search) qs.set('search', search);
      if (activeOnly && !status) qs.set('activeOnly', 'true');
      return api<Paginated<Row>>(`/shipments?${qs}`);
    },
    placeholderData: keepPreviousData,
    refetchInterval: 25_000,
  });

  // Totals for the pills and the title. `limit=1` keeps them to a count query each.
  const countOf = (extra: string) =>
    api<Paginated<Row>>(`/shipments?limit=1${extra}`).then((response) => response.meta.total);
  const openCount = useQuery({ queryKey: ['shipments', 'count', 'open'], queryFn: () => countOf('&activeOnly=true'), refetchInterval: 60_000 });
  const allCount = useQuery({ queryKey: ['shipments', 'count', 'all'], queryFn: () => countOf(''), refetchInterval: 60_000 });
  const delayedCount = useQuery({ queryKey: ['shipments', 'count', 'DELAYED'], queryFn: () => countOf('&status=DELAYED'), refetchInterval: 60_000 });

  const loaded = query.data?.data ?? [];
  const rows = demoOnly ? loaded.filter((row) => row.isDemoData) : loaded;
  const demoOnPage = loaded.filter((row) => row.isDemoData).length;
  const ids = useMemo(() => rows.map((row) => row.id), [rows]);
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  const select = useCallback((id: string | null) => setSelectedId(id), []);
  useListKeys(ids, selectedId, select);

  const lateOnPage = loaded.filter((row) => gapSeverity(gapMinutes(row)) !== null).length;
  const critOnPage = loaded.filter((row) => gapSeverity(gapMinutes(row)) === 'critical').length;
  const filtered = Boolean(status || search || !activeOnly || demoOnly);

  const clearFilters = () => {
    setStatus('');
    setSearch('');
    setActiveOnly(true);
    setDemoOnly(false);
    setPage(1);
  };

  // Title = the situation (charte test des 3 secondes), computed from the server-wide DELAYED count.
  const delayed = delayedCount.data;
  const title =
    delayed === undefined
      ? t('ship.title')
      : delayed === 0
        ? t('ship.v3.titleNone')
        : t(delayed === 1 ? 'ship.v3.titleOne' : 'ship.v3.titleMany', { n: f.int(delayed) });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={t('ship.v3.kicker')}
        title={title}
        description={
          query.data
            ? t('ship.v3.description', { late: f.int(lateOnPage), crit: f.int(critOnPage) })
            : t('ship.v3.question')
        }
        meta={<Provenance kind="poll" seconds={25} />}
      />

      <div className="rise flex flex-wrap items-center gap-2">
        <FilterPill
          active={activeOnly && !status}
          count={openCount.data}
          onClick={() => {
            setStatus('');
            setActiveOnly(true);
            setPage(1);
          }}
        >
          {t('ship.v3.pillOpen')}
        </FilterPill>
        <FilterPill
          active={status === 'DELAYED'}
          count={delayedCount.data}
          icon={delayed ? <SeverityIcon severity="warning" size={14} /> : undefined}
          onClick={() => {
            setStatus(status === 'DELAYED' ? '' : 'DELAYED');
            setPage(1);
          }}
        >
          {t('ship.v3.pillDelayed')}
        </FilterPill>
        <FilterPill
          active={!activeOnly && !status}
          count={allCount.data}
          onClick={() => {
            setStatus('');
            setActiveOnly(false);
            setPage(1);
          }}
        >
          {t('ship.v3.pillAll')}
        </FilterPill>
        {(demoOnPage > 0 || demoOnly) && (
          <FilterPill demo active={demoOnly} count={demoOnPage} onClick={() => setDemoOnly((on) => !on)}>
            {t('prov.demo')}
          </FilterPill>
        )}

        <span className="ml-auto flex flex-wrap items-center gap-2">
          <input
            className="field min-w-[220px]"
            type="search"
            aria-label={t('tbl.search')}
            placeholder={t('ship.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
          <select
            className="field w-auto"
            aria-label={t('ship.status')}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('tbl.allStatuses')}</option>
            {STATUSES.map((option) => (
              <option key={option} value={option}>
                {option.toLowerCase().replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-[var(--color-muted)]">
            <input
              type="checkbox"
              checked={activeOnly}
              disabled={Boolean(status)}
              onChange={(event) => {
                setActiveOnly(event.target.checked);
                setPage(1);
              }}
              className="accent-[var(--color-accent)]"
            />
            {t('ship.openOnly')}
          </label>
        </span>
      </div>

      <ListDetailLayout
        list={
          <Panel
            icon={Package}
            title={t('ship.title')}
            meta={query.data ? <span className="pill-count">{f.int(query.data.meta.total)}</span> : null}
            loading={query.isFetching}
          >
            {query.isError ? (
              <ErrorNote error={query.error} onRetry={() => query.refetch()} />
            ) : query.isLoading ? (
              <Loading rows={8} />
            ) : rows.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="grid-table">
                  <thead>
                    <tr>
                      <th>{t('ship.tracking')}</th>
                      <th>{t('ship.status')}</th>
                      <th>{t('ship.route')}</th>
                      <th>{t('ship.carrier')}</th>
                      <th>{t('ship.vehicle')}</th>
                      <th className="text-right">{t('ship.progress')}</th>
                      <th className="text-right">{t('ship.promised')}</th>
                      <th className="text-right">{t('ship.eta')}</th>
                      <th className="text-right">{t('ship.v3.gap')}</th>
                      <th className="text-right">{t('ship.delayRisk')}</th>
                      <th>
                        <span className="sr-only">{t('prov.demo')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="stagger">
                    {rows.map((shipment) => {
                      const progress =
                        shipment.plannedDistanceKm > 0
                          ? Math.min(1, shipment.travelledDistanceKm / shipment.plannedDistanceKm)
                          : 0;
                      const gap = gapMinutes(shipment);
                      const severity = gapSeverity(gap);
                      const sea = Boolean(shipment.voyageId);
                      const ModeIcon = sea ? Ship : Truck;

                      return (
                        <tr
                          key={shipment.id}
                          data-row-id={shipment.id}
                          aria-selected={shipment.id === selectedId}
                          tabIndex={0}
                          className="cursor-pointer"
                          onClick={() => setSelectedId(shipment.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && event.target === event.currentTarget) setSelectedId(shipment.id);
                          }}
                        >
                          <td>
                            <Link
                              href={shipmentHref(shipment.id)}
                              onClick={(event) => event.stopPropagation()}
                              className="t-data whitespace-nowrap text-[13px] text-[var(--color-ink)] hover:underline"
                            >
                              {shipment.trackingNumber}
                            </Link>
                          </td>
                          <td>
                            <span className="flex items-center gap-1.5 whitespace-nowrap">
                              <Chip tone={statusTone(shipment.status)}>{shipment.status.replace(/_/g, ' ').toLowerCase()}</Chip>
                              {shipment.hasOpenAnomaly && (
                                <span className="flex items-center gap-1 text-[12px] text-[var(--color-muted)]" title={t('ship.anomaly')}>
                                  <SeverityIcon severity="critical" size={14} />
                                  {t('ship.anomaly')}
                                </span>
                              )}
                            </span>
                          </td>
                          <td className="whitespace-nowrap text-[var(--color-muted)]">
                            <span className="flex items-center gap-1.5">
                              <ModeIcon
                                className="h-3.5 w-3.5 shrink-0"
                                aria-label={sea ? t('ship.v3.modeSea') : t('ship.v3.modeRoad')}
                              />
                              <span className="text-[var(--color-ink)]">{shipment.originName}</span>
                              <span className="text-[var(--color-dim)]">→</span>
                              <span className="text-[var(--color-ink)]">{shipment.destinationName}</span>
                            </span>
                          </td>
                          <td className="whitespace-nowrap text-[var(--color-muted)]">{shipment.carrier?.name ?? '—'}</td>
                          <td className="t-data whitespace-nowrap text-[12px] text-[var(--color-muted)]">
                            {shipment.vehicle?.plateNumber ?? '—'}
                          </td>
                          <td className="w-28">
                            <div className="flex items-center justify-end gap-2">
                              <span className="t-data text-[12px] text-[var(--color-muted)]">{f.pct(progress)}</span>
                              <div className="w-12">
                                <Meter value={progress} tone={shipment.status === 'DELAYED' ? 'alert' : 'signal'} />
                              </div>
                            </div>
                          </td>
                          <td className="t-data whitespace-nowrap text-right text-[12px] text-[var(--color-muted)]">
                            {f.dateTime(shipment.plannedArrivalAt)}
                          </td>
                          <td className="t-data whitespace-nowrap text-right text-[12px] text-[var(--color-ink)]">
                            {shipment.estimatedArrivalAt ? f.relative(shipment.estimatedArrivalAt) : '—'}
                          </td>
                          <td className="t-data whitespace-nowrap text-right text-[12px]">
                            <span className="inline-flex items-center justify-end gap-1.5">
                              {severity && <SeverityIcon severity={severity} size={14} />}
                              <span className={severity ? 'text-[var(--color-ink)]' : 'text-[var(--color-muted)]'}>
                                {gap === null ? '—' : formatGap(gap, t('ship.v3.dayUnit'))}
                              </span>
                            </span>
                          </td>
                          <td className="whitespace-nowrap text-right">
                            {shipment.delayProbability === null ? (
                              <span className="t-data text-[11px] text-[var(--color-dim)]">{t('tbl.notComputed')}</span>
                            ) : (
                              <span className="inline-flex items-center justify-end gap-1.5">
                                {(shipment.delayRisk === 'HIGH' || shipment.delayRisk === 'MEDIUM') && (
                                  <SeverityIcon severity={toSeverity(shipment.delayRisk)} size={14} />
                                )}
                                <span className="t-data text-[12px]">{f.pct(shipment.delayProbability)}</span>
                              </span>
                            )}
                          </td>
                          <td className="text-right">{shipment.isDemoData && <DemoTag />}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                icon={filtered ? FilterX : Package}
                title={t('ship.noMatch')}
                hint={filtered ? t('ship.v3.emptyFiltered') : t('ship.noMatchHint')}
                action={
                  filtered ? (
                    <Button size="sm" icon={FilterX} onClick={clearFilters}>
                      {t('ship.v3.clearFilters')}
                    </Button>
                  ) : undefined
                }
              />
            )}

            {query.data && query.data.meta.totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-[var(--color-line)] px-5 py-3">
                <span className="t-label">
                  {t('tbl.page', { page: query.data.meta.page, total: query.data.meta.totalPages })}
                </span>
                <div className="flex gap-2">
                  <Button size="sm" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
                    {t('tbl.prev')}
                  </Button>
                  <Button
                    size="sm"
                    disabled={!query.data.meta.hasNextPage}
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
            <ShipmentDetail key={selected.id} shipment={selected} onClose={() => setSelectedId(null)} />
          ) : (
            <DetailHint>{t('ship.v3.pickHint')}</DetailHint>
          )
        }
      />
    </div>
  );
}

function ShipmentDetail({ shipment, onClose }: { shipment: Row; onClose: () => void }) {
  const { t } = useI18n();
  const f = useFormat();
  const gap = gapMinutes(shipment);
  const severity = gapSeverity(gap);
  const sea = Boolean(shipment.voyageId);
  const progress =
    shipment.plannedDistanceKm > 0 ? Math.min(1, shipment.travelledDistanceKm / shipment.plannedDistanceKm) : 0;
  const cargo = shipment.cargoValue !== undefined && shipment.cargoValue !== null ? Number(shipment.cargoValue) : null;
  const departed = shipment.actualDepartureAt ?? null;
  const arrived = shipment.actualArrivalAt ?? null;

  return (
    <DetailPanel
      onClose={onClose}
      kicker={`${t('ship.v3.kickerDetail')} · ${sea ? t('ship.v3.modeSea') : t('ship.v3.modeRoad')}`}
      title={<span className="t-data text-[18px]">{shipment.trackingNumber}</span>}
      status={
        <>
          <Chip tone={statusTone(shipment.status)}>{shipment.status.replace(/_/g, ' ').toLowerCase()}</Chip>
          {shipment.hasOpenAnomaly && (
            <span className="flex items-center gap-1 text-[12px] text-[var(--color-muted)]">
              <SeverityIcon severity="critical" size={14} />
              {t('ship.anomaly')}
            </span>
          )}
          {shipment.isDemoData && <DemoTag />}
        </>
      }
      actions={
        <>
          {shipment.vehicle ? (
            <Link href={`/map?vehicle=${shipment.vehicle.id}`} className="btn btn-primary">
              <MapIcon />
              {t('ship.v3.viewOnMap')}
            </Link>
          ) : (
            <span className="text-[12px] text-[var(--color-muted)]">{t('ship.v3.noVehicle')}</span>
          )}
          <Link href={shipmentHref(shipment.id)} className="btn">
            <ExternalLink />
            {t('ship.v3.open')}
          </Link>
        </>
      }
    >
      <p className="m-0 text-[13.5px] text-[var(--color-ink)]">
        {shipment.originName} <span className="text-[var(--color-dim)]">→</span> {shipment.destinationName}
      </p>

      {shipment.isDemoData && (
        <Banner tone="demo" title={t('ship.v3.demoTitle')}>
          {t('ship.v3.demoHint')}
        </Banner>
      )}

      <div className="tile p-4">
        <Facts
          items={[
            [t('ship.eta'), <span key="eta" className="t-data">{f.dateTime(shipment.estimatedArrivalAt)}</span>],
            [t('ship.promised'), <span key="p" className="t-data">{f.dateTime(shipment.plannedArrivalAt)}</span>],
            [
              t('ship.v3.gap'),
              <span key="g" className="t-data inline-flex items-center gap-1.5">
                {severity && <SeverityIcon severity={severity} size={14} />}
                {gap === null ? '—' : formatGap(gap, t('ship.v3.dayUnit'))}
              </span>,
            ],
            [
              t('ship.delayRisk'),
              <span key="r" className="t-data inline-flex items-center gap-1.5">
                {shipment.delayProbability === null ? (
                  t('tbl.notComputed')
                ) : (
                  <>
                    {riskTone(shipment.delayRisk) === 'alert' && <SeverityIcon severity="critical" size={14} />}
                    {riskTone(shipment.delayRisk) === 'warn' && <SeverityIcon severity="warning" size={14} />}
                    {f.pct(shipment.delayProbability)}
                  </>
                )}
              </span>,
            ],
          ]}
        />
      </div>

      <DetailSection title={t('ship.progress')}>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <Meter value={progress} tone={shipment.status === 'DELAYED' ? 'alert' : 'signal'} />
          </div>
          <span className="t-data whitespace-nowrap text-[12px] text-[var(--color-muted)]">
            {f.int(shipment.travelledDistanceKm)} / {f.int(shipment.plannedDistanceKm)} km
          </span>
        </div>
      </DetailSection>

      <DetailSection title={t('ship.v3.who')}>
        <Facts
          items={[
            [t('ship.carrier'), shipment.carrier?.name ?? '—'],
            [t('ship.vehicle'), <span key="v" className="t-data">{shipment.vehicle?.plateNumber ?? '—'}</span>],
            [
              t('ship.v3.driver'),
              shipment.driver ? `${shipment.driver.firstName} ${shipment.driver.lastName}` : '—',
            ],
            [t('ship.v3.customer'), shipment.customer?.name ?? '—'],
            [
              t('ship.v3.cargoValue'),
              <span key="c" className="t-data">{cargo === null ? '—' : f.money(cargo, shipment.currency ?? undefined)}</span>,
            ],
            [
              t('ship.v3.contents'),
              t('ship.v3.contentsValue', {
                items: f.int(shipment._count.items),
                incidents: f.int(shipment._count.incidents),
              }),
            ],
          ]}
        />
        {shipment.purchaseOrder && (
          <span className="text-[12.5px] text-[var(--color-muted)]">
            {t('ship.v3.purchaseOrder')}{' '}
            <Link href="/purchase-orders" className="t-data text-[var(--color-ink)] hover:underline">
              {shipment.purchaseOrder.orderNumber}
            </Link>
          </span>
        )}
      </DetailSection>

      <DetailSection title={t('ship.v3.history')}>
        <History
          items={[
            {
              label: t('ship.v3.evDeparture'),
              at: f.dateTime(departed ?? shipment.plannedDepartureAt),
              done: Boolean(departed) || !['PLANNED', 'LOADING'].includes(shipment.status),
            },
            {
              label: shipment.deliveredAt ? t('ship.v3.evDelivered') : arrived ? t('ship.v3.evArrived') : t('ship.v3.evEta'),
              at: f.dateTime(shipment.deliveredAt ?? arrived ?? shipment.estimatedArrivalAt),
              done: Boolean(shipment.deliveredAt ?? arrived),
              exception: severity === 'critical',
            },
            { label: t('ship.v3.evPromised'), at: f.dateTime(shipment.plannedArrivalAt), done: false },
          ]}
        />
      </DetailSection>
    </DetailPanel>
  );
}
