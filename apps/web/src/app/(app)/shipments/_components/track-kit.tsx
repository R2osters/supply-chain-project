'use client';

import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';

/* ============================================================================
   The TRACK list screens (Shipments, Incidents, Deliveries, Alerts) share one
   layout in the charte: filter pills over a list, a detail panel on the right.
   These pieces live here rather than in components/ui.tsx because only those
   four screens use them.
   ========================================================================== */

/** Filter pill with a neutral counter (charte §07). `demo` draws the dashed violet variant. */
export function FilterPill({
  active,
  count,
  demo = false,
  onClick,
  children,
  icon,
}: {
  active: boolean;
  count?: number | null;
  demo?: boolean;
  onClick: () => void;
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`pill ${demo && !active ? 'pill-demo' : ''}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {icon}
      {children}
      {count !== undefined && count !== null && <span key={count} className="pill-count pop">{count}</span>}
    </button>
  );
}

/** List + detail. Below 1024 px the detail drops under the list (charte §10, tablet). */
export function ListDetailLayout({ list, detail }: { list: ReactNode; detail: ReactNode }) {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
      <div className="min-w-0">{list}</div>
      <div className="min-w-0 lg:sticky lg:top-24">{detail}</div>
    </div>
  );
}

/**
 * Charte "DetailPanel": kicker, title, status, facts 2 × 2, history, actions. Keyed by the caller
 * on the selected id so it slides in afresh each time the selection changes.
 */
export function DetailPanel({
  kicker,
  title,
  status,
  onClose,
  children,
  actions,
}: {
  kicker: ReactNode;
  title: ReactNode;
  status?: ReactNode;
  onClose?: () => void;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <aside className="panel slide-in-right flex flex-col gap-5 p-5" aria-label={typeof title === 'string' ? title : undefined}>
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="t-label">{kicker}</span>
          <h2 className="t-h3 m-0 break-words">{title}</h2>
          {status && <div className="flex flex-wrap items-center gap-2">{status}</div>}
        </div>
        {onClose && (
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label={t('common.close')}>
            <X />
          </button>
        )}
      </header>
      {children}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </aside>
  );
}

/** Placeholder for the detail column while nothing is selected — says how to pick a row. */
export function DetailHint({ children }: { children: ReactNode }) {
  return (
    <div className="panel fade-in hidden flex-col gap-2 p-5 text-[13px] text-[var(--color-muted)] lg:flex">
      {children}
      <span className="flex items-center gap-1.5 text-[12px] text-[var(--color-dim)]">
        <kbd className="kbd">J</kbd>
        <kbd className="kbd">K</kbd>
      </span>
    </div>
  );
}

/** Small section title inside a detail panel. */
export function DetailSection({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="t-label m-0">{title}</h3>
      {children}
    </section>
  );
}

/** Vertical timeline. Past steps are ink, future (estimated) ones dim with a hollow dot. */
export function History({
  items,
}: {
  items: Array<{ label: ReactNode; at: ReactNode; done: boolean; exception?: boolean }>;
}) {
  return (
    <ol className="stagger m-0 flex list-none flex-col p-0">
      {items.map((item, index) => (
        <li key={index} className="relative grid grid-cols-[14px_minmax(0,1fr)_auto] gap-3 pb-3 last:pb-0">
          {index < items.length - 1 && (
            <span className="absolute left-[6px] top-[14px] bottom-0 w-px bg-[var(--color-line)]" aria-hidden="true" />
          )}
          <span
            className="mt-[5px] h-[9px] w-[9px] rounded-full"
            aria-hidden="true"
            style={
              item.done
                ? { background: item.exception ? 'var(--color-crit)' : 'var(--color-ink)' }
                : { border: '1.5px solid var(--color-dim)' }
            }
          />
          <span className={`text-[13px] ${item.done ? 'text-[var(--color-ink)]' : 'text-[var(--color-muted)]'}`}>
            {item.label}
          </span>
          <span className="t-data whitespace-nowrap text-[12px] text-[var(--color-muted)]">{item.at}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * J / K move the selection through a list (charte §10 shortcuts), Escape clears it. Keys typed
 * into a field are left alone.
 */
export function useListKeys<T extends string>(
  ids: T[],
  selected: T | null,
  select: (id: T | null) => void,
  onEnter?: (id: T) => void,
) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable;
      if (typing || event.metaKey || event.ctrlKey || event.altKey || ids.length === 0) return;
      const key = event.key.toLowerCase();
      const index = selected ? ids.indexOf(selected) : -1;
      if (key === 'j') {
        event.preventDefault();
        select(ids[Math.min(ids.length - 1, index + 1)]);
      } else if (key === 'k') {
        event.preventDefault();
        select(ids[index <= 0 ? 0 : index - 1]);
      } else if (event.key === 'Escape' && selected) {
        select(null);
      } else if (event.key === 'Enter' && selected && onEnter && target === document.body) {
        onEnter(selected);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ids, selected, select, onEnter]);

  // Keep the selected row in view as J / K walk past the fold.
  useEffect(() => {
    if (!selected) return;
    document
      .querySelector(`[data-row-id="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);
}

/** "+1 h 20" / "−15 min": a signed duration from minutes, the same in French and English. */
export function formatGap(minutes: number, dayUnit = 'd'): string {
  const sign = minutes > 0 ? '+' : minutes < 0 ? '−' : '±';
  const magnitude = Math.round(Math.abs(minutes));
  if (magnitude < 60) return `${sign}${magnitude} min`;
  if (magnitude < 1440) {
    const hours = Math.floor(magnitude / 60);
    const rest = magnitude % 60;
    return `${sign}${hours} h${rest ? ` ${String(rest).padStart(2, '0')}` : ''}`;
  }
  const days = Math.floor(magnitude / 1440);
  const hours = Math.round((magnitude % 1440) / 60);
  return `${sign}${days} ${dayUnit}${hours ? ` ${hours} h` : ''}`;
}
