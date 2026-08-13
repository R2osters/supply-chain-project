'use client';

import Link from 'next/link';
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type Paginated, type ShipmentRow } from '@/lib/api';
import {
  Chip,
  Empty,
  ErrorNote,
  Loading,
  Meter,
  Panel,
  fmt,
  riskTone,
  statusTone,
} from '@/components/ui';

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

export default function ShipmentsPage() {
  const [status, setStatus] = useState<string>('');
  const [search, setSearch] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ['shipments', { status, search, activeOnly, page }],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: '30' });
      if (status) params.set('status', status);
      if (search) params.set('search', search);
      if (activeOnly && !status) params.set('activeOnly', 'true');
      return api<Paginated<ShipmentRow>>(`/shipments?${params}`);
    },
    placeholderData: keepPreviousData,
    refetchInterval: 25_000,
  });

  return (
    <div className="space-y-4">
      <Panel
        title="Shipments"
        meta={query.data ? <Chip tone="neutral">{fmt.int(query.data.meta.total)}</Chip> : null}
        loading={query.isFetching}
        actions={
          <div className="flex items-center gap-2">
            <input
              className="field !py-1 !text-[0.6875rem]"
              style={{ width: 190 }}
              placeholder="tracking, origin, destination"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
            <select
              className="field !py-1 !text-[0.6875rem]"
              style={{ width: 120 }}
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="">all statuses</option>
              {STATUSES.map((option) => (
                <option key={option} value={option}>
                  {option.toLowerCase()}
                </option>
              ))}
            </select>
            <label className="flex cursor-pointer items-center gap-1.5 text-[0.625rem] uppercase tracking-[0.1em]">
              <input
                type="checkbox"
                checked={activeOnly}
                disabled={Boolean(status)}
                onChange={(event) => {
                  setActiveOnly(event.target.checked);
                  setPage(1);
                }}
                className="accent-[var(--color-signal)]"
              />
              open only
            </label>
          </div>
        }
      >
        {query.isError ? (
          <ErrorNote error={query.error} />
        ) : query.isLoading ? (
          <Loading />
        ) : query.data && query.data.data.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Tracking</th>
                  <th>Status</th>
                  <th>Route</th>
                  <th>Carrier</th>
                  <th>Vehicle</th>
                  <th className="text-right">Progress</th>
                  <th className="text-right">Promised</th>
                  <th className="text-right">ETA</th>
                  <th className="text-right">Delay risk</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {query.data.data.map((shipment) => {
                  const progress =
                    shipment.plannedDistanceKm > 0
                      ? Math.min(1, shipment.travelledDistanceKm / shipment.plannedDistanceKm)
                      : 0;

                  return (
                    <tr key={shipment.id}>
                      <td>
                        <Link
                          href={`/shipments/${shipment.id}`}
                          className="font-mono text-[0.75rem] text-[var(--color-ink)] hover:text-[var(--color-signal)]"
                        >
                          {shipment.trackingNumber}
                        </Link>
                      </td>
                      <td>
                        <span className="flex items-center gap-1.5">
                          <Chip tone={statusTone(shipment.status)}>{shipment.status}</Chip>
                          {shipment.hasOpenAnomaly && <Chip tone="alert">anomaly</Chip>}
                        </span>
                      </td>
                      <td className="whitespace-nowrap text-[var(--color-ink-dim)]">
                        {shipment.originName}
                        <span className="mx-1.5 text-[var(--color-ink-faint)]">→</span>
                        {shipment.destinationName}
                      </td>
                      <td className="text-[var(--color-ink-dim)]">{shipment.carrier?.name ?? '—'}</td>
                      <td className="font-mono text-[0.6875rem] text-[var(--color-ink-dim)]">
                        {shipment.vehicle?.plateNumber ?? '—'}
                      </td>
                      <td className="w-24">
                        <div className="flex items-center justify-end gap-2">
                          <span className="tnum font-mono text-[0.6875rem] text-[var(--color-ink-faint)]">
                            {fmt.pct(progress)}
                          </span>
                          <div className="w-12">
                            <Meter
                              value={progress}
                              tone={shipment.status === 'DELAYED' ? 'alert' : 'signal'}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="tnum whitespace-nowrap text-right font-mono text-[0.6875rem] text-[var(--color-ink-dim)]">
                        {fmt.dateTime(shipment.plannedArrivalAt)}
                      </td>
                      <td
                        className={`tnum whitespace-nowrap text-right font-mono text-[0.6875rem] ${
                          shipment.isLate ? 'text-[var(--color-alert)]' : 'text-[var(--color-ink-dim)]'
                        }`}
                      >
                        {shipment.estimatedArrivalAt ? fmt.relative(shipment.estimatedArrivalAt) : '—'}
                      </td>
                      <td className="text-right">
                        {shipment.delayProbability === null ? (
                          <span className="font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
                            not computed
                          </span>
                        ) : (
                          <Chip tone={riskTone(shipment.delayRisk)}>
                            {fmt.pct(shipment.delayProbability)}
                          </Chip>
                        )}
                      </td>
                      <td className="text-right">{shipment.isDemoData && <Chip tone="neutral">demo</Chip>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="No shipment matches"
            hint="Clear the filters, or plan a shipment to see it here."
          />
        )}

        {query.data && query.data.meta.totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-[var(--color-hairline)] px-3 py-2">
            <span className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
              page {query.data.meta.page} / {query.data.meta.totalPages}
            </span>
            <div className="flex gap-2">
              <button
                className="btn"
                disabled={page <= 1}
                onClick={() => setPage((current) => current - 1)}
              >
                prev
              </button>
              <button
                className="btn"
                disabled={!query.data.meta.hasNextPage}
                onClick={() => setPage((current) => current + 1)}
              >
                next
              </button>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
