'use client';

import { Check, ChevronDown, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import type { Recommendation } from '@/lib/api';
import { Button, DisabledReason, Explain, SeverityIcon, toSeverity } from '@/components/ui';
import { useFormat, useI18n, type TranslationKey } from '@/lib/i18n';

const PRIORITY_RANK: Record<Recommendation['priority'], number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

/** Most urgent first, then oldest first: the decision that has waited longest at a given priority. */
export function byUrgency(a: Recommendation, b: Recommendation): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt.localeCompare(b.createdAt);
}

/**
 * The verb on the button states what accepting actually does (charte: « Commander 18 t »), read
 * from the payload the API will execute — never a generic "Accept" when the effect is a real PO.
 */
export function acceptLabel(
  recommendation: Recommendation,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  int: (value: number) => string,
): string {
  const payload = (recommendation.payload ?? {}) as Record<string, unknown>;
  const lines = Array.isArray(payload.lines) ? payload.lines : null;
  switch (recommendation.type) {
    case 'ORDER_NOW': {
      const quantity = Number(payload.quantity ?? 0);
      if (quantity > 0) {
        return t('dash.v3.accept.ORDER_NOW', { qty: int(quantity), sku: String(payload.sku ?? '') }).trim();
      }
      return t('dash.v3.accept.default');
    }
    case 'SPLIT_ORDER':
      return t('dash.v3.accept.SPLIT_ORDER', { n: lines?.length ?? 2 });
    case 'INCREASE_SAFETY_STOCK':
      return t('dash.v3.accept.INCREASE_SAFETY_STOCK');
    case 'REDUCE_INVENTORY':
      return t('dash.v3.accept.REDUCE_INVENTORY');
    default:
      return t('dash.v3.accept.default');
  }
}

/** Confidence is only shown when the engine actually sent one — never a made-up figure. */
function confidenceOf(recommendation: Recommendation): number | null {
  const payload = (recommendation.payload ?? {}) as Record<string, unknown>;
  const raw = payload.confidence ?? payload.confidenceScore;
  const value = typeof raw === 'number' ? raw : null;
  return value !== null && Number.isFinite(value) ? value : null;
}

export function DecisionCard({
  recommendation,
  selected,
  explained,
  onSelect,
  onToggleWhy,
  onAccept,
  accepting,
  blockedReason,
}: {
  recommendation: Recommendation;
  selected: boolean;
  explained: boolean;
  onSelect: () => void;
  onToggleWhy: () => void;
  onAccept: () => void;
  accepting: boolean;
  /** Why the accept action is unavailable (read-only role, offline), or null when it is. */
  blockedReason: string | null;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const severity = toSeverity(recommendation.priority);
  const confidence = confidenceOf(recommendation);
  const delta = recommendation.estimatedCostDelta;
  const whyId = `why-${recommendation.id}`;

  return (
    <li
      id={`decision-${recommendation.id}`}
      aria-current={selected || undefined}
      onClick={onSelect}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onSelect();
        }
      }}
      className={`tile lift flex cursor-pointer flex-col gap-3 p-4 ${
        selected ? 'shadow-[inset_0_0_0_1px_var(--color-accent)]' : ''
      }`}
    >
      <div className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-3">
        <span className="mt-0.5">
          <SeverityIcon severity={severity} />
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <b className="text-[14px] font-medium leading-snug [text-wrap:pretty]">{recommendation.title}</b>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--color-muted)]">
            <span className="t-data text-[11px] text-[var(--color-dim)]">
              {recommendation.type.replace(/_/g, ' ')}
            </span>
            {recommendation.expiresAt && (
              <span>{t('dash.v3.expires', { when: fmt.relative(recommendation.expiresAt) })}</span>
            )}
            {confidence !== null && (
              <span className="t-data text-[11px] text-[var(--color-ink)]">
                {t('common.confidence')} {fmt.num(confidence, 2)}
              </span>
            )}
          </span>
        </span>
        {delta !== null && (
          <span className="flex flex-col items-end gap-0.5 text-right">
            <span className="t-data text-[13px] text-[var(--color-ink)]">
              {delta >= 0 ? '−' : '+'}
              {fmt.money(Math.abs(delta))}
            </span>
            <span className="text-[11px] text-[var(--color-dim)]">
              {delta >= 0 ? t('dash.commits') : t('dash.releases')}
            </span>
          </span>
        )}
      </div>

      {explained && (
        <div id={whyId} key={recommendation.id} className="slide-in-right border-l border-[var(--color-line)] pl-3">
          <Explain
            summary={recommendation.explanation?.summary}
            reasons={recommendation.explanation?.reasons ?? []}
            assumptions={recommendation.explanation?.assumptions}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2" onClick={(event) => event.stopPropagation()}>
        {selected && (
          <Button
            variant="primary"
            icon={Check}
            loading={accepting}
            disabled={blockedReason !== null}
            onClick={onAccept}
            aria-keyshortcuts="A"
          >
            {acceptLabel(recommendation, t, (value) => fmt.int(value))}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={ChevronDown}
          aria-expanded={explained}
          aria-controls={whyId}
          aria-keyshortcuts="W"
          onClick={() => {
            onSelect();
            onToggleWhy();
          }}
          className={explained ? '[&>svg]:rotate-180' : ''}
        >
          {explained ? t('dash.v3.hideWhy') : t('dash.v3.why')}
        </Button>
        <Link
          href={`/recommendations#${recommendation.id}`}
          className="btn btn-ghost btn-sm"
        >
          <ExternalLink />
          {t('dash.v3.openInAdvice')}
        </Link>
      </div>

      {selected && blockedReason && <DisabledReason>{blockedReason}</DisabledReason>}
    </li>
  );
}
