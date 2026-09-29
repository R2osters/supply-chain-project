'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRight,
  Check,
  Factory,
  PackageMinus,
  RefreshCw,
  Shield,
  ShoppingCart,
  Sparkles,
  Split,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, type Paginated, type Recommendation } from '@/lib/api';
import {
  Button,
  Chip,
  Empty,
  ErrorNote,
  Explain,
  Kpi,
  Loading,
  PageHeader,
  Panel,
  SeverityIcon,
  statusTone,
  toSeverity,
} from '@/components/ui';
import { useToast } from '@/components/toast';
import { useAuth } from '@/lib/auth';
import { useFormat, useI18n, type TranslationKey } from '@/lib/i18n';
import { HumanConsent, WhyToggle, isTypingTarget } from '../allocation/_components/optimise-kit';

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

const STATUSES = ['OPEN', 'ACCEPTED', 'EXECUTED', 'REJECTED', 'EXPIRED'] as const;

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

/** One icon per kind of advice, so a planner scanning the list reads the verb before the words. */
const TYPE_ICON: Record<string, LucideIcon> = {
  ORDER_NOW: ShoppingCart,
  SPLIT_ORDER: Split,
  INCREASE_SAFETY_STOCK: Shield,
  REDUCE_INVENTORY: PackageMinus,
  CHANGE_SUPPLIER: ArrowLeftRight,
  ADD_SUPPLIER: Factory,
  EXPEDITE_SHIPMENT: Zap,
};

export default function RecommendationsPage() {
  const client = useQueryClient();
  const router = useRouter();
  const { can } = useAuth();
  const { t } = useI18n();
  const format = useFormat();
  const toast = useToast();
  const [status, setStatus] = useState<string>('OPEN');
  const [note, setNote] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState(0);
  const [why, setWhy] = useState<Record<string, boolean>>({});
  const cardRefs = useRef<Array<HTMLLIElement | null>>([]);

  const list = useQuery({
    queryKey: ['recommendations', status],
    queryFn: () => api<Paginated<Recommendation>>(`/recommendations?status=${status}&limit=50`),
  });

  const stats = useQuery({
    queryKey: ['recommendations', 'stats'],
    queryFn: () => api<Stats>('/recommendations/stats'),
  });

  // The title states the situation whatever filter is showing, so the critical count is its own
  // small query rather than something derived from the visible list.
  const critical = useQuery({
    queryKey: ['recommendations', 'open-critical'],
    queryFn: () => api<Paginated<Recommendation>>('/recommendations?status=OPEN&priority=CRITICAL&limit=1'),
  });

  const generate = useMutation({
    mutationFn: () =>
      api<{ recommendations: unknown[]; newRecommendations: number }>(
        '/ai/recommendations/generate',
        { method: 'POST' },
      ),
    onSuccess: (data) => {
      toast.show({
        tone: 'info',
        message: t('rec.generated', {
          total: data.recommendations.length,
          added: data.newRecommendations,
        }),
      });
      void client.invalidateQueries({ queryKey: ['recommendations'] });
    },
  });

  const accept = useMutation({
    mutationFn: (id: string) =>
      api<AcceptResult>(`/recommendations/${id}/accept`, {
        method: 'POST',
        body: { note: note[id] || undefined },
      }),
    onSuccess: (data) => {
      // No undo: the API has no endpoint to reverse an accepted recommendation, and the order it
      // raised is a DRAFT the planner reviews on the purchase-order screen anyway.
      toast.show({
        tone: 'success',
        message: data.message,
        durationMs: 8000,
        action:
          data.executed?.type === 'PURCHASE_ORDER'
            ? { label: t('rec.v3.openPo'), onClick: () => router.push('/purchase-orders') }
            : undefined,
      });
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
    onSuccess: () => {
      toast.show({ tone: 'info', message: t('rec.v3.dismissed') });
      void client.invalidateQueries({ queryKey: ['recommendations'] });
    },
  });

  const rows = list.data?.data ?? [];
  const current = rows[Math.min(selected, rows.length - 1)];

  // Selection resets when the filter changes; the list it pointed into is gone.
  useEffect(() => setSelected(0), [status]);

  // Charte keyboard map for decision lists: J/K move, A accepts, W expands "why".
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'j' || key === 'k') {
        if (rows.length === 0) return;
        event.preventDefault();
        setSelected((index) => {
          const next = key === 'j' ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1);
          cardRefs.current[next]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          return next;
        });
      } else if (key === 'a' && current) {
        if (current.status === 'OPEN' && can('recommendation:approve') && !accept.isPending) {
          event.preventDefault();
          accept.mutate(current.id);
        }
      } else if (key === 'w' && current) {
        event.preventDefault();
        setWhy((state) => ({ ...state, [current.id]: !state[current.id] }));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, current, can, accept]);

  const openCount = stats.data?.open ?? (status === 'OPEN' ? list.data?.meta.total : undefined);
  const criticalCount = critical.data?.meta.total ?? 0;
  const title =
    openCount === undefined
      ? t('nav.recommendations')
      : openCount === 0
        ? t('rec.v3.titleNone')
        : criticalCount > 0
          ? t('rec.v3.titleCritical', { n: openCount, c: criticalCount })
          : t('rec.v3.titleOpen', { n: openCount });

  const statsSource = stats.dataUpdatedAt
    ? t('rec.v3.statsSource', { when: format.relative(new Date(stats.dataUpdatedAt)) })
    : undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={`${t('nav.pillar.optimise')} · ${t('nav.recommendations')}`}
        title={title}
        description={t('rec.intro')}
        actions={
          can('recommendation:create') && (
            <Button
              icon={RefreshCw}
              loading={generate.isPending}
              onClick={() => generate.mutate()}
            >
              {generate.isPending ? t('rec.analysing') : t('rec.regenerate')}
            </Button>
          )
        }
      />

      {generate.isError && <ErrorNote error={generate.error} onRetry={() => generate.mutate()} />}

      {/* ----------------------------------------------------------- stats */}
      {stats.isError ? (
        <ErrorNote error={stats.error} onRetry={() => void stats.refetch()} />
      ) : (
        <div className="stagger grid grid-cols-2 gap-4 md:grid-cols-4">
          <Kpi
            label={t('rec.open')}
            value={stats.data ? format.int(stats.data.open) : '—'}
            tone={criticalCount > 0 ? 'alert' : 'neutral'}
            sub={criticalCount > 0 ? t('rec.v3.criticalSub', { n: criticalCount }) : undefined}
            source={statsSource}
          />
          <Kpi
            label={t('rec.decided')}
            value={stats.data ? format.int(stats.data.decided) : '—'}
            source={statsSource}
          />
          <Kpi
            label={t('rec.actedOn')}
            value={
              stats.data?.acceptanceRate === null || stats.data === undefined
                ? '—'
                : format.pct(stats.data.acceptanceRate)
            }
            sub={t('rec.v3.actedOnSub')}
            source={statsSource}
          />
          <Kpi
            label={t('rec.executed')}
            value={stats.data ? format.int(stats.data.byStatus.EXECUTED ?? 0) : '—'}
            source={statsSource}
          />
        </div>
      )}

      {/* ------------------------------------------------------------ list */}
      <Panel
        icon={Sparkles}
        title={t('rec.list')}
        loading={list.isFetching}
        meta={
          rows.length > 1 ? (
            <span className="hidden items-center gap-1.5 text-[12px] font-normal text-[var(--color-dim)] md:flex">
              <kbd className="kbd">J</kbd>
              <kbd className="kbd">K</kbd>
              {t('rec.v3.kbdMove')}
              <kbd className="kbd">A</kbd>
              {t('rec.v3.kbdAccept')}
              <kbd className="kbd">W</kbd>
              {t('common.why')}
            </span>
          ) : undefined
        }
      >
        <div className="flex flex-wrap gap-2 px-5 pb-2 pt-3" role="group" aria-label={t('rec.v3.filter')}>
          {STATUSES.map((option) => (
            <button
              key={option}
              type="button"
              className="pill"
              aria-pressed={status === option}
              onClick={() => setStatus(option)}
            >
              {t(`rec.v3.status.${option}` as TranslationKey)}
              <span className="pill-count">{format.int(stats.data?.byStatus[option] ?? 0)}</span>
            </button>
          ))}
        </div>

        {list.isError ? (
          <ErrorNote error={list.error} onRetry={() => void list.refetch()} />
        ) : list.isLoading ? (
          <Loading rows={6} />
        ) : rows.length > 0 ? (
          <ul className="stagger m-0 flex list-none flex-col gap-3 p-4 pt-2">
            {rows.map((recommendation, index) => (
              <DecisionCard
                key={recommendation.id}
                cardRef={(node) => {
                  cardRefs.current[index] = node;
                }}
                recommendation={recommendation}
                selected={index === selected}
                onSelect={() => setSelected(index)}
                whyOpen={!!why[recommendation.id]}
                onToggleWhy={() =>
                  setWhy((state) => ({ ...state, [recommendation.id]: !state[recommendation.id] }))
                }
                note={note[recommendation.id] ?? ''}
                onNote={(value) => setNote((state) => ({ ...state, [recommendation.id]: value }))}
                canDecide={recommendation.status === 'OPEN' && can('recommendation:approve')}
                accepting={accept.isPending && accept.variables === recommendation.id}
                rejecting={reject.isPending && reject.variables === recommendation.id}
                onAccept={() => accept.mutate(recommendation.id)}
                onReject={() => reject.mutate(recommendation.id)}
              />
            ))}
          </ul>
        ) : (
          <Empty
            icon={Sparkles}
            title={
              status === 'OPEN'
                ? t('rec.nothingNeeded')
                : t('rec.noneOfStatus', { status: t(`rec.v3.status.${status}` as TranslationKey) })
            }
            hint={status === 'OPEN' ? t('rec.nothingNeededHint') : undefined}
            action={
              status === 'OPEN' && can('recommendation:create') ? (
                <Button icon={RefreshCw} loading={generate.isPending} onClick={() => generate.mutate()}>
                  {t('rec.regenerate')}
                </Button>
              ) : undefined
            }
          />
        )}
      </Panel>

      {accept.isError && <ErrorNote error={accept.error} />}
      {reject.isError && <ErrorNote error={reject.error} />}
    </div>
  );
}

/* ------------------------------------------------------------ decision card */

interface SplitLine {
  supplierId: string;
  supplierName: string;
  quantity: number;
  estimatedCost: number;
}

function DecisionCard({
  cardRef,
  recommendation,
  selected,
  onSelect,
  whyOpen,
  onToggleWhy,
  note,
  onNote,
  canDecide,
  accepting,
  rejecting,
  onAccept,
  onReject,
}: {
  cardRef: (node: HTMLLIElement | null) => void;
  recommendation: Recommendation;
  selected: boolean;
  onSelect: () => void;
  whyOpen: boolean;
  onToggleWhy: () => void;
  note: string;
  onNote: (value: string) => void;
  canDecide: boolean;
  accepting: boolean;
  rejecting: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const { t } = useI18n();
  const format = useFormat();
  const payload = recommendation.payload as Record<string, unknown>;
  const lines = Array.isArray(payload.lines) ? (payload.lines as SplitLine[]) : null;
  const TypeIcon = TYPE_ICON[recommendation.type] ?? Sparkles;
  const typeLabel = TYPE_ICON[recommendation.type]
    ? t(`rec.v3.type.${recommendation.type}` as TranslationKey)
    : recommendation.type.replace(/_/g, ' ').toLowerCase();
  // The model does not return a confidence for every kind of advice; show it only when it does.
  const confidence = typeof payload.confidence === 'number' ? payload.confidence : null;
  const cost = recommendation.estimatedCostDelta;

  const effects: string[] = [];
  if (recommendation.estimatedRiskDelta !== null) {
    effects.push(t('rec.v3.effectRisk', { value: signedPct(recommendation.estimatedRiskDelta) }));
  }
  if (recommendation.estimatedServiceLevelDelta !== null) {
    effects.push(
      t('rec.v3.effectService', { value: signedPct(recommendation.estimatedServiceLevelDelta) }),
    );
  }

  return (
    <li
      ref={cardRef}
      id={recommendation.id}
      onClick={onSelect}
      aria-current={selected || undefined}
      className={`tile flex flex-col gap-4 p-4 transition-shadow duration-200 ${
        selected ? 'shadow-[inset_0_0_0_1px_var(--color-accent)]' : ''
      }`}
    >
      {/* Head: severity + type, title, then the three numbers a decision needs. */}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--color-muted)]">
            <SeverityIcon severity={toSeverity(recommendation.priority)} size={16} />
            <span className="t-label">{t(`rec.v3.priority.${recommendation.priority}` as TranslationKey)}</span>
            <span aria-hidden="true">·</span>
            <TypeIcon className="h-3.5 w-3.5" />
            {typeLabel}
            {recommendation.status !== 'OPEN' && (
              <Chip tone={statusTone(recommendation.status)}>
                {t(`rec.v3.status.${recommendation.status}` as TranslationKey)}
              </Chip>
            )}
          </span>
          <h3 className="t-h4 m-0 [text-wrap:pretty]">{recommendation.title}</h3>
          {recommendation.explanation?.summary && (
            <p className="m-0 text-[13.5px] leading-relaxed text-[var(--color-muted)] [text-wrap:pretty]">
              {recommendation.explanation.summary}
            </p>
          )}
        </div>

        <dl className="m-0 grid grid-cols-3 gap-x-5 gap-y-1 text-right">
          <div className="flex flex-col gap-0.5">
            <dt className="t-label">{t('rec.v3.cost')}</dt>
            <dd className="t-data m-0 text-[14px] text-[var(--color-ink)]">
              {cost === null ? '—' : `${cost >= 0 ? '−' : '+'}${format.money(Math.abs(cost))}`}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="t-label">{t('common.confidence')}</dt>
            <dd className="t-data m-0 text-[14px] text-[var(--color-ink)]">
              {confidence === null ? '—' : format.num(confidence, 2)}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="t-label">{t('rec.v3.expiry')}</dt>
            <dd className="t-data m-0 text-[13px] text-[var(--color-muted)]">
              {recommendation.expiresAt && recommendation.status === 'OPEN'
                ? format.relative(recommendation.expiresAt)
                : '—'}
            </dd>
          </div>
        </dl>
      </div>

      {effects.length > 0 && (
        <p className="t-data m-0 text-[12px] text-[var(--color-muted)]">
          {t('rec.v3.effect')} · {effects.join(' · ')}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          <WhyToggle open={whyOpen} onToggle={onToggleWhy} label={t('rec.v3.why')}>
            <Explain
              reasons={recommendation.explanation?.reasons ?? []}
              assumptions={recommendation.explanation?.assumptions}
              confidence={confidence}
            />
          </WhyToggle>

          {lines && lines.length > 0 && (
            <div className="overflow-x-auto">
              <table className="grid-table">
                <caption className="t-label pb-1.5 text-left">{t('rec.proposedSplit')}</caption>
                <thead>
                  <tr>
                    <th>{t('alloc.supplier')}</th>
                    <th className="text-right">{t('alloc.quantity')}</th>
                    <th className="text-right">{t('alloc.cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.supplierId}>
                      <td className="text-[13px]">{line.supplierName}</td>
                      <td className="t-data text-right">{format.int(line.quantity)}</td>
                      <td className="t-data text-right text-[var(--color-muted)]">
                        {format.money(line.estimatedCost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2.5">
          {canDecide && (
            <>
              <label className="sr-only" htmlFor={`note-${recommendation.id}`}>
                {t('rec.notePlaceholder')}
              </label>
              <input
                id={`note-${recommendation.id}`}
                className="field"
                placeholder={t('rec.notePlaceholder')}
                value={note}
                onChange={(event) => onNote(event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  icon={Check}
                  loading={accepting}
                  className="flex-1"
                  onClick={(event) => {
                    event.stopPropagation();
                    onAccept();
                  }}
                >
                  {accepting ? t('rec.executing') : t('rec.accept')}
                </Button>
                <Button
                  variant="destructive"
                  icon={X}
                  loading={rejecting}
                  onClick={(event) => {
                    event.stopPropagation();
                    onReject();
                  }}
                >
                  {t('rec.dismiss')}
                </Button>
              </div>
              <p className="m-0 text-[12px] leading-relaxed text-[var(--color-muted)]">
                {BLURB_TYPES.has(recommendation.type)
                  ? t(`rec.blurb.${recommendation.type}` as TranslationKey)
                  : t('rec.recordsDecision')}
              </p>
              <HumanConsent />
            </>
          )}

          {recommendation.decidedAt && (
            <div className="flex flex-col gap-1 border-t border-[var(--color-line)] pt-2">
              <span className="t-data text-[11px] text-[var(--color-dim)]">
                {t(`rec.v3.status.${recommendation.status}` as TranslationKey)} ·{' '}
                {format.relative(recommendation.decidedAt)}
              </span>
              {recommendation.decisionNote && (
                <span className="text-[13px] text-[var(--color-muted)]">“{recommendation.decisionNote}”</span>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function signedPct(value: number): string {
  const points = value * 100;
  return `${points > 0 ? '+' : points < 0 ? '−' : ''}${Math.abs(points).toFixed(1)} %`;
}
