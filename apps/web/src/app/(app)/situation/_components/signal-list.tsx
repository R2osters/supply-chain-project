'use client';

import type { UseQueryResult } from '@tanstack/react-query';
import { ListOrdered, Radar } from 'lucide-react';
import type { Exposure, Hazard, HazardsResponse } from '@/lib/intel';
import { useFormat, useI18n } from '@/lib/i18n';
import { AlertRow, Button, Empty, ErrorNote, Loading, Panel, Provenance } from '@/components/ui';
import { KIND_ICON, KIND_KEY, feedProvenance, hazardSeverity, sourceFor } from './hazard-kind';

/**
 * « Signaux classés »: every hazard in view, ranked by what touches the network first (see
 * `rankHazards`). Each line carries its source and that source's freshness, so a quiet list can
 * be told apart from a feed that is down.
 */
export function SignalList({
  hazards,
  ranked,
  layerOn,
  onShowLayer,
  selectedId,
  onSelect,
}: {
  hazards: UseQueryResult<HazardsResponse>;
  ranked: Array<{ hazard: Hazard; exposed: Exposure[] }>;
  layerOn: boolean;
  onShowLayer(): void;
  selectedId: string | null;
  onSelect(hazard: Hazard): void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const sources = hazards.data?.sources ?? [];
  const down = sources.filter((source) => source.status === 'UNAVAILABLE' || source.status === 'STALE');

  return (
    <Panel
      icon={ListOrdered}
      title={t('sit.v3.signals.title')}
      meta={
        layerOn && hazards.data ? (
          <span className="pill-count pop" key={ranked.length}>
            {fmt.int(ranked.length)}
          </span>
        ) : undefined
      }
      actions={
        <span className="hidden items-center gap-1 text-[11px] text-[var(--color-dim)] xl:flex">
          <span className="kbd">J</span>
          <span className="kbd">K</span>
        </span>
      }
      loading={hazards.isFetching && !hazards.isLoading}
    >
      {/* Source coupée: said once, above the list, so the missing lines are explained. */}
      {down.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1.5 px-5 pb-1 pt-2">
          {down.map((source) => (
            <li key={source.id} className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--color-muted)]">
              <Provenance
                kind={feedProvenance(source.status)}
                label={source.status === 'STALE' ? `${source.label} · ${fmt.relative(source.fetchedAt)}` : source.label}
              />
              <span>{source.status === 'STALE' ? t('sit.v3.signals.sourceStale') : t('sit.v3.signals.sourceDown')}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="max-h-[40vh] overflow-y-auto pb-2" aria-live="polite">
        {!layerOn ? (
          <Empty
            icon={Radar}
            title={t('sit.v3.signals.layerOff')}
            hint={t('sit.v3.signals.layerOffHint')}
            action={
              <Button size="sm" onClick={onShowLayer}>
                {t('sit.v3.signals.showLayer')}
              </Button>
            }
          />
        ) : hazards.isLoading || (!hazards.data && !hazards.isError) ? (
          <Loading rows={4} />
        ) : hazards.isError && !hazards.data ? (
          <ErrorNote error={hazards.error} onRetry={() => void hazards.refetch()} />
        ) : ranked.length === 0 ? (
          <Empty
            icon={Radar}
            title={t('sit.v3.signals.none')}
            hint={t('sit.v3.signals.noneHint', { n: sources.length })}
          />
        ) : (
          <ul className="stagger m-0 list-none p-0 px-1">
            {ranked.map(({ hazard, exposed }) => {
              const KindIcon = KIND_ICON[hazard.kind];
              const source = sourceFor(hazard, sources);
              return (
                <li key={hazard.id}>
                  <AlertRow
                    severity={hazardSeverity(hazard.severity)}
                    selected={hazard.id === selectedId}
                    onClick={() => onSelect(hazard)}
                    title={hazard.title}
                    context={
                      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        <KindIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        <span>{t(KIND_KEY[hazard.kind])}</span>
                        <span aria-hidden>·</span>
                        {exposed.length > 0 ? (
                          <b className="font-medium text-[var(--color-ink)]">
                            {exposed.length === 1
                              ? t('sit.v3.signals.exposedOne')
                              : t('sit.v3.signals.exposedMany', { n: exposed.length })}
                          </b>
                        ) : (
                          <span>{t('sit.v3.signals.notExposed')}</span>
                        )}
                      </span>
                    }
                    source={hazard.source}
                    provenance={
                      source ? (
                        <Provenance
                          kind={feedProvenance(source.status)}
                          label={source.status === 'OK' ? fmt.relative(source.fetchedAt) : undefined}
                        />
                      ) : undefined
                    }
                    age={fmt.relative(hazard.observedAt)}
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
