'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api, type Paginated, type Recommendation } from '@/lib/api';
import {
  Chip,
  Empty,
  ErrorNote,
  Explain,
  Loading,
  Panel,
  fmt,
  priorityTone,
  statusTone,
} from '@/components/ui';
import { useAuth } from '@/lib/auth';

interface Stats {
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  open: number;
  acceptanceRate: number | null;
  decided: number;
}

interface AcceptResult {
  message: string;
  executed: { type: string; id: string; description: string } | null;
  recommendation: Recommendation;
}

const TYPE_BLURB: Record<string, string> = {
  ORDER_NOW: 'Raises a draft purchase order you can review and confirm.',
  SPLIT_ORDER: 'Raises one draft purchase order per supplier in the split.',
  INCREASE_SAFETY_STOCK: 'Writes the new safety stock and reorder point.',
  REDUCE_INVENTORY: 'Caps the maximum stock level so overstock raises an alert.',
  CHANGE_SUPPLIER: 'Commercial decision — recorded, not automated.',
  ADD_SUPPLIER: 'Sourcing decision — recorded, not automated.',
  EXPEDITE_SHIPMENT: 'Operational decision — recorded, not automated.',
};

export default function RecommendationsPage() {
  const client = useQueryClient();
  const { can } = useAuth();
  const [status, setStatus] = useState('OPEN');
  const [note, setNote] = useState<Record<string, string>>({});
  const [result, setResult] = useState<AcceptResult | null>(null);

  const list = useQuery({
    queryKey: ['recommendations', status],
    queryFn: () => api<Paginated<Recommendation>>(`/recommendations?status=${status}&limit=50`),
  });

  const stats = useQuery({
    queryKey: ['recommendations', 'stats'],
    queryFn: () => api<Stats>('/recommendations/stats'),
  });

  const generate = useMutation({
    mutationFn: () =>
      api<{ recommendations: unknown[]; newRecommendations: number }>(
        '/ai/recommendations/generate',
        { method: 'POST' },
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ['recommendations'] }),
  });

  const accept = useMutation({
    mutationFn: (id: string) =>
      api<AcceptResult>(`/recommendations/${id}/accept`, {
        method: 'POST',
        body: { note: note[id] || undefined },
      }),
    onSuccess: (data) => {
      setResult(data);
      void client.invalidateQueries({ queryKey: ['recommendations'] });
      void client.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
  });

  const reject = useMutation({
    mutationFn: (id: string) =>
      api(`/recommendations/${id}/reject`, {
        method: 'POST',
        body: { note: note[id] || undefined },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['recommendations'] }),
  });

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------ head */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">What to do next</h1>
          <p className="mt-0.5 max-w-2xl text-[0.8125rem] leading-relaxed text-[var(--color-ink-dim)]">
            Every recommendation carries the reasoning that produced it and the assumptions behind
            it. Accepting one performs the action — it does not just tick a box.
          </p>
        </div>

        {can('recommendation:create') && (
          <button
            className="btn btn-primary"
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
          >
            {generate.isPending ? 'analysing…' : 'regenerate advice'}
          </button>
        )}
      </div>

      {generate.isError && <ErrorNote error={generate.error} />}

      {generate.data && (
        <div className="border border-[var(--color-hairline)] bg-[var(--color-panel)] px-3 py-2 text-[0.8125rem] text-[var(--color-ink-dim)]">
          Analysis complete — {generate.data.recommendations.length} recommendation(s),{' '}
          {generate.data.newRecommendations} new. Existing open advice for the same subject was
          superseded rather than duplicated.
        </div>
      )}

      {result && (
        <div className="panel panel-ticked border-[var(--color-ok-dim)] p-3.5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-[var(--color-ok)]">
                Executed
              </div>
              <p className="mt-1 text-[0.8125rem]">{result.message}</p>
              {result.executed?.type === 'PURCHASE_ORDER' && (
                <Link
                  href="/purchase-orders"
                  className="mt-1.5 inline-block font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-[var(--color-signal)] hover:underline"
                >
                  open purchase orders →
                </Link>
              )}
            </div>
            <button
              onClick={() => setResult(null)}
              className="font-mono text-[0.625rem] uppercase text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
            >
              dismiss
            </button>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------- stats */}
      {stats.data && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="Open" value={fmt.int(stats.data.open)} tone="signal" />
          <StatTile label="Decided" value={fmt.int(stats.data.decided)} />
          <StatTile
            label="Acted on"
            value={stats.data.acceptanceRate === null ? '—' : fmt.pct(stats.data.acceptanceRate)}
            tone={stats.data.acceptanceRate && stats.data.acceptanceRate > 0.5 ? 'ok' : 'neutral'}
          />
          <StatTile
            label="Executed"
            value={fmt.int(stats.data.byStatus.EXECUTED ?? 0)}
            tone="ok"
          />
        </div>
      )}

      {/* ------------------------------------------------------------ list */}
      <Panel
        title="Recommendations"
        actions={
          <select
            className="field !py-1 !text-[0.6875rem]"
            style={{ width: 130 }}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            {['OPEN', 'ACCEPTED', 'EXECUTED', 'REJECTED', 'EXPIRED'].map((option) => (
              <option key={option} value={option}>
                {option.toLowerCase()}
              </option>
            ))}
          </select>
        }
        loading={list.isFetching}
      >
        {list.isError ? (
          <ErrorNote error={list.error} />
        ) : list.isLoading ? (
          <Loading />
        ) : list.data && list.data.data.length > 0 ? (
          <ul className="divide-y divide-[var(--color-hairline)]">
            {list.data.data.map((recommendation) => {
              const payload = recommendation.payload as Record<string, any>;
              const lines = Array.isArray(payload.lines) ? payload.lines : null;

              return (
                <li key={recommendation.id} id={recommendation.id} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Chip tone={priorityTone(recommendation.priority)}>
                          {recommendation.priority}
                        </Chip>
                        <span className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
                          {recommendation.type.replace(/_/g, ' ')}
                        </span>
                        {recommendation.status !== 'OPEN' && (
                          <Chip tone={statusTone(recommendation.status)}>
                            {recommendation.status}
                          </Chip>
                        )}
                      </div>
                      <h3 className="mt-1.5 text-[0.9375rem] font-medium leading-snug">
                        {recommendation.title}
                      </h3>
                    </div>

                    <div className="text-right">
                      {recommendation.estimatedCostDelta !== null && (
                        <div className="tnum font-mono text-[0.8125rem]">
                          <span
                            style={{
                              color:
                                recommendation.estimatedCostDelta >= 0
                                  ? 'var(--color-ink-dim)'
                                  : 'var(--color-ok)',
                            }}
                          >
                            {recommendation.estimatedCostDelta >= 0 ? '−' : '+'}
                            {fmt.money(Math.abs(recommendation.estimatedCostDelta))}
                          </span>
                        </div>
                      )}
                      {recommendation.expiresAt && recommendation.status === 'OPEN' && (
                        <div className="font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
                          expires {fmt.relative(recommendation.expiresAt)}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 grid gap-4 lg:grid-cols-[1.5fr_1fr]">
                    <Explain
                      summary={recommendation.explanation?.summary}
                      reasons={recommendation.explanation?.reasons ?? []}
                      assumptions={recommendation.explanation?.assumptions}
                    />

                    <div className="space-y-3">
                      {lines && (
                        <div className="border border-[var(--color-hairline)]">
                          <div className="panel-header !border-b">Proposed split</div>
                          <table className="grid-table">
                            <tbody>
                              {lines.map((line: any) => (
                                <tr key={line.supplierId}>
                                  <td className="text-[0.75rem]">{line.supplierName}</td>
                                  <td className="tnum text-right font-mono text-[0.75rem]">
                                    {fmt.int(line.quantity)}
                                  </td>
                                  <td className="tnum text-right font-mono text-[0.6875rem] text-[var(--color-ink-faint)]">
                                    {fmt.money(line.estimatedCost)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {recommendation.status === 'OPEN' && can('recommendation:approve') && (
                        <div className="space-y-2">
                          <input
                            className="field"
                            placeholder="note (optional)"
                            value={note[recommendation.id] ?? ''}
                            onChange={(event) =>
                              setNote((current) => ({
                                ...current,
                                [recommendation.id]: event.target.value,
                              }))
                            }
                          />
                          <div className="flex gap-2">
                            <button
                              className="btn btn-primary flex-1"
                              onClick={() => accept.mutate(recommendation.id)}
                              disabled={accept.isPending}
                            >
                              {accept.isPending ? 'executing…' : 'accept & execute'}
                            </button>
                            <button
                              className="btn btn-danger"
                              onClick={() => reject.mutate(recommendation.id)}
                              disabled={reject.isPending}
                            >
                              dismiss
                            </button>
                          </div>
                          <p className="text-[0.625rem] leading-relaxed text-[var(--color-ink-faint)]">
                            {TYPE_BLURB[recommendation.type] ?? 'Records the decision.'}
                          </p>
                        </div>
                      )}

                      {recommendation.decidedAt && (
                        <div className="border-t border-[var(--color-hairline)] pt-2 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
                          {recommendation.status.toLowerCase()} {fmt.relative(recommendation.decidedAt)}
                          {recommendation.decisionNote && (
                            <span className="block normal-case tracking-normal text-[var(--color-ink-dim)]">
                              “{recommendation.decisionNote}”
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty
            title={status === 'OPEN' ? 'Nothing needs attention' : `No ${status.toLowerCase()} advice`}
            hint={
              status === 'OPEN'
                ? 'Either the supply chain is healthy, or there is not enough history yet. Regenerate to check.'
                : undefined
            }
          />
        )}
      </Panel>

      {accept.isError && <ErrorNote error={accept.error} />}
    </div>
  );
}

function StatTile({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'signal' | 'neutral';
}) {
  const colour = { ok: 'var(--color-ok)', signal: 'var(--color-signal)', neutral: 'var(--color-ink)' }[
    tone
  ];
  return (
    <div className="panel px-3.5 py-2.5">
      <div className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
        {label}
      </div>
      <div className="tnum mt-1 font-mono text-xl" style={{ color: colour }}>
        {value}
      </div>
    </div>
  );
}
