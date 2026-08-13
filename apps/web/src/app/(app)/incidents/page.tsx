'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import Link from 'next/link';
import { api, type Paginated } from '@/lib/api';
import { Chip, Empty, ErrorNote, Loading, Panel, fmt, riskTone, statusTone } from '@/components/ui';

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

export default function IncidentsPage() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

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

  const severityOrder = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

  return (
    <div className="space-y-4">
      {summary.data && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label={`Incidents · ${summary.data.windowDays} d`} value={fmt.int(summary.data.total)} />
          <Tile
            label="Still open"
            value={fmt.int(summary.data.open)}
            tone={summary.data.open > 0 ? 'warn' : 'ok'}
          />
          <Tile label="Estimated cost" value={fmt.money(summary.data.estimatedCost)} tone="signal" />
          <div className="panel px-3.5 py-2.5">
            <div className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
              By severity
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {severityOrder
                .filter((severity) => summary.data!.bySeverity[severity])
                .map((severity) => (
                  <Chip key={severity} tone={riskTone(severity === 'CRITICAL' ? 'HIGH' : severity)}>
                    {severity} {summary.data!.bySeverity[severity]}
                  </Chip>
                ))}
            </div>
          </div>
        </div>
      )}

      <Panel
        title="Incidents"
        loading={incidents.isFetching}
        actions={
          <select
            className="field !py-1 !text-[0.6875rem]"
            style={{ width: 130 }}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">all</option>
            {['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'].map((option) => (
              <option key={option} value={option}>
                {option.toLowerCase()}
              </option>
            ))}
          </select>
        }
      >
        {incidents.isError ? (
          <ErrorNote error={incidents.error} />
        ) : incidents.isLoading ? (
          <Loading />
        ) : incidents.data && incidents.data.data.length > 0 ? (
          <ul className="divide-y divide-[var(--color-hairline)]">
            {incidents.data.data.map((incident) => (
              <li key={incident.id} className="p-3.5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip tone={riskTone(incident.severity === 'CRITICAL' ? 'HIGH' : incident.severity)}>
                        {incident.severity}
                      </Chip>
                      <span className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
                        {incident.type.replace(/_/g, ' ')}
                      </span>
                      <Chip tone={statusTone(incident.status)}>{incident.status}</Chip>
                    </div>
                    <h3 className="mt-1.5 text-[0.875rem] font-medium">{incident.title}</h3>
                    <p className="mt-0.5 max-w-3xl text-[0.75rem] leading-relaxed text-[var(--color-ink-dim)]">
                      {incident.description}
                    </p>
                  </div>

                  <div className="text-right">
                    {incident.estimatedCost && (
                      <div className="tnum font-mono text-[0.8125rem]">
                        {fmt.money(incident.estimatedCost)}
                      </div>
                    )}
                    <div className="font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
                      {fmt.relative(incident.occurredAt)}
                    </div>
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap gap-3 font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
                  {incident.shipment && (
                    <Link
                      href={`/shipments/${incident.shipment.id}`}
                      className="hover:text-[var(--color-signal)]"
                    >
                      {incident.shipment.trackingNumber}
                    </Link>
                  )}
                  {incident.reportedBy && (
                    <span>
                      reported by {incident.reportedBy.firstName} {incident.reportedBy.lastName}
                    </span>
                  )}
                  {incident.assignedTo && (
                    <span>
                      assigned to {incident.assignedTo.firstName} {incident.assignedTo.lastName}
                    </span>
                  )}
                  {incident.resolvedAt && <span>resolved {fmt.relative(incident.resolvedAt)}</span>}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No incidents" hint="Nothing has gone wrong in this window." />
        )}
      </Panel>
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
  tone?: 'ok' | 'warn' | 'signal' | 'neutral';
}) {
  const colour = {
    ok: 'var(--color-ok)',
    warn: 'var(--color-warn)',
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
