'use client';

import { useQuery } from '@tanstack/react-query';
import { Satellite } from 'lucide-react';
import { api } from '@/lib/api';
import type { SatelliteGroup, TleResponse, VisibleSatellitesResponse } from '@/lib/intel';
import { useFormat, useI18n } from '@/lib/i18n';
import type { SubPoint } from '@/lib/orbits';
import { Panel, Provenance, SeverityIcon, type Severity } from '@/components/ui';

/** A good fix is nominal and stays grey; only fair / poor earn the exception icons. */
const QUALITY_SEVERITY: Record<VisibleSatellitesResponse['summary']['quality'], Severity | null> = {
  GOOD: null,
  FAIR: 'warning',
  POOR: 'critical',
};

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
  tle,
}: {
  group: string;
  onGroupChange(group: string): void;
  observer: { latitude: number; longitude: number };
  selected: SubPoint | null;
  tracked: number;
  tle?: TleResponse;
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

  const quality = visible.data ? QUALITY_SEVERITY[visible.data.summary.quality] : null;

  return (
    <Panel
      icon={Satellite}
      title={t('sit.sat.title')}
      meta={<span className="pill-count">{fmt.int(tracked)}</span>}
      className="slide-in-right"
    >
      <div className="flex flex-col gap-4 px-5 pb-5 pt-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-[var(--color-muted)]">{t('sit.sat.group')}</span>
          <select value={group} onChange={(event) => onGroupChange(event.target.value)} className="field">
            {(groups.data?.groups ?? [{ id: group, label: group, description: '' }]).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <div className="tile flex flex-col gap-1.5 p-4">
          <span className="t-label">{t('sit.sat.aboveCentre', { lat, lon })}</span>
          {visible.data ? (
            <>
              <span className="flex items-baseline gap-2">
                <span className="t-kpi text-[24px] text-[var(--color-ink)]">{fmt.int(visible.data.summary.count)}</span>
                <span className="text-[12.5px] text-[var(--color-muted)]">
                  {t('sit.sat.visibleCount', {
                    n: visible.data.summary.count,
                    high: visible.data.summary.above30Deg,
                  })}
                </span>
              </span>
              <span className="flex items-center gap-1.5 text-[13px] text-[var(--color-ink)]">
                {quality && <SeverityIcon severity={quality} size={14} />}
                {t(`sit.sat.quality.${visible.data.summary.quality.toLowerCase() as 'good' | 'fair' | 'poor'}`)}
              </span>
            </>
          ) : (
            <p className="m-0 text-[12.5px] text-[var(--color-muted)]">
              {visible.isError ? t('sit.unavailable') : t('sit.loading')}
            </p>
          )}
        </div>

        {selected && (
          <div key={selected.noradId} className="slide-in-right flex flex-col gap-1">
            <span className="text-[14px] text-[var(--color-ink)]">{selected.name}</span>
            <span className="flex justify-between gap-2">
              <span className="t-data text-[12px]">NORAD {selected.noradId}</span>
              <span className="t-data text-[12px]">{fmt.int(selected.altitudeKm)} km</span>
            </span>
            <span className="t-data text-[11px] text-[var(--color-dim)]">
              {selected.latitude.toFixed(2)}, {selected.longitude.toFixed(2)} · {t('sit.sat.trackHint')}
            </span>
          </div>
        )}

        <span className="flex flex-wrap items-center gap-2">
          <span className="t-data text-[11px] text-[var(--color-dim)]">CelesTrak (celestrak.org), Dr. T.S. Kelso</span>
          {tle && (
            <Provenance
              kind={tle.stale ? 'stale' : 'poll'}
              label={`${tle.stale ? t('prov.stale') : 'TLE'} · ${fmt.relative(tle.fetchedAt)}`}
            />
          )}
        </span>
      </div>
    </Panel>
  );
}
