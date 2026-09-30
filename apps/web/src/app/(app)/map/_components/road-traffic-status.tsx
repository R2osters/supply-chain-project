'use client';

import { Car } from 'lucide-react';
import type { TrafficStatus } from '@/lib/intel';
import { useI18n } from '@/lib/i18n';
import type { FlowSource } from '@/lib/traffic/flow-match';
import { DOTS_MIN_ZOOM } from './road-traffic';
import type { RoadTrafficState } from './use-road-traffic';

const SOURCE_NAME: Record<FlowSource, string> = { rennes: 'Rennes', grenoble: 'Grenoble', tomtom: 'TomTom' };

/**
 * One line under the map toggles saying what the traffic is: simulated on real roads, with speeds
 * measured by which sources in this view, or estimated. Honesty over polish: a simulated car must
 * never pass for an observed one.
 */
export function RoadTrafficStatus({ enabled, state, status }: { enabled: boolean; state: RoadTrafficState; status?: TrafficStatus }) {
  const { t } = useI18n();
  if (!enabled) return null;

  const parts: string[] = [];
  if (state.roadsFailed) {
    parts.push(t('map.traffic.status.offline'));
  } else if (state.zoom < DOTS_MIN_ZOOM) {
    parts.push(t('map.traffic.status.zoomIn'));
  } else {
    parts.push(t('map.traffic.status.simulated'));
    parts.push(
      state.measuredSources.length > 0
        ? t('map.traffic.status.measured', { sources: state.measuredSources.map((source) => SOURCE_NAME[source]).join(', ') })
        : t('map.traffic.status.estimated'),
    );
  }
  if (status?.enabled) {
    parts.push(
      t('map.traffic.status.budget', {
        used: status.tilesUsedToday,
        budget: status.dailyBudget > 0 ? String(status.dailyBudget) : t('map.traffic.status.unlimited'),
      }),
    );
  }

  return (
    <div className="t-data flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--color-dim)]" aria-live="polite">
      <span>
        <Car className="mr-1 inline h-3 w-3 align-[-2px]" aria-hidden />
        {parts.join(' · ')}
      </span>
    </div>
  );
}
