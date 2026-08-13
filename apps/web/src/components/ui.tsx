'use client';

import type { ReactNode } from 'react';

/* ============================================================================
   The instrument vocabulary. Every screen is assembled from these.
   ========================================================================== */

export function Panel({
  title,
  meta,
  actions,
  children,
  className = '',
  ticked = true,
  loading = false,
}: {
  title?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  ticked?: boolean;
  loading?: boolean;
}) {
  return (
    <section
      className={`panel ${ticked ? 'panel-ticked' : ''} ${loading ? 'loading-sweep' : ''} ${className}`}
    >
      {(title || actions) && (
        <header className="panel-header">
          <span className="flex items-center gap-2">
            {title}
            {meta}
          </span>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

type Tone = 'ok' | 'warn' | 'alert' | 'info' | 'signal' | 'neutral';

export function Chip({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

/** Domain status → signal colour. One place, so the mapping never drifts between screens. */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'DELIVERED':
    case 'ARRIVED':
    case 'RESOLVED':
    case 'CLOSED':
    case 'EXECUTED':
    case 'ACCEPTED':
    case 'CONFIRMED':
      return 'ok';
    case 'DELAYED':
    case 'INVESTIGATING':
    case 'PENDING':
    case 'PROCESSING':
      return 'warn';
    case 'CANCELLED':
    case 'FAILED':
    case 'OPEN':
    case 'REJECTED':
      return 'alert';
    case 'IN_TRANSIT':
    case 'DEPARTED':
    case 'LOADING':
    case 'SHIPPED':
      return 'info';
    case 'PLANNED':
    case 'DRAFT':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function priorityTone(priority: string): Tone {
  switch (priority) {
    case 'CRITICAL':
      return 'alert';
    case 'HIGH':
      return 'warn';
    case 'MEDIUM':
      return 'signal';
    default:
      return 'neutral';
  }
}

export function riskTone(level: string | null | undefined): Tone {
  switch (level) {
    case 'HIGH':
      return 'alert';
    case 'MEDIUM':
      return 'warn';
    case 'LOW':
      return 'ok';
    default:
      return 'neutral';
  }
}

/* ------------------------------------------------------------------ metrics */

export function Kpi({
  label,
  value,
  unit,
  sub,
  tone = 'neutral',
  delay = 0,
}: {
  label: string;
  value: string | number;
  unit?: string;
  sub?: ReactNode;
  tone?: Tone;
  delay?: number;
}) {
  const colour = {
    ok: 'var(--color-ok)',
    warn: 'var(--color-warn)',
    alert: 'var(--color-alert)',
    info: 'var(--color-info)',
    signal: 'var(--color-signal)',
    neutral: 'var(--color-ink)',
  }[tone];

  return (
    <div className="panel panel-ticked rise px-3.5 py-3" style={{ animationDelay: `${delay}ms` }}>
      <div className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className="tnum font-mono text-2xl leading-none" style={{ color: colour }}>
          {value}
        </span>
        {unit && (
          <span className="font-mono text-[0.625rem] uppercase tracking-wider text-[var(--color-ink-faint)]">
            {unit}
          </span>
        )}
      </div>
      {sub && <div className="mt-1.5 text-[0.6875rem] text-[var(--color-ink-dim)]">{sub}</div>}
    </div>
  );
}

/** A horizontal proportion bar. Reads faster than a percentage in a dense table. */
export function Meter({ value, tone = 'signal' }: { value: number; tone?: Tone }) {
  const colour = {
    ok: 'var(--color-ok)',
    warn: 'var(--color-warn)',
    alert: 'var(--color-alert)',
    info: 'var(--color-info)',
    signal: 'var(--color-signal)',
    neutral: 'var(--color-ink-faint)',
  }[tone];

  return (
    <div className="h-1 w-full bg-[var(--color-hairline)]">
      <div
        className="h-full transition-[width] duration-500"
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%`, background: colour }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------- states */

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-14 text-center">
      <div className="font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
        {title}
      </div>
      {hint && <p className="max-w-md text-[0.8125rem] text-[var(--color-ink-dim)]">{hint}</p>}
    </div>
  );
}

export function Loading({ label = 'Reading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-6 py-14">
      <span className="live-dot" />
      <span className="font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
        {label}…
      </span>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="m-3 border border-[var(--color-alert-dim)] bg-[color-mix(in_srgb,var(--color-alert)_7%,transparent)] px-3 py-2.5">
      <div className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-[var(--color-alert)]">
        Fault
      </div>
      <p className="mt-1 text-[0.8125rem] text-[var(--color-ink-dim)]">{message}</p>
    </div>
  );
}

/** Marks synthetic rows. Nothing generated is ever shown as if it were real. */
export function DemoTag() {
  return (
    <span
      className="chip chip-neutral"
      title="Synthetic data generated by the seed or the telemetry simulator"
    >
      demo
    </span>
  );
}

/* ------------------------------------------------------- explanation block */

/**
 * Renders the `explanation` every AI response carries. Given its own component because the
 * rule that no recommendation appears without its reasoning is a product rule, not a
 * per-screen choice — making it a component is what stops a screen quietly dropping it.
 */
export function Explain({
  summary,
  reasons,
  assumptions,
  defaultOpen = false,
}: {
  summary?: string;
  reasons: string[];
  assumptions?: string[];
  defaultOpen?: boolean;
}) {
  return (
    <div className="space-y-2">
      {summary && <p className="text-[0.8125rem] leading-relaxed text-[var(--color-ink)]">{summary}</p>}

      {reasons.length > 0 && (
        <ul className="space-y-1">
          {reasons.map((reason, index) => (
            <li
              key={index}
              className="flex gap-2 text-[0.75rem] leading-relaxed text-[var(--color-ink-dim)]"
            >
              <span className="mt-[0.45rem] h-px w-2.5 shrink-0 bg-[var(--color-signal)]" />
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      )}

      {assumptions && assumptions.length > 0 && (
        <details className="group" open={defaultOpen}>
          <summary className="cursor-pointer list-none font-mono text-[0.625rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)] hover:text-[var(--color-signal)]">
            {assumptions.length} assumption{assumptions.length === 1 ? '' : 's'}
            <span className="ml-1.5 inline-block transition-transform group-open:rotate-90">›</span>
          </summary>
          <ul className="mt-1.5 space-y-1 border-l border-[var(--color-hairline)] pl-3">
            {assumptions.map((assumption, index) => (
              <li key={index} className="text-[0.6875rem] leading-relaxed text-[var(--color-ink-faint)]">
                {assumption}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ format */

export const fmt = {
  int: (value: number | string | null | undefined): string =>
    value === null || value === undefined ? '—' : Math.round(Number(value)).toLocaleString('en-GB'),

  num: (value: number | string | null | undefined, decimals = 1): string =>
    value === null || value === undefined
      ? '—'
      : Number(value).toLocaleString('en-GB', {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }),

  money: (value: number | string | null | undefined, currency = 'GHS'): string =>
    value === null || value === undefined
      ? '—'
      : `${currency} ${Number(value).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`,

  pct: (value: number | null | undefined, decimals = 0): string =>
    value === null || value === undefined ? '—' : `${(value * 100).toFixed(decimals)}%`,

  date: (value: string | Date | null | undefined): string =>
    !value
      ? '—'
      : new Date(value).toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: '2-digit',
        }),

  time: (value: string | Date | null | undefined): string =>
    !value
      ? '—'
      : new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),

  dateTime: (value: string | Date | null | undefined): string =>
    !value ? '—' : `${fmt.date(value)} ${fmt.time(value)}`,

  /** "in 3 h 20", "40 min ago" — the form an operator reads fastest. */
  relative: (value: string | Date | null | undefined): string => {
    if (!value) return '—';
    const deltaMinutes = (new Date(value).getTime() - Date.now()) / 60_000;
    const magnitude = Math.abs(deltaMinutes);
    const suffix = deltaMinutes >= 0 ? '' : ' ago';
    const prefix = deltaMinutes >= 0 ? 'in ' : '';

    if (magnitude < 1) return 'now';
    if (magnitude < 60) return `${prefix}${Math.round(magnitude)} min${suffix}`;
    if (magnitude < 1440) {
      const hours = Math.floor(magnitude / 60);
      const minutes = Math.round(magnitude % 60);
      return `${prefix}${hours} h${minutes ? ` ${String(minutes).padStart(2, '0')}` : ''}${suffix}`;
    }
    return `${prefix}${Math.round(magnitude / 1440)} d${suffix}`;
  },
};
