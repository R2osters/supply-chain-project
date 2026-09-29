'use client';

import { useFormat, useI18n } from '@/lib/i18n';
import { Empty, SeverityIcon, type Severity } from '@/components/ui';
import { humanise, useLabel, useStatusLabel } from './labels';

export interface ShipmentEventRow {
  id: string;
  type: string;
  description: string;
  fromStatus: string | null;
  toStatus: string | null;
  occurredAt: string;
}

/** Only exceptions earn a coloured shape; everything nominal is a grey dot (charte §01). */
function eventSeverity(type: string): Severity | null {
  switch (type) {
    case 'INCIDENT':
    case 'DELAY_DETECTED':
      return 'critical';
    case 'ANOMALY_DETECTED':
      return 'warning';
    case 'DELIVERED':
    case 'ARRIVED':
      return 'ok';
    default:
      return null;
  }
}

/** Newest first: the operator opens this to learn what just happened. */
export function EventTimeline({ events }: { events: ShipmentEventRow[] }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const label = useLabel();
  const statusLabel = useStatusLabel();

  if (events.length === 0) return <Empty title={t('ship.detail.events.empty')} hint={t('ship.detail.events.emptyHint')} />;

  const ordered = [...events].reverse();
  return (
    <ol className="stagger m-0 list-none px-5 pb-5 pt-3">
      {ordered.map((event, index) => {
        const severity = eventSeverity(event.type);
        return (
          <li key={event.id} className="relative grid grid-cols-[16px_minmax(0,1fr)] gap-3 pb-4 last:pb-0">
            {index < ordered.length - 1 && (
              <span aria-hidden className="absolute bottom-0 left-[7.5px] top-5 w-px bg-[var(--color-line)]" />
            )}
            <span className="relative z-[1] mt-0.5 flex h-4 w-4 items-center justify-center bg-[var(--color-surface)]">
              {severity ? (
                <SeverityIcon severity={severity} size={14} />
              ) : (
                <span className="h-2 w-2 rounded-full bg-[var(--color-muted)]" />
              )}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <b className="text-[13px] font-medium">{label(`ship.detail.event.${event.type}`, humanise(event.type))}</b>
                <span className="t-data text-[11px] text-[var(--color-dim)]">{fmt.dateTime(event.occurredAt)}</span>
              </div>
              <p className="m-0 text-[13px] text-[var(--color-muted)] [text-wrap:pretty]">{event.description}</p>
              {event.fromStatus && event.toStatus && (
                <span className="text-[12px] text-[var(--color-dim)]">
                  {statusLabel(event.fromStatus)} → {statusLabel(event.toStatus)}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
