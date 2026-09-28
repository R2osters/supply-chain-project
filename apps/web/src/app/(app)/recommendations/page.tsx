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
import { useI18n, type TranslationKey } from '@/lib/i18n';

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

/**
 * Which recommendation types actually *do* something when accepted, and which only record a
 * decision. The distinction matters enough to state on the button: accepting an ORDER_NOW writes a
 * real purchase order, while accepting a CHANGE_SUPPLIER writes nothing but the decision itself.
 * Types not listed here fall back to the neutral wording.
 */
const BLURB_TYPES = new Set([
  'ORDER_NOW',
  'SPLIT_ORDER',
  'INCREASE_SAFETY_STOCK',
  'REDUCE_INVENTORY',
  'CHANGE_SUPPLIER',
  'ADD_SUPPLIER',
  'EXPEDITE_SHIPMENT',
]);

export default function RecommendationsPage() {
  const client = useQueryClient();
  const { can } = useAuth();
  const { t } = useI18n();
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
          <h1 className="text-lg font-semibold">{t('rec.title')}</h1>
          <p className="mt-0.5 max-w-2xl text-[0.8125rem] leading-relaxed text-[var(--color-ink-dim)]">
            {t('rec.intro')}
          </p>
        </div>

        {can('recommendation:create') && (
          <button
            className="btn btn-primary"
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
          >
            {generate.isPending ? t('rec.analysing') : t('rec.regenerate')}
          </button>
        )}
      </div>

      {generate.isError && <ErrorNote error={generate.error} />}

      {generate.data && (
        <div className="border border-[var(--color-hairline)] bg-[var(--color-panel)] px-3 py-2 text-[0.8125rem] text-[var(--color-ink-dim)]">
          {t('rec.generated', {
            total: generate.data.recommendations.length,
            added: generate.data.newRecommendations,
          })}
        </div>
      )}

      {result && (
        <div className="panel panel-ticked border-[var(--color-ok-dim)] p-3.5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-[var(--color-ok)]">
                {t('rec.executed')}
              </div>
              <p className="mt-1 text-[0.8125rem]">{result.message}</p>
              {result.executed?.type === 'PURCHASE_ORDER' && (
                <Link
                  href="/purchase-orders"
                  className="mt-1.5 inline-block font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-[var(--color-signal)] hover:underline"
                >
                  {t('rec.openPurchaseOrders')}
                </Link>
              )}
            </div>
            <button
              onClick={() => setResult(null)}
              className="font-mono text-[0.625rem] uppercase text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
            >
              {t('rec.dismiss')}
            </button>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------- stats */}
      {stats.data && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label={t('rec.open')} value={fmt.int(stats.data.open)} tone="signal" />
          <StatTile label={t('rec.decided')} value={fmt.int(stats.data.decided)} />
          <StatTile
            label={t('rec.actedOn')}
            value={stats.data.acceptanceRate === null ? '—' : fmt.pct(stats.data.acceptanceRate)}
            tone={stats.data.acceptanceRate && stats.data.acceptanceRate > 0.5 ? 'ok' : 'neutral'}
          />
          <StatTile
            label={t('rec.executed')}
            value={fmt.int(stats.data.byStatus.EXECUTED ?? 0)}
            tone="ok"
          />
        </div>
      )}

      {/* ------------------------------------------------------------ list */}
      <Panel
        title={t('rec.list')}
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
                          {t('rec.expires', { when: fmt.relative(recommendation.expiresAt) })}
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
                          <div className="panel-header !border-b">{t('rec.proposedSplit')}</div>
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
                            placeholder={t('rec.notePlaceholder')}
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
                              {accept.isPending ? t('rec.executing') : t('rec.accept')}
                            </button>
                            <button
                              className="btn btn-danger"
                              onClick={() => reject.mutate(recommendation.id)}
                              disabled={reject.isPending}
                            >
                              {t('rec.dismiss')}
                            </button>
                          </div>
                          <p className="text-[0.625rem] leading-relaxed text-[var(--color-ink-faint)]">
                            {BLURB_TYPES.has(recommendation.type)
                              ? t(`rec.blurb.${recommendation.type}` as TranslationKey)
                              : t('rec.recordsDecision')}
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
            title={
              status === 'OPEN'
                ? t('rec.nothingNeeded')
                : t('rec.noneOfStatus', { status: status.toLowerCase() })
            }
            hint={status === 'OPEN' ? t('rec.nothingNeededHint') : undefined}
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
