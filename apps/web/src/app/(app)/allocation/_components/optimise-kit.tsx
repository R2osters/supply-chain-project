'use client';

import { ChevronRight, FlaskConical, ShieldCheck, Split } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Skeleton } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

/*
 * Small pieces shared by the five OPTIMISE screens (advice, forecasting, allocation, scenarios,
 * routing). They live here rather than in components/ui.tsx because they encode OPTIMISE rules —
 * "every AI output can say why", "nothing leaves without a human" — not general vocabulary.
 */

/** The charte presents Allocation and Scenarios as one screen; each keeps its own route. */
export const OPTIMISE_TABS = [
  { href: '/allocation', labelKey: 'nav.allocation' as const, icon: Split },
  { href: '/scenarios', labelKey: 'nav.scenarios' as const, icon: FlaskConical },
];

/** Form label in the charte's mono-uppercase style, above a `.field`. */
export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="t-label mb-1.5 flex items-baseline justify-between gap-2">
      {children}
    </label>
  );
}

/**
 * « Pourquoi cette recommandation ? » — the expandable reasoning every AI output carries. Controlled
 * so a page can bind it to the W shortcut.
 */
export function WhyToggle({
  open,
  onToggle,
  label,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  label: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-fit items-center gap-1 rounded-[var(--radius-xs)] text-[12.5px] font-medium text-[var(--color-muted)] transition-colors duration-100 hover:text-[var(--color-ink)]"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
        />
        {label}
      </button>
      {open && (
        <div id={id} className="fade-in border-l border-[var(--color-line)] pl-3">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * "calculé en N ms" — provenance for a computed result. `solver` is the time the optimiser itself
 * reports; `roundtrip` is measured by the browser and says so, so the two are never confused.
 */
export function Timing({ ms, kind }: { ms: number; kind: 'solver' | 'roundtrip' }) {
  const { t } = useI18n();
  return (
    <span className="t-data whitespace-nowrap text-[11px] text-[var(--color-dim)]">
      {kind === 'solver'
        ? t('rec.v3.computedIn', { ms: Math.round(ms) })
        : t('rec.v3.answeredIn', { ms: Math.round(ms) })}
    </span>
  );
}

/** Charte rule 3, stated where the decision is taken. */
export function HumanConsent() {
  const { t } = useI18n();
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-[var(--color-dim)]">
      <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
      {t('rec.v3.humanConsent')}
    </span>
  );
}

/** Placeholder for a result that is being computed: the layout holds its shape. */
export function ResultSkeleton({ chart = false, rows = 4 }: { chart?: boolean; rows?: number }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 px-5 py-5" role="status" aria-label={t('common.loading')}>
      <Skeleton className="h-4 w-1/3" />
      {chart && <Skeleton className="h-[220px] w-full" />}
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton
          key={index}
          className="h-3.5"
          style={{ width: `${92 - ((index * 17) % 40)}%`, animationDelay: `${index * 90}ms` }}
        />
      ))}
    </div>
  );
}

/** Wraps an API call and records how long the browser waited for it. */
export async function timed<T extends object>(call: () => Promise<T>): Promise<T & { elapsedMs: number }> {
  const start = performance.now();
  const result = await call();
  return { ...result, elapsedMs: performance.now() - start };
}

/** Ignore single-key shortcuts while the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}
