'use client';

import { Anchor, ArrowUpRight, Package, X } from 'lucide-react';
import Link from 'next/link';
import { useFormat, useI18n } from '@/lib/i18n';
import {
  Banner,
  Button,
  Chip,
  Facts,
  Provenance,
  SeverityIcon,
  Skeleton,
  Meter,
  statusTone,
} from '@/components/ui';
import { humanise, useLabel, useStatusLabel } from '../../shipments/[id]/_components/labels';
import type { FleetVessel, TrackResponse, VoyageDetail } from './types';
import { AIS_STALE_AFTER_MIN, LATE_HOURS, isSimulatedVessel } from './vessel-marker';

/** Charte provenance for an AIS fix: simulated, stale with its age, live, or polled. */
export function AisProvenance({
  at,
  simulated,
  live,
}: {
  at: string | null;
  simulated: boolean;
  live: boolean;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  if (simulated) return <Provenance kind="demo" />;
  if (!at) return <Provenance kind="offline" />;
  if ((Date.now() - Date.parse(at)) / 60_000 > AIS_STALE_AFTER_MIN) {
    return <Provenance kind="stale" label={t('sea.v3.staleSince', { age: fmt.relative(at) })} />;
  }
  return live ? <Provenance kind="live" label={t('sea.v3.aisLive')} /> : <Provenance kind="poll" seconds={20} />;
}

/** The selected vessel and its current voyage: ETA first, then everything that explains it. */
export function VoyagePanel({
  vessel,
  voyage,
  voyageLoading,
  track,
  live,
  onClose,
}: {
  vessel: FleetVessel;
  voyage: VoyageDetail | undefined;
  voyageLoading: boolean;
  track: TrackResponse | undefined;
  live: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const label = useLabel();
  const statusLabel = useStatusLabel();
  const simulated = isSimulatedVessel(vessel);
  const delta = voyage?.scheduleDeltaHours;

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="t-label">{t('sea.voyage')}</span>
          <span className="flex flex-wrap items-center gap-2">
            <span className="t-h3">{vessel.name}</span>
            <Chip tone={vessel.isOwnFleet ? 'signal' : 'neutral'}>
              {vessel.isOwnFleet ? t('sea.ownFleet') : t('sea.publicAis')}
            </Chip>
          </span>
          <span className="t-data text-[12px] text-[var(--color-muted)]">
            {t('sea.imo')} {vessel.imoNumber ?? '—'} · {t('sea.mmsi')} {vessel.mmsi ?? '—'}
          </span>
        </div>
        <Button variant="ghost" size="sm" icon={X} onClick={onClose} aria-label={t('common.close')} />
      </header>

      <AisProvenance at={vessel.lastPositionAt} simulated={simulated} live={live} />

      <Facts
        items={[
          [t('sea.type'), humanise(vessel.type)],
          [t('sea.flag'), vessel.flag ?? '—'],
          [t('sea.speed'), <span key="s" className="t-data">{fmt.num(vessel.speedKnots, 1)} {t('sea.knots')}</span>],
          [
            t('sea.course'),
            <span key="c" className="t-data">
              {vessel.courseDegrees === null ? '—' : `${fmt.num(vessel.courseDegrees, 0)}°`}
            </span>,
          ],
          [t('sea.lastFix'), <span key="l" className="t-data">{fmt.relative(vessel.lastPositionAt)}</span>],
          [
            t('sea.position'),
            <span key="p" className="t-data">
              {vessel.latitude.toFixed(3)}, {vessel.longitude.toFixed(3)}
            </span>,
          ],
        ]}
      />

      {voyage ? (
        <section className="tile flex flex-col gap-3.5 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="t-data text-[13px] text-[var(--color-ink)]">{voyage.voyageNumber}</span>
            <Chip tone="neutral">{label(`sea.v3.vstatus.${voyage.status}`, humanise(voyage.status))}</Chip>
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
            <span>{voyage.originPort.name}</span>
            <span className="t-data text-[11px] text-[var(--color-dim)]">{voyage.originPort.locode}</span>
            <span className="text-[var(--color-dim)]">→</span>
            <span>{voyage.destinationPort.name}</span>
            <span className="t-data text-[11px] text-[var(--color-dim)]">{voyage.destinationPort.locode}</span>
          </div>

          {/* P0: when the containers arrive. */}
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-muted)]">
              {t('sea.eta')}
              {delta !== undefined && delta >= LATE_HOURS ? (
                <SeverityIcon severity="critical" size={14} />
              ) : delta !== undefined && delta >= 2 ? (
                <SeverityIcon severity="warning" size={14} />
              ) : null}
            </span>
            <span className="t-kpi text-[26px] text-[var(--color-ink)]">{fmt.dateTime(voyage.computedEta)}</span>
            <span className="t-data text-[12px] text-[var(--color-muted)]">
              {fmt.relative(voyage.computedEta)} · {t('sea.scheduled')} {fmt.dateTime(voyage.scheduledArrivalAt)}
            </span>
          </div>

          {delta !== undefined && (
            <Banner
              tone={voyage.isBehindSchedule ? (delta >= LATE_HOURS ? 'alert' : 'warn') : 'ok'}
              title={`${fmt.num(Math.abs(delta), 1)} h ${delta > 0 ? t('sea.behindSchedule') : t('sea.aheadOfSchedule')}`}
            />
          )}

          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12.5px] text-[var(--color-muted)]">{t('sea.progress')}</span>
              <span className="t-data text-[13px]">{voyage.progressPercent} %</span>
            </div>
            <Meter value={voyage.progressPercent / 100} tone="signal" />
          </div>

          <Facts
            items={[
              [
                t('sea.remaining'),
                <span key="r" className="t-data">
                  {fmt.int(voyage.remainingNm)} {t('sea.nauticalMiles')}
                </span>,
              ],
              [
                t('sea.covered'),
                <span key="c" className="t-data">
                  {voyage.coveredNm === undefined ? '—' : `${fmt.int(voyage.coveredNm)} ${t('sea.nauticalMiles')}`}
                </span>,
              ],
            ]}
          />

          <div className="flex flex-col gap-1">
            <span className="text-[12.5px] text-[var(--color-muted)]">{t('sea.etaBasis')}</span>
            <p className="m-0 text-[12.5px] leading-relaxed text-[var(--color-ink)]">{voyage.etaBasis}</p>
          </div>

          {voyage.shipments.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-muted)]">
                <Package className="h-3.5 w-3.5" />
                {t('ship.title')}
              </span>
              <ul className="stagger m-0 flex list-none flex-col gap-1 p-0">
                {voyage.shipments.map((shipment) => (
                  <li key={shipment.id}>
                    <Link
                      href={`/shipments/${shipment.id}`}
                      className="flex min-h-8 items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2 py-1 transition-colors duration-100 hover:bg-[var(--color-surface)]"
                    >
                      <span className="t-data text-[12.5px]">{shipment.trackingNumber}</span>
                      <Chip tone={statusTone(shipment.status)}>{statusLabel(shipment.status)}</Chip>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ) : voyageLoading ? (
        <div className="tile flex flex-col gap-2.5 p-3.5">
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-2 w-full" />
        </div>
      ) : (
        <p className="m-0 flex items-center gap-1.5 text-[12.5px] text-[var(--color-muted)]">
          <Anchor className="h-3.5 w-3.5" />
          {t('sea.noVoyage')}
        </p>
      )}

      {/* Public trackers. Ordinary hyperlinks — no key, no cost — and genuinely useful alongside
          our own data: a second opinion, a photograph of the hull, or the port-call history this
          system does not store. */}
      {vessel.externalLinks?.marineTraffic && (
        <section className="flex flex-col gap-1.5">
          <span className="text-[12.5px] text-[var(--color-muted)]">{t('sea.externalTrackers')}</span>
          <div className="flex flex-wrap gap-2">
            <a
              href={vessel.externalLinks.marineTraffic}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-sm"
            >
              MarineTraffic
              <ArrowUpRight />
            </a>
            {vessel.externalLinks.vesselFinder && (
              <a
                href={vessel.externalLinks.vesselFinder}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-sm"
              >
                VesselFinder
                <ArrowUpRight />
              </a>
            )}
          </div>
          <p className="m-0 text-[11.5px] leading-relaxed text-[var(--color-dim)]">
            {t('sea.externalHint', { id: vessel.externalLinks.identifierUsed ?? '—' })}
          </p>
        </section>
      )}

      {track && (
        <p className="t-data m-0 text-[11px] text-[var(--color-dim)]">
          {t('sea.v3.fixes', { n: fmt.int(track.positionsTotal) })}
          {track.sampledEvery > 1 && ` · 1/${track.sampledEvery}`}
        </p>
      )}
    </div>
  );
}
