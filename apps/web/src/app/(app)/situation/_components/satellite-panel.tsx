'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { SatelliteGroup, VisibleSatellitesResponse } from '@/lib/intel';
import { useFormat, useI18n } from '@/lib/i18n';
import type { SubPoint } from '@/lib/orbits';
import { Chip, Panel } from '@/components/ui';

const QUALITY_TONE = { GOOD: 'ok', FAIR: 'warn', POOR: 'alert' } as const;

/**
 * Satellite context for a point on the ground: how many satellites of the chosen constellation
 * are above it right now. For GNSS groups that is the practical question behind a tracker's
 * bad fixes — in a deep valley or a port stacked with containers, fewer than four satellites
 * in view means no reliable position at all.
 */
export function SatellitePanel({
  group,
  onGroupChange,
  observer,
  selected,
  tracked,
}: {
  group: string;
  onGroupChange(group: string): void;
  observer: { latitude: number; longitude: number };
  selected: SubPoint | null;
  tracked: number;
}) {
  const { t } = useI18n();
  const fmt = useFormat();

  const groups = useQuery({
    queryKey: ['satellites', 'groups'],
    queryFn: () => api<{ groups: SatelliteGroup[] }>('/satellites/groups'),
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Rounded so dragging the map a few pixels does not refetch.
  const lat = observer.latitude.toFixed(1);
  const lon = observer.longitude.toFixed(1);
  const visible = useQuery({
    queryKey: ['satellites', 'visible', group, lat, lon],
    queryFn: () => api<VisibleSatellitesResponse>(`/satellites/visible?group=${group}&lat=${lat}&lon=${lon}`),
    refetchInterval: 60_000,
  });

  return (
    <Panel title={t('sit.sat.title')} meta={<span className="tnum">{tracked}</span>}>
      <div className="space-y-3 p-3.5">
        <select
          value={group}
          onChange={(event) => onGroupChange(event.target.value)}
          className="w-full border border-[var(--color-hairline)] bg-[var(--color-void)] px-2 py-1.5 font-mono text-[0.6875rem] text-[var(--color-ink)]"
          aria-label={t('sit.sat.group')}
        >
          {(groups.data?.groups ?? [{ id: group, label: group, description: '' }]).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>

        <div>
          <div className="mb-1 font-mono text-[0.5625rem] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
            {t('sit.sat.aboveCentre', { lat, lon })}
          </div>
          {visible.data ? (
            <div className="flex items-center justify-between gap-2">
              <span className="tnum text-[0.8125rem] text-[var(--color-ink)]">
                {t('sit.sat.visibleCount', {
                  n: visible.data.summary.count,
                  high: visible.data.summary.above30Deg,
                })}
              </span>
              <Chip tone={QUALITY_TONE[visible.data.summary.quality]}>
                {t(`sit.sat.quality.${visible.data.summary.quality.toLowerCase() as 'good' | 'fair' | 'poor'}`)}
              </Chip>
            </div>
          ) : (
            <p className="text-[0.6875rem] text-[var(--color-ink-faint)]">
              {visible.isError ? t('sit.unavailable') : t('sit.loading')}
            </p>
          )}
        </div>

        {selected && (
          <dl className="space-y-1 border-t border-[var(--color-hairline)] pt-2.5">
            <div className="text-[0.75rem] text-[var(--color-signal)]">{selected.name}</div>
            <div className="flex justify-between font-mono text-[0.6875rem] text-[var(--color-ink-dim)]">
              <span>NORAD {selected.noradId}</span>
              <span>{fmt.int(selected.altitudeKm)} km</span>
            </div>
            <div className="font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
              {selected.latitude.toFixed(2)}, {selected.longitude.toFixed(2)} · {t('sit.sat.trackHint')}
            </div>
          </dl>
        )}

        <p className="font-mono text-[0.5625rem] text-[var(--color-ink-faint)]">CelesTrak (celestrak.org), Dr. T.S. Kelso</p>
      </div>
    </Panel>
  );
}
