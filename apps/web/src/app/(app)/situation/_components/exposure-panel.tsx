'use client';

import type { UseQueryResult } from '@tanstack/react-query';
import { Factory, ShieldCheck, Truck, Warehouse, type LucideIcon } from 'lucide-react';
import type { Exposure, ExposureResponse } from '@/lib/intel';
import { useFormat, useI18n, type TranslationKey } from '@/lib/i18n';
import { AlertRow, Empty, ErrorNote, Loading, Panel } from '@/components/ui';
import { KIND_ICON, hazardSeverity } from './hazard-kind';

export const SUBJECT_KEY: Record<Exposure['subjectType'], TranslationKey> = {
  WAREHOUSE: 'sit.subject.warehouse',
  SHIPMENT: 'sit.subject.shipment',
  SUPPLIER: 'sit.subject.supplier',
};

export const SUBJECT_ICON: Record<Exposure['subjectType'], LucideIcon> = {
  WAREHOUSE: Warehouse,
  SHIPMENT: Truck,
  SUPPLIER: Factory,
};

/**
 * Which of *our* assets sit near an active hazard. This is the question the whole situation
 * screen exists to answer; the map is context for it. The query lives in the page (it also
 * drives the page title and the signal ranking); this panel only draws it.
 */
export function ExposurePanel({
  exposure,
  onFocus,
}: {
  exposure: UseQueryResult<ExposureResponse>;
  onFocus(exposure: Exposure): void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const list = exposure.data?.exposures ?? [];

  return (
    <Panel
      icon={ShieldCheck}
      title={t('sit.exposure.title')}
      meta={
        exposure.data ? (
          <span className="t-data text-[11px] text-[var(--color-muted)]">
            {t('sit.exposure.radius', { km: fmt.int(exposure.data.radiusKm) })}
          </span>
        ) : undefined
      }
      loading={exposure.isFetching && !exposure.isLoading}
    >
      <div className="max-h-[34vh] overflow-y-auto pb-2">
        {exposure.isLoading ? (
          <Loading rows={3} />
        ) : exposure.isError ? (
          <ErrorNote error={exposure.error} onRetry={() => void exposure.refetch()} />
        ) : list.length === 0 ? (
          // « Rayon sans résultat »: say what was checked and how far, so an empty list reads as
          // "checked, nothing near" rather than "not loaded".
          <Empty
            icon={ShieldCheck}
            title={t('sit.exposure.none')}
            hint={t('sit.v3.exposure.noneHint', { km: fmt.int(exposure.data?.radiusKm ?? 0) })}
          />
        ) : (
          <ul className="stagger m-0 list-none p-0 px-1">
            {list.map((item) => {
              const SubjectIcon = SUBJECT_ICON[item.subjectType];
              const KindIcon = KIND_ICON[item.hazardKind];
              return (
                <li key={`${item.hazardId}:${item.subjectType}:${item.subjectId}`}>
                  <AlertRow
                    severity={hazardSeverity(item.severity)}
                    onClick={() => onFocus(item)}
                    title={
                      <span className="flex items-center gap-1.5">
                        <SubjectIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted)]" />
                        <span className="truncate">{item.subjectLabel}</span>
                      </span>
                    }
                    context={
                      <span className="flex min-w-0 items-center gap-1.5">
                        <KindIcon className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">
                          {t(SUBJECT_KEY[item.subjectType])} · {item.hazardTitle}
                        </span>
                      </span>
                    }
                    age={`${fmt.num(item.distanceKm, 0)} km`}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}
