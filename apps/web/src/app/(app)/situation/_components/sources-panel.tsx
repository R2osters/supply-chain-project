'use client';

import { ChevronRight, Database } from 'lucide-react';
import type {
  CamerasResponse,
  FeedStatus,
  HazardsResponse,
  RadioResponse,
  TleResponse,
  TrafficStatus,
} from '@/lib/intel';
import { useFormat, useI18n, type TranslationKey } from '@/lib/i18n';
import { Provenance } from '@/components/ui';
import { feedProvenance } from './hazard-kind';

interface Row {
  key: string;
  label: string;
  status: FeedStatus;
  fetchedAt: string | null;
  detail: string;
  attribution: string;
}

const STATUS_KEY: Record<FeedStatus, TranslationKey> = {
  OK: 'sit.v3.src.ok',
  STALE: 'prov.stale',
  UNAVAILABLE: 'sit.v3.src.down',
  DISABLED: 'sit.v3.src.disabled',
};

/**
 * Every feed on the screen, its state and its credit line, as a provenance table.
 *
 * Two jobs. Honesty: a stale or failed source is shown as such, so nobody reads an empty map as
 * "no hazards". Compliance: most of these sources are free on condition of attribution (CC BY,
 * ODbL, Open Government Licences), and this table is where that attribution lives. Folded by
 * default — the summary line says how many feeds are cut, which is all a glance needs.
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
      fetchedAt: source.fetchedAt,
      detail: source.note ?? t('sit.v3.src.items', { n: fmt.int(source.count) }),
      attribution: source.attribution,
    })),
    ...(cameras?.packs ?? []).map((pack) => ({
      key: `c:${pack.id}`,
      label: pack.label,
      status: pack.status,
      fetchedAt: pack.fetchedAt,
      detail: `${t('sit.v3.src.items', { n: fmt.int(pack.count) })} · ${pack.licence}`,
      attribution: pack.attribution,
    })),
    ...(radio
      ? [{ key: 'radio', label: 'Radio Browser', status: radio.status, fetchedAt: radio.fetchedAt, detail: '', attribution: radio.attribution }]
      : []),
    ...(tle
      ? [{
          key: 'tle',
          label: 'CelesTrak',
          status: (tle.stale ? 'STALE' : 'OK') as FeedStatus,
          fetchedAt: tle.fetchedAt,
          detail: '',
          attribution: tle.attribution,
        }]
      : []),
    ...(traffic
      ? [{
          key: 'traffic',
          label: 'TomTom Traffic',
          status: (traffic.enabled ? 'OK' : 'DISABLED') as FeedStatus,
          fetchedAt: null,
          detail: traffic.enabled
            ? t('sit.sources.tiles', {
                used: fmt.int(traffic.tilesUsedToday),
                budget: traffic.dailyBudget > 0 ? fmt.int(traffic.dailyBudget) : t('map.traffic.status.unlimited'),
              })
            : (traffic.note ?? t('sit.hint.trafficOff')),
          attribution: traffic.attribution ?? '',
        }]
      : []),
    // Keyless measured speeds for the live map's road traffic: asked only when the map shows the city.
    ...(traffic?.sources ?? [])
      .filter((source) => source.id !== 'tomtom')
      .map((source) => ({
        key: `flow:${source.id}`,
        label: source.id === 'rennes' ? t('sit.sources.flowRennes') : t('sit.sources.flowGrenoble'),
        status: (source.active ? (source.stale ? 'STALE' : 'OK') : 'DISABLED') as FeedStatus,
        fetchedAt: source.updatedAt,
        detail: source.active ? '' : t('sit.sources.flowIdle'),
        attribution: source.attribution,
      })),
    ...(traffic
      ? [{
          key: 'roads',
          label: 'OpenFreeMap',
          status: 'OK' as FeedStatus,
          fetchedAt: null,
          detail: t('sit.sources.roads'),
          attribution: '© OpenMapTiles © OpenStreetMap contributors (ODbL)',
        }]
      : []),
  ];

  const cut = rows.filter((row) => row.status === 'UNAVAILABLE' || row.status === 'STALE').length;

  return (
    <details className="panel rise group">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 text-[15px] font-medium">
        <Database className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
        <span className="flex-1">{t('sit.sources.title')}</span>
        <span className="t-data text-[11px] font-normal text-[var(--color-muted)]">
          {cut > 0
            ? t('sit.v3.src.summaryCut', { n: rows.length, cut })
            : t('sit.v3.src.summary', { n: rows.length })}
        </span>
        <ChevronRight className="h-4 w-4 text-[var(--color-muted)] transition-transform duration-200 group-open:rotate-90" />
      </summary>
      {rows.length === 0 ? (
        <p className="m-0 px-5 pb-4 text-[12.5px] text-[var(--color-muted)]">{t('sit.loading')}</p>
      ) : (
        <div className="fade-in overflow-x-auto pb-2">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="text-left">
                <th className="t-label border-b border-[var(--color-line)] py-2 pl-5 pr-2 font-medium">{t('sit.v3.src.source')}</th>
                <th className="t-label border-b border-[var(--color-line)] px-2 py-2 font-medium">{t('sit.v3.src.status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="align-top">
                  <td className="border-b border-[var(--color-line)] py-2.5 pl-5 pr-2">
                    <span className="block text-[var(--color-ink)]">{row.label}</span>
                    {row.detail && <span className="block text-[12px] text-[var(--color-muted)]">{row.detail}</span>}
                    {row.attribution && (
                      <span className="t-data block break-words text-[11px] text-[var(--color-dim)]">{row.attribution}</span>
                    )}
                  </td>
                  <td className="border-b border-[var(--color-line)] px-2 py-2.5 pr-5">
                    <Provenance
                      kind={feedProvenance(row.status)}
                      label={
                        row.status === 'OK' && row.fetchedAt
                          ? fmt.relative(row.fetchedAt)
                          : row.status === 'STALE' && row.fetchedAt
                            ? `${t('prov.stale')} · ${fmt.relative(row.fetchedAt)}`
                            : t(STATUS_KEY[row.status])
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
