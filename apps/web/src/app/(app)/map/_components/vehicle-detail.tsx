'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Cctv, CloudSun, Package, X } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { api, type FleetVehicle, type VehicleEstimate } from '@/lib/api';
import type { Camera, CamerasResponse, PointWeather } from '@/lib/intel';
import { useFormat, useI18n } from '@/lib/i18n';
import { Button, Chip, DemoTag, Facts, Provenance, SeverityIcon, statusTone } from '@/components/ui';
import { CameraViewer } from '@/components/intel/camera-viewer';
import { useStatusLabel } from '../../shipments/detail/_components/labels';
import { describeEstimate } from './estimates';
import { vehicleState } from './vehicle-marker';
import { shipmentHref } from '@/lib/routes';

/** A fix older than this is shown as stale with its age — never as a false "live". */
const STALE_AFTER_MIN = 10;

export function fixAgeMinutes(iso: string): number {
  return (Date.now() - Date.parse(iso)) / 60_000;
}

/** Charte provenance for one vehicle's last fix: stale beats live, live beats polling. */
export function FixProvenance({ at, live }: { at: string | null; live: boolean }) {
  const { t } = useI18n();
  const fmt = useFormat();
  if (at === null) return <Provenance kind="stale" label={t('map.est.neverReported')} />;
  if (fixAgeMinutes(at) > STALE_AFTER_MIN) {
    return <Provenance kind="stale" label={t('map.v3.staleSince', { age: fmt.relative(at) })} />;
  }
  return live ? <Provenance kind="live" /> : <Provenance kind="poll" seconds={30} />;
}

/**
 * Right-hand detail of the selected vehicle. Weather and nearby cameras are fetched here so the
 * page only pays for them while a vehicle is open.
 */
export function VehicleDetail({
  vehicle,
  live,
  onClose,
  replay,
}: {
  vehicle: FleetVehicle;
  live: boolean;
  onClose: () => void;
  replay: ReactNode;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const statusLabel = useStatusLabel();
  const [camera, setCamera] = useState<Camera | null>(null);
  const state = vehicleState(vehicle);

  // One decimal (~10 km) in the keys: a moving truck must not refetch on every poll.
  const lat1 = vehicle.latitude.toFixed(1);
  const lon1 = vehicle.longitude.toFixed(1);

  const nearbyCameras = useQuery({
    queryKey: ['cameras', 'near', vehicle.vehicleId, lat1, lon1],
    queryFn: () =>
      api<CamerasResponse>(
        `/cameras/near?lat=${vehicle.latitude}&lon=${vehicle.longitude}&radiusKm=50&limit=3`,
      ),
    staleTime: 5 * 60_000,
  });

  const weather = useQuery({
    queryKey: ['hazards', 'weather', lat1, lon1],
    queryFn: () => api<PointWeather>(`/hazards/weather?lat=${vehicle.latitude}&lon=${vehicle.longitude}`),
    staleTime: 10 * 60_000,
  });

  const riskSeverity = state === 'delayed' ? 'critical' : state === 'atRisk' ? 'warning' : null;

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* ---------------------------------------------------------- identity */}
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="t-label">{t('map.v3.vehicle')}</span>
          <span className="flex flex-wrap items-center gap-2">
            <span className="t-data text-[18px] text-[var(--color-ink)]">{vehicle.plateNumber}</span>
            {vehicle.isDemoData && <DemoTag />}
          </span>
          <span className="text-[12.5px] text-[var(--color-muted)]">
            {[vehicle.label, vehicle.type.replace(/_/g, ' ').toLowerCase()].filter(Boolean).join(' · ')}
          </span>
        </div>
        <Button variant="ghost" size="sm" icon={X} onClick={onClose} aria-label={t('common.close')} />
      </header>

      <FixProvenance at={vehicle.lastPositionAt} live={live} />

      {vehicle.estimated && <EstimateNote vehicle={vehicle} estimate={vehicle.estimated} />}

      <Facts
        items={[
          [t('map.v3.driver'), vehicle.driverName ?? '—'],
          [t('map.v3.speed'), <span key="s" className="t-data">{fmt.num(vehicle.speedKmh, 0)} km/h</span>],
          [
            t('map.v3.heading'),
            <span key="h" className="t-data">
              {vehicle.headingDegrees === null ? '—' : `${fmt.num(vehicle.headingDegrees, 0)}°`}
            </span>,
          ],
          [
            t('map.v3.lastFix'),
            <span key="l" className="t-data">
              {vehicle.lastPositionAt ? fmt.relative(vehicle.lastPositionAt) : t('map.est.never')}
            </span>,
          ],
          [
            t('map.v3.position'),
            <span key="p" className="t-data">
              {vehicle.latitude.toFixed(4)}, {vehicle.longitude.toFixed(4)}
            </span>,
          ],
        ]}
      />

      {/* ---------------------------------------------------------- shipment */}
      {vehicle.shipmentId ? (
        <section className="flex flex-col gap-3 rounded-[var(--radius-md)] bg-[var(--color-surface)] p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-muted)]">
              <Package className="h-3.5 w-3.5" />
              {t('map.v3.shipment')}
            </span>
            <Chip tone={statusTone(vehicle.shipmentStatus ?? '')}>{statusLabel(vehicle.shipmentStatus)}</Chip>
          </div>
          <Link
            href={shipmentHref(vehicle.shipmentId)}
            className="t-data flex items-center gap-1 text-[14px] text-[var(--color-ink)] hover:underline"
          >
            {vehicle.trackingNumber}
            <ArrowUpRight className="h-3.5 w-3.5 text-[var(--color-muted)]" />
          </Link>
          <Facts
            items={[
              [t('map.v3.destination'), vehicle.destinationName ?? '—'],
              [t('map.v3.eta'), <span key="e" className="t-data">{fmt.dateTime(vehicle.estimatedArrivalAt)}</span>],
            ]}
          />
          <div className="flex items-center justify-between gap-2 text-[13px]">
            <span className="text-[var(--color-muted)]">{t('ship.delayRisk')}</span>
            <span className="flex items-center gap-1.5">
              {riskSeverity && <SeverityIcon severity={riskSeverity} size={14} />}
              <span className="t-data">
                {vehicle.delayProbability === null ? t('common.notComputed') : fmt.pct(vehicle.delayProbability)}
              </span>
            </span>
          </div>
        </section>
      ) : (
        <p className="m-0 text-[12.5px] text-[var(--color-muted)]">{t('map.v3.noShipment')}</p>
      )}

      {replay}

      {/* ----------------------------------------------------------- weather */}
      <section className="flex flex-col gap-1.5">
        <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-muted)]">
          <CloudSun className="h-3.5 w-3.5" />
          {t('map.weatherHere')}
        </span>
        <span className="text-[13px] text-[var(--color-ink)]">
          {weather.data
            ? `${weather.data.condition} · ${fmt.num(weather.data.temperatureC, 0)} °C · ${fmt.num(weather.data.windKmh, 0)} km/h`
            : weather.isError
              ? t('sit.unavailable')
              : t('sit.loading')}
        </span>
        {weather.data && (
          <span className="flex items-center gap-1.5 text-[12px] text-[var(--color-muted)]">
            {weather.data.severity >= 0.5 && (
              <SeverityIcon severity={weather.data.severity >= 0.75 ? 'critical' : 'warning'} size={14} />
            )}
            {t('map.v3.weatherSeverity', { pct: fmt.pct(weather.data.severity) })}
          </span>
        )}
      </section>

      {/* ----------------------------------------------------------- cameras */}
      <section className="flex flex-col gap-1.5">
        <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-muted)]">
          <Cctv className="h-3.5 w-3.5" />
          {t('map.nearestCameras')}
        </span>
        {camera && <CameraViewer camera={camera} onClose={() => setCamera(null)} />}
        {nearbyCameras.data && nearbyCameras.data.cameras.length > 0 ? (
          <ul className="m-0 flex list-none flex-col p-0">
            {nearbyCameras.data.cameras.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setCamera(item)}
                  aria-pressed={camera?.id === item.id}
                  className="flex min-h-8 w-full items-baseline justify-between gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[13px] transition-colors duration-100 hover:bg-[var(--color-surface)]"
                >
                  <span className="truncate">{item.name}</span>
                  <span className="t-data shrink-0 text-[11px] text-[var(--color-muted)]">
                    {fmt.num(item.distanceKm ?? null, 1)} km
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-[12.5px] text-[var(--color-muted)]">
            {nearbyCameras.isLoading ? t('sit.loading') : t('map.noCameras')}
          </span>
        )}
      </section>

      {vehicle.isDemoData && (
        <p className="m-0 border-l-2 border-dashed border-[var(--color-sim)] pl-3 text-[12px] leading-relaxed text-[var(--color-muted)]">
          {t('map.v3.simulatedNote')}
        </p>
      )}
    </div>
  );
}

/**
 * The dead-reckoning estimate in words: how long the GPS has been quiet, where the vehicle
 * probably is, and how sure that is. Deliberately plain: it is a guess and must read as one.
 */
function EstimateNote({ vehicle, estimate }: { vehicle: FleetVehicle; estimate: VehicleEstimate }) {
  const { t } = useI18n();
  const { radius, progress } = describeEstimate(estimate);
  const silence =
    vehicle.gpsSilentMinutes === null || vehicle.gpsSilentMinutes === undefined
      ? t('map.est.neverReported')
      : t('map.est.silentFor', { minutes: String(vehicle.gpsSilentMinutes) });
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-md)] border border-dashed border-[var(--color-line)] px-3 py-2.5">
      <span className="t-label">{t('map.est.title')}</span>
      <span className="text-[12.5px] text-[var(--color-ink)]">
        {estimate.atDestination
          ? t('map.est.atDestination')
          : t('map.est.summary', { radius, progress })}
      </span>
      <span className="text-[12px] text-[var(--color-muted)]">
        {silence} · {t('map.est.assumption', { speed: String(Math.round(estimate.assumedSpeedKmh)) })}
      </span>
    </div>
  );
}
