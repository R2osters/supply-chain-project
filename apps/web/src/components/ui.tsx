'use client';

import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CloudOff,
  Info,
  Loader2,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';

/* ============================================================================
   SCIP charte v1.0 — the component vocabulary. Every screen is assembled from
   these; a page that redefines its own tile or chip is a bug.
   ========================================================================== */

export type Tone = 'ok' | 'warn' | 'alert' | 'info' | 'signal' | 'neutral';

const TONE_COLOUR: Record<Tone, string> = {
  ok: 'var(--color-ok)',
  warn: 'var(--color-warn)',
  alert: 'var(--color-crit)',
  info: 'var(--color-info)',
  signal: 'var(--color-ink)',
  neutral: 'var(--color-dim)',
};

/* --------------------------------------------------------------------- logo */

/** The located container (charte §02): a container in isometric view, a locator on its lid. */
export function Logo({ size = 22, dot }: { size?: number; dot?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="shrink-0">
      <path
        d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5Zm8 4.2L5.6 8.9v5.4l6.4 3.6 6.4-3.6V8.9Z M9.6 10.2a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0 -4.8 0Z"
        fill="currentColor"
        fillRule="evenodd"
      />
      <path d="M10.9 10.2a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0Z" fill={dot ?? 'currentColor'} />
    </svg>
  );
}

/* ------------------------------------------------------------------- layout */

/**
 * Page title block. The charte's three-second test: the title states the situation
 * ("3 decisions pending, 2 critical"), the kicker says where you are.
 */
export function PageHeader({
  kicker,
  title,
  description,
  actions,
  meta,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="rise flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 max-w-[880px] flex-col gap-1.5">
        {kicker && <span className="t-label">{kicker}</span>}
        <h1 className="t-h1 m-0">{title}</h1>
        {description && (
          <p className="m-0 max-w-[720px] text-[14px] text-[var(--color-muted)] [text-wrap:pretty]">
            {description}
          </p>
        )}
        {meta && <div className="mt-1 flex flex-wrap items-center gap-3">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({
  title,
  meta,
  actions,
  children,
  className = '',
  loading = false,
  icon: Icon,
  id,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Kept for source compatibility with the v2 screens; the charte has no corner ticks. */
  ticked?: boolean;
  loading?: boolean;
  icon?: LucideIcon;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={`panel rise ${loading ? 'loading-sweep' : ''} ${className}`}
      aria-busy={loading || undefined}
    >
      {(title || actions) && (
        <header className="panel-header">
          <span className="flex min-w-0 items-center gap-2">
            {Icon && <Icon className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />}
            <span className="truncate">{title}</span>
            {meta}
          </span>
          {actions && <span className="flex items-center gap-2">{actions}</span>}
        </header>
      )}
      {children}
    </section>
  );
}

/* ----------------------------------------------------------------- buttons */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  loading = false,
  children,
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  loading?: boolean;
}) {
  const variantClass = {
    primary: 'btn-primary',
    secondary: '',
    ghost: 'btn-ghost',
    destructive: 'btn-danger',
  }[variant];
  const sizeClass = size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : '';
  const iconOnly = !children;
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      aria-busy={loading || undefined}
      className={`btn ${variantClass} ${sizeClass} ${iconOnly ? 'btn-icon' : ''} ${className}`}
    >
      {loading ? <Loader2 className="spin" /> : Icon ? <Icon /> : null}
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------- chips */

export function Chip({
  tone = 'neutral',
  children,
  icon: Icon,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  icon?: LucideIcon;
  title?: string;
}) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {Icon && <Icon className="h-3 w-3" />}
      {children}
    </span>
  );
}

/** Domain status → tone. One place, so the mapping never drifts between screens. */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'DELIVERED':
    case 'ARRIVED':
    case 'RESOLVED':
    case 'CLOSED':
    case 'EXECUTED':
    case 'ACCEPTED':
    case 'CONFIRMED':
    case 'COMPLETED':
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
      return 'info';
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

/* ----------------------------------------------------------------- severity */

export type Severity = 'critical' | 'warning' | 'info' | 'ok';

/**
 * Severity is carried by the icon's *shape* first (octagon, triangle, circle), then its colour —
 * never by colour alone, and never by repeating the word "Critical" on every line.
 */
export function SeverityIcon({ severity, size = 16 }: { severity: Severity; size?: number }) {
  const common = { width: size, height: size, strokeWidth: 1.75, className: 'shrink-0' } as const;
  switch (severity) {
    case 'critical':
      return <OctagonAlert {...common} color="var(--color-crit)" aria-label="critical" />;
    case 'warning':
      return <TriangleAlert {...common} color="var(--color-warn)" aria-label="warning" />;
    case 'ok':
      return <CircleCheck {...common} color="var(--color-ok)" aria-label="ok" />;
    default:
      return <Info {...common} color="var(--color-muted)" aria-label="info" />;
  }
}

/** Maps the API's severity / priority / risk words onto the three shapes. */
export function toSeverity(level: string | null | undefined): Severity {
  switch (level) {
    case 'CRITICAL':
    case 'HIGH':
    case 'alert':
      return 'critical';
    case 'MEDIUM':
    case 'WARNING':
    case 'warn':
      return 'warning';
    case 'ok':
      return 'ok';
    default:
      return 'info';
  }
}

/* --------------------------------------------------------------- provenance */

export type ProvenanceKind = 'live' | 'poll' | 'stale' | 'demo' | 'offline';

/**
 * The only component allowed to carry the violet. Live = filled dot + word; polling = hollow
 * dot + interval; stale = amber ring + age; demo = dashed violet + word.
 */
export function Provenance({
  kind,
  label,
  seconds,
  title,
}: {
  kind: ProvenanceKind;
  label?: ReactNode;
  seconds?: number;
  title?: string;
}) {
  const { t } = useI18n();
  const text =
    label ??
    {
      live: t('prov.live'),
      poll: t('prov.poll', { s: seconds ?? 60 }),
      stale: t('prov.stale'),
      demo: t('prov.demo'),
      offline: t('prov.offline'),
    }[kind];
  const cls = kind === 'offline' ? 'prov-off' : `prov-${kind}`;
  return (
    <span className={`prov ${cls}`} title={title}>
      <span className="prov-dot" />
      {text}
    </span>
  );
}

/** Marks synthetic rows. Nothing generated is ever shown as if it were real. */
export function DemoTag({ title }: { title?: string }) {
  const { t } = useI18n();
  return (
    <span className="chip chip-demo" title={title ?? t('shell.demoSpaceHint')}>
      {t('prov.demo')}
    </span>
  );
}

/* ------------------------------------------------------------------ metrics */

/**
 * The single KPI / stat tile. Value in Condensed, delta in mono, source + freshness underneath.
 * Nominal values stay ink; only an exception earns a small severity icon.
 */
export function Kpi({
  label,
  value,
  unit,
  sub,
  tone = 'neutral',
  delay = 0,
  delta,
  deltaTone,
  source,
  icon: Icon,
  surface = 'panel',
  href,
}: {
  label: ReactNode;
  value: string | number;
  unit?: string;
  sub?: ReactNode;
  tone?: Tone;
  delay?: number;
  delta?: string;
  deltaTone?: 'ok' | 'alert' | 'neutral';
  source?: ReactNode;
  icon?: LucideIcon;
  /** `panel` on the page background, `tile` inside a panel. */
  surface?: 'panel' | 'tile';
  href?: string;
}) {
  const exception = tone === 'alert' || tone === 'warn';
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-muted)]">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        <span className="truncate">{label}</span>
        {exception && (
          <span className="ml-auto">
            <SeverityIcon severity={tone === 'alert' ? 'critical' : 'warning'} size={14} />
          </span>
        )}
      </span>
      <span className="flex items-baseline gap-2">
        <AnimatedValue value={value} className="t-kpi text-[26px] text-[var(--color-ink)]" />
        {unit && <span className="t-data text-[11px] text-[var(--color-muted)]">{unit}</span>}
        {delta && (
          <span
            className="t-data text-[11px]"
            style={{
              color:
                deltaTone === 'alert'
                  ? 'var(--color-crit)'
                  : deltaTone === 'ok'
                    ? 'var(--color-ok)'
                    : 'var(--color-muted)',
            }}
          >
            {delta}
          </span>
        )}
      </span>
      {sub && <span className="text-[12px] text-[var(--color-muted)] [text-wrap:pretty]">{sub}</span>}
      {source && <span className="t-data text-[10.5px] text-[var(--color-dim)]">{source}</span>}
    </>
  );
  const className = `${surface === 'panel' ? 'panel' : 'tile'} rise flex min-w-0 flex-col gap-1 p-4 ${href ? 'lift' : ''}`;
  if (href) {
    return (
      <a href={href} className={className} style={{ animationDelay: `${delay}ms` }}>
        {body}
      </a>
    );
  }
  return (
    <div className={className} style={{ animationDelay: `${delay}ms` }}>
      {body}
    </div>
  );
}

/** Alias: the charte names the in-panel variant a stat tile. */
export function StatTile(props: Parameters<typeof Kpi>[0]) {
  return <Kpi surface="tile" {...props} />;
}

/**
 * A value that settles in when it changes: the new figure rises into place so an operator's eye
 * catches the update without a blinking cell.
 */
export function AnimatedValue({ value, className = '' }: { value: string | number; className?: string }) {
  const [shown, setShown] = useState(value);
  const [tick, setTick] = useState(0);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      setShown(value);
      return;
    }
    if (value !== shown) {
      setShown(value);
      setTick((n) => n + 1);
    }
  }, [value, shown]);
  return (
    <span key={tick} className={`${tick > 0 ? 'rise' : ''} tnum ${className}`}>
      {shown}
    </span>
  );
}

/** A label / value line with an optional meter underneath. */
export function MetricRow({
  label,
  value,
  meter,
  tone,
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  meter?: number;
  tone?: Tone;
  hint?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-[var(--color-muted)]">{label}</span>
        <span className="t-data text-[13px] text-[var(--color-ink)]">{value}</span>
      </div>
      {meter !== undefined && <Meter value={meter} tone={tone} />}
      {hint && <span className="text-[12px] text-[var(--color-dim)]">{hint}</span>}
    </div>
  );
}

/** A horizontal proportion bar. Reads faster than a percentage in a dense table. */
export function Meter({ value, tone = 'signal' }: { value: number; tone?: Tone }) {
  const width = Math.min(100, Math.max(0, value * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-line)]">
      <div
        className="h-full origin-left rounded-full transition-[width] duration-700 ease-out [animation:grow-x_.7s_var(--ease-out)_both]"
        style={{ width: `${width}%`, background: TONE_COLOUR[tone] }}
      />
    </div>
  );
}

/** Key facts in a 2 × n grid: label above value. Used by detail panels. */
export function Facts({ items, columns = 2 }: { items: Array<[ReactNode, ReactNode]>; columns?: number }) {
  return (
    <dl
      className="m-0 grid gap-x-4 gap-y-3"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {items.map(([label, value], index) => (
        <div key={index} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-[12px] text-[var(--color-muted)]">{label}</dt>
          <dd className="m-0 truncate text-[13.5px] text-[var(--color-ink)]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Colour-key row for maps and charts. Swatch + word, never swatch alone. */
export function Legend({ items }: { items: Array<{ label: ReactNode; colour: string; shape?: 'dot' | 'line' | 'dash' }> }) {
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-x-4 gap-y-1.5 p-0 text-[12px] text-[var(--color-muted)]">
      {items.map((item, index) => (
        <li key={index} className="flex items-center gap-1.5">
          {item.shape === 'line' || item.shape === 'dash' ? (
            <span
              className="inline-block w-4"
              style={{ borderTop: `2px ${item.shape === 'dash' ? 'dashed' : 'solid'} ${item.colour}` }}
            />
          ) : (
            <span className="h-2 w-2 rounded-full" style={{ background: item.colour }} />
          )}
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------ alert rows */

/** Charte "ligne de liste · gravité": icon, title, context, source + provenance, age. */
export function AlertRow({
  severity,
  title,
  context,
  source,
  provenance,
  age,
  selected,
  onClick,
  href,
  actions,
}: {
  severity: Severity;
  title: ReactNode;
  context?: ReactNode;
  source?: ReactNode;
  provenance?: ReactNode;
  age?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  href?: string;
  actions?: ReactNode;
}) {
  const content = (
    <>
      <span className="mt-0.5">
        <SeverityIcon severity={severity} />
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <b className="font-semibold leading-snug">{title}</b>
        {context && <span className="text-[12px] text-[var(--color-muted)]">{context}</span>}
        {(source || provenance) && (
          <span className="flex flex-wrap items-center gap-2">
            {source && <span className="t-data text-[11px] text-[var(--color-dim)]">{source}</span>}
            {provenance}
          </span>
        )}
        {actions && <span className="mt-1 flex flex-wrap gap-2">{actions}</span>}
      </span>
      {age && <span className="t-data whitespace-nowrap text-[11px] text-[var(--color-dim)]">{age}</span>}
    </>
  );
  const className = `grid w-full grid-cols-[20px_minmax(0,1fr)_auto] gap-3 px-4 py-3 text-left transition-colors duration-100 ${
    selected ? 'rounded-[var(--radius-md)] bg-[var(--color-surface-2)] shadow-[inset_0_0_0_1px_var(--color-accent)]' : 'hover:bg-[var(--color-surface-2)]'
  }`;
  if (href) {
    return (
      <a href={href} className={className} aria-current={selected || undefined}>
        {content}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className} aria-pressed={selected}>
        {content}
      </button>
    );
  }
  return <div className={className}>{content}</div>;
}

/* ------------------------------------------------------------------- banner */

export function Banner({
  tone = 'info',
  icon: Icon,
  title,
  children,
  actions,
}: {
  tone?: 'info' | 'warn' | 'alert' | 'ok' | 'demo';
  icon?: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const colour = {
    info: 'var(--color-line)',
    warn: 'var(--color-warn)',
    alert: 'var(--color-crit)',
    ok: 'var(--color-ok)',
    demo: 'var(--color-sim)',
  }[tone];
  const iconColour = tone === 'info' ? 'var(--color-muted)' : colour;
  return (
    <div
      role={tone === 'alert' ? 'alert' : 'status'}
      className="rise flex items-start gap-3 rounded-[var(--radius-md)] bg-[var(--color-surface-2)] px-4 py-3"
      style={{ border: `1px ${tone === 'demo' ? 'dashed' : 'solid'} ${colour}` }}
    >
      {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: iconColour }} />}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <b className="font-medium">{title}</b>
        {children && <span className="text-[12.5px] text-[var(--color-muted)]">{children}</span>}
      </span>
      {actions && <span className="flex shrink-0 items-center gap-2">{actions}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------- states */

/** Empty ≠ error: an empty state explains and proposes what comes next. */
export function Empty({
  title,
  hint,
  icon: Icon = CircleCheck,
  action,
}: {
  title: string;
  hint?: string;
  icon?: LucideIcon;
  action?: ReactNode;
}) {
  return (
    <div className="fade-in flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <Icon className="h-5 w-5 text-[var(--color-muted)]" strokeWidth={1.75} />
      <b className="font-medium">{title}</b>
      {hint && <p className="m-0 max-w-md text-[12.5px] text-[var(--color-muted)]">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export const EmptyState = Empty;

/** Skeleton rows while data loads — the layout holds its shape instead of collapsing to text. */
export function Loading({ label, rows = 4 }: { label?: string; rows?: number }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2.5 px-5 py-5" role="status" aria-label={label ?? t('common.loading')}>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="skeleton h-3.5"
          style={{ width: `${92 - ((index * 17) % 40)}%`, animationDelay: `${index * 90}ms` }}
        />
      ))}
    </div>
  );
}

export function Skeleton({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`skeleton ${className}`} style={style} />;
}

/** Error: the problem, its consequence, and Retry. */
export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="fade-in m-4 flex items-start gap-3 rounded-[var(--radius-md)] bg-[var(--color-surface-2)] px-4 py-3">
      <CloudOff className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-crit)]" strokeWidth={1.75} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <b className="font-medium">{t('common.loadError')}</b>
        <span className="text-[12.5px] text-[var(--color-muted)]">{message}</span>
        <span className="text-[12px] text-[var(--color-dim)]">{t('common.loadErrorHint')}</span>
      </span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}

export const ErrorState = ErrorNote;

/* ------------------------------------------------------- explanation block */

/**
 * Renders the `explanation` every AI response carries. A component because the rule that no
 * recommendation appears without its reasoning is a product rule, not a per-screen choice.
 */
export function Explain({
  summary,
  reasons,
  assumptions,
  defaultOpen = false,
  confidence,
}: {
  summary?: string;
  reasons: string[];
  assumptions?: string[];
  defaultOpen?: boolean;
  confidence?: number | null;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2">
      {summary && <p className="m-0 text-[13.5px] leading-relaxed text-[var(--color-ink)]">{summary}</p>}

      {reasons.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {reasons.map((reason, index) => (
            <li key={index} className="flex gap-2 text-[13px] leading-relaxed text-[var(--color-muted)]">
              <span className="mt-[0.6rem] h-1 w-1 shrink-0 rounded-full bg-[var(--color-muted)]" />
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      )}

      {confidence !== undefined && confidence !== null && (
        <span className="prov" style={{ color: 'var(--color-ink)' }}>
          <span className="prov-dot" style={{ background: 'var(--color-ink)' }} />
          {t('common.confidence')} {confidence.toFixed(2)}
        </span>
      )}

      {assumptions && assumptions.length > 0 && (
        <details className="group" open={defaultOpen}>
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[12.5px] font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)]">
            <ChevronRight className="h-3.5 w-3.5 transition-transform duration-200 group-open:rotate-90" />
            {assumptions.length === 1 ? t('common.assumption') : t('common.assumptions', { n: assumptions.length })}
          </summary>
          <ul className="fade-in m-0 mt-1.5 flex list-none flex-col gap-1 border-l border-[var(--color-line)] py-0 pl-3">
            {assumptions.map((assumption, index) => (
              <li key={index} className="text-[12px] leading-relaxed text-[var(--color-dim)]">
                {assumption}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ decision loop */

/** Charte `<DecisionLoop>`: TRACK → OPTIMISE → recommendation → outcome, with the live step lit. */
export function DecisionLoop({
  steps,
  active,
}: {
  steps: Array<{ label: ReactNode; detail?: ReactNode; icon?: LucideIcon }>;
  active: number;
}) {
  return (
    <ol className="m-0 grid list-none gap-2 p-0" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0,1fr))` }}>
      {steps.map((step, index) => {
        const Icon = step.icon;
        const state = index < active ? 'done' : index === active ? 'now' : 'next';
        return (
          <li
            key={index}
            className={`relative flex flex-col gap-1 rounded-[var(--radius-md)] p-3 transition-colors duration-200 ${
              state === 'now'
                ? 'bg-[var(--color-accent)] text-[var(--color-accent-tx)]'
                : 'bg-[var(--color-surface-2)]'
            }`}
          >
            <span className="flex items-center gap-1.5 text-[11px] font-medium opacity-80">
              {state === 'done' ? <CircleCheck className="h-3.5 w-3.5" /> : Icon ? <Icon className="h-3.5 w-3.5" /> : null}
              {String(index + 1).padStart(2, '0')}
            </span>
            <b className="text-[13px] font-medium leading-snug">{step.label}</b>
            {step.detail && (
              <span className={`text-[11.5px] ${state === 'now' ? 'opacity-75' : 'text-[var(--color-muted)]'}`}>
                {step.detail}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------- misc */

/** Small inline icon-and-text reason why an action is disabled. */
export function DisabledReason({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-[var(--color-muted)]">
      <CircleAlert className="h-3.5 w-3.5" />
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ format */

/** English-only formatter kept for code that runs outside the i18n provider. Prefer useFormat(). */
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
      : new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }),

  time: (value: string | Date | null | undefined): string =>
    !value ? '—' : new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),

  dateTime: (value: string | Date | null | undefined): string =>
    !value ? '—' : `${fmt.date(value)} ${fmt.time(value)}`,

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
