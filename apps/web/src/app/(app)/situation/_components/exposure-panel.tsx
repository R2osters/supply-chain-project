'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { HAZARD_COLOUR, type Exposure, type ExposureResponse } from '@/lib/intel';
import { useFormat, useI18n, type TranslationKey } from '@/lib/i18n';
import { Chip, Empty, ErrorNote, Panel } from '@/components/ui';
import { severityTone } from './severity';

const SUBJECT_KEY: Record<Exposure['subjectType'], TranslationKey> = {
  WAREHOUSE: 'sit.subject.warehouse',
  SHIPMENT: 'sit.subject.shipment',
  SUPPLIER: 'sit.subject.supplier',
};

/**
 * Which of *our* assets sit near an active hazard. This is the question the whole situation
 * screen exists to answer; the map is context for it, so it is the default side panel.
 */
export function ExposurePanel({ onFocus }: { onFocus(exposure: Exposure): void }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const exposure = useQuery({
    queryKey: ['hazards', 'exposure'],
    queryFn: () => api<ExposureResponse>('/hazards/exposure'),
    refetchInterval: 5 * 60_000,
  });

  return (
    <Panel
      title={t('sit.exposure.title')}
      meta={
        exposure.data ? (
          <span className="tnum">{t('sit.exposure.radius', { km: fmt.int(exposure.data.radiusKm) })}</span>
        ) : undefined
      }
      loading={exposure.isLoading}
    >
      <div className="max-h-[38vh] overflow-y-auto">
        {exposure.isError ? (
          <div className="p-3.5">
            <ErrorNote error={exposure.error} />
          </div>
        ) : exposure.data && exposure.data.exposures.length === 0 ? (
          <Empty title={t('sit.exposure.none')} hint={t('sit.exposure.noneHint')} />
        ) : (
          <ul className="divide-y divide-[var(--color-hairline)]">
            {(exposure.data?.exposures ?? []).map((item) => (
              <li key={`${item.hazardId}:${item.subjectType}:${item.subjectId}`}>
                <button
                  onClick={() => onFocus(item)}
                  className="w-full px-3.5 py-2 text-left hover:bg-[color-mix(in_srgb,var(--color-signal)_5%,transparent)]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[0.75rem] text-[var(--color-ink)]">{item.subjectLabel}</span>
                    <Chip tone={severityTone(item.severity)}>{item.severity}</Chip>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
                    <span
                      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: HAZARD_COLOUR[item.hazardKind] }}
                    />
                    <span className="truncate">
                      {t(SUBJECT_KEY[item.subjectType])} · {fmt.num(item.distanceKm, 0)} km · {item.hazardTitle}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
