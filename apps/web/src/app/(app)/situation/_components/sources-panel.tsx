'use client';

import type {
  CamerasResponse,
  FeedStatus,
  HazardsResponse,
  RadioResponse,
  TleResponse,
  TrafficStatus,
} from '@/lib/intel';
import { useFormat, useI18n } from '@/lib/i18n';
import { Panel } from '@/components/ui';

interface Row {
  key: string;
  label: string;
  status: FeedStatus;
  detail: string;
  attribution: string;
}

const STATUS_COLOUR: Record<FeedStatus, string> = {
  OK: 'var(--color-ok)',
  STALE: 'var(--color-warn)',
  UNAVAILABLE: 'var(--color-alert)',
  DISABLED: 'var(--color-ink-faint)',
};

/**
 * Every feed on the screen, its state and its credit line.
 *
 * Two jobs. Honesty: a stale or failed source is shown as such, so nobody reads an empty map as
 * "no hazards". Compliance: most of these sources are free on condition of attribution (CC BY,
 * ODbL, Open Government Licences), and this list is where that attribution lives.
 */
export function SourcesPanel({
  hazards,
  cameras,
  radio,
  tle,
  traffic,
}: {
  hazards?: HazardsResponse;
  cameras?: CamerasResponse;
  radio?: RadioResponse;
  tle?: TleResponse;
  traffic?: TrafficStatus;
}) {
  const { t } = useI18n();
  const fmt = useFormat();

  const rows: Row[] = [
    ...(hazards?.sources ?? []).map((source) => ({
      key: `h:${source.id}`,
      label: source.label,
      status: source.status,
      detail: source.note ?? `${fmt.int(source.count)} · ${fmt.relative(source.fetchedAt)}`,
      attribution: source.attribution,
    })),
    ...(cameras?.packs ?? []).map((pack) => ({
      key: `c:${pack.id}`,
      label: pack.label,
      status: pack.status,
      detail: `${fmt.int(pack.count)} · ${pack.licence}`,
      attribution: pack.attribution,
    })),
    ...(radio
      ? [{ key: 'radio', label: 'Radio Browser', status: radio.status, detail: fmt.relative(radio.fetchedAt), attribution: radio.attribution }]
      : []),
    ...(tle
      ? [{ key: 'tle', label: 'CelesTrak', status: (tle.stale ? 'STALE' : 'OK') as FeedStatus, detail: fmt.relative(tle.fetchedAt), attribution: tle.attribution }]
      : []),
    ...(traffic
      ? [{
          key: 'traffic',
          label: 'TomTom Traffic',
          status: (traffic.enabled ? 'OK' : 'DISABLED') as FeedStatus,
          detail: traffic.enabled
            ? t('sit.sources.tiles', { used: fmt.int(traffic.tilesUsedToday), budget: fmt.int(traffic.dailyBudget) })
            : (traffic.note ?? t('sit.hint.trafficOff')),
          attribution: traffic.attribution ?? '',
        }]
      : []),
  ];

  return (
    <Panel title={t('sit.sources.title')}>
      <ul className="divide-y divide-[var(--color-hairline)]">
        {rows.map((row) => (
          <li key={row.key} className="px-3.5 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 truncate text-[0.6875rem] text-[var(--color-ink-dim)]">
                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLOUR[row.status] }} />
                {row.label}
              </span>
              <span className="shrink-0 font-mono text-[0.5625rem] uppercase text-[var(--color-ink-faint)]">{row.status}</span>
            </div>
            <div className="truncate font-mono text-[0.5625rem] text-[var(--color-ink-faint)]" title={row.attribution}>
              {row.detail}
              {row.attribution ? ` · ${row.attribution}` : ''}
            </div>
          </li>
        ))}
        {rows.length === 0 && <li className="px-3.5 py-2 text-[0.6875rem] text-[var(--color-ink-faint)]">{t('sit.loading')}</li>}
      </ul>
    </Panel>
  );
}
