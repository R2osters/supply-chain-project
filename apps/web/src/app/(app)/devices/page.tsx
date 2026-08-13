'use client';

/**
 * Devices: the operator's side of truck tracking.
 *
 * The screen is organised around the decision an operator actually faces — *which* of the three
 * intake paths to use for a given truck — rather than around the database table. Each kind states
 * its real cost and its real constraint up front, because choosing a €40 hardwired tracker for a
 * subcontractor's van that leaves the fleet next month is the expensive mistake, and choosing a
 * phone for an unattended trailer is the useless one.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, type Paginated } from '@/lib/api';
import { Chip, Empty, ErrorNote, Loading, Panel, statusTone } from '@/components/ui';
import { useFormat, useI18n, type TranslationKey } from '@/lib/i18n';

type DeviceKind = 'PHONE' | 'GT06' | 'TELTONIKA' | 'MANUAL';

interface DeviceRow {
  id: string;
  kind: DeviceKind;
  status: 'PENDING' | 'ONLINE' | 'OFFLINE' | 'DISABLED';
  identifier: string;
  label: string | null;
  reportIntervalSeconds: number;
  lastSeenAt: string | null;
  lastLatitude: number | null;
  lastLongitude: number | null;
  lastBatteryPercent: number | null;
  lastIgnitionOn: boolean | null;
  positionsAccepted: number;
  positionsRejected: number;
  isReportingLate: boolean;
  silentSeconds: number | null;
  vehicle: { id: string; plateNumber: string } | null;
}

interface GatewayStatus {
  listening: boolean;
  port: number;
  protocol: string;
  connectedDevices: number;
  packetsDecoded: number;
  packetsRejected: number;
  positionsStored: number;
  howToPointADevice: string;
}

interface EnrolResult {
  device: DeviceRow;
  pairingSecret: string | null;
  setupInstructions: string[];
}

interface VehicleRow {
  id: string;
  plateNumber: string;
  status: string;
}

const KINDS: DeviceKind[] = ['PHONE', 'GT06', 'TELTONIKA', 'MANUAL'];

export default function DevicesPage() {
  const { t } = useI18n();
  const { relative } = useFormat();
  const queryClient = useQueryClient();

  const [kind, setKind] = useState<DeviceKind>('PHONE');
  const [identifier, setIdentifier] = useState('');
  const [label, setLabel] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [enrolled, setEnrolled] = useState<EnrolResult | null>(null);
  const [copied, setCopied] = useState(false);

  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api<DeviceRow[]>('/devices'),
    // A tracker's health is only meaningful if it is current; the operator is watching for
    // silence, which is exactly the thing a stale cache hides.
    refetchInterval: 15_000,
  });

  const gateway = useQuery({
    queryKey: ['devices', 'gateway'],
    queryFn: () => api<GatewayStatus>('/devices/gateway/status'),
    refetchInterval: 15_000,
  });

  const vehicles = useQuery({
    queryKey: ['vehicles', 'for-devices'],
    queryFn: () => api<Paginated<VehicleRow> | VehicleRow[]>('/vehicles?limit=100'),
  });

  const vehicleList: VehicleRow[] = Array.isArray(vehicles.data)
    ? vehicles.data
    : (vehicles.data?.data ?? []);

  const enrol = useMutation({
    mutationFn: () =>
      api<EnrolResult>('/devices', {
        method: 'POST',
        body: {
          kind,
          identifier: identifier.trim(),
          label: label.trim() || undefined,
          vehicleId: vehicleId || undefined,
        },
      }),
    onSuccess: (result) => {
      setEnrolled(result);
      setIdentifier('');
      setLabel('');
      setVehicleId('');
      setCopied(false);
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });

  const disable = useMutation({
    mutationFn: (id: string) => api<{ success: boolean }>(`/devices/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['devices'] }),
  });

  const driverLink =
    enrolled?.pairingSecret && typeof window !== 'undefined'
      ? `${window.location.origin}/drive?id=${encodeURIComponent(
          enrolled.device.identifier,
        )}&key=${encodeURIComponent(enrolled.pairingSecret)}`
      : null;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold">{t('dev.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--color-ink-dim)]">
          {t('dev.intro')}
        </p>
      </header>

      {/* ------------------------------------------------------------ gateway */}
      {gateway.data && (
        <Panel title={t('dev.gateway')}>
          <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
            <Chip tone={gateway.data.listening ? 'ok' : 'alert'}>
              {gateway.data.listening
                ? t('dev.gatewayUp', { port: gateway.data.port })
                : t('dev.gatewayDown')}
            </Chip>
            <span className="font-mono text-xs text-[var(--color-ink-faint)]">
              {gateway.data.protocol}
            </span>
            <span className="font-mono text-xs text-[var(--color-ink-dim)] tnum">
              {t('dev.gatewayStats', {
                decoded: gateway.data.packetsDecoded,
                stored: gateway.data.positionsStored,
                rejected: gateway.data.packetsRejected,
              })}
            </span>
          </div>
          <p className="border-t border-[var(--color-hairline)] px-3.5 py-2.5 font-mono text-xs text-[var(--color-ink-faint)]">
            {gateway.data.howToPointADevice}
          </p>
        </Panel>
      )}

      {/* ------------------------------------------------------------- enrol */}
      <Panel title={t('dev.enrol')}>
        <div className="grid gap-px bg-[var(--color-hairline)] sm:grid-cols-2 lg:grid-cols-4">
          {KINDS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setKind(option)}
              className={`p-3.5 text-left transition ${
                kind === option
                  ? 'bg-[var(--color-panel-raised)] ring-1 ring-inset ring-[var(--color-signal)]'
                  : 'bg-[var(--color-panel)] hover:bg-[var(--color-panel-raised)]'
              }`}
            >
              <span className="block text-sm font-medium">
                {t(`dev.kind.${option}` as TranslationKey)}
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-[var(--color-ink-faint)]">
                {t(`dev.kindHint.${option}` as TranslationKey)}
              </span>
            </button>
          ))}
        </div>

        <form
          className="grid gap-3 border-t border-[var(--color-hairline)] p-3.5 md:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (identifier.trim()) enrol.mutate();
          }}
        >
          <Field label={t('dev.identifier')} hint={t('dev.identifierHint')}>
            <input
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder={kind === 'GT06' ? '860123456789012' : 'kwame-phone-01'}
              className="h-9 w-full border border-[var(--color-hairline)] bg-[var(--color-deck)] px-2 font-mono text-sm outline-none focus:border-[var(--color-signal)]"
            />
          </Field>

          <Field label={t('dev.label')} hint={t('dev.labelHint')}>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              className="h-9 w-full border border-[var(--color-hairline)] bg-[var(--color-deck)] px-2 text-sm outline-none focus:border-[var(--color-signal)]"
            />
          </Field>

          <Field label={t('dev.pickVehicle')}>
            <select
              value={vehicleId}
              onChange={(event) => setVehicleId(event.target.value)}
              className="h-9 w-full border border-[var(--color-hairline)] bg-[var(--color-deck)] px-2 font-mono text-sm outline-none focus:border-[var(--color-signal)]"
            >
              <option value="">— {t('dev.unbound')} —</option>
              {vehicleList.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.plateNumber}
                </option>
              ))}
            </select>
          </Field>

          <div className="flex items-end">
            <button
              type="submit"
              disabled={enrol.isPending || !identifier.trim()}
              className="h-9 w-full bg-[var(--color-signal)] text-xs font-semibold tracking-wide text-[var(--color-void)] uppercase disabled:opacity-40"
            >
              {enrol.isPending ? t('dev.enrolling') : t('dev.enrol')}
            </button>
          </div>
        </form>

        {enrol.error && (
          <div className="px-3.5 pb-3.5">
            <ErrorNote error={enrol.error as ApiError} />
          </div>
        )}

        {enrolled && (
          <div className="border-t border-[var(--color-signal-dim)] bg-[var(--color-signal-dim)]/20 p-3.5">
            <p className="font-mono text-[0.5625rem] tracking-[0.16em] text-[var(--color-signal)] uppercase">
              {t('dev.setup')} · {enrolled.device.identifier}
            </p>

            <ol className="mt-2 space-y-1 text-sm leading-relaxed text-[var(--color-ink-dim)]">
              {enrolled.setupInstructions.map((line, index) => (
                <li key={line} className="flex gap-2">
                  <span className="font-mono text-[var(--color-ink-faint)]">{index + 1}.</span>
                  <span>{line}</span>
                </li>
              ))}
            </ol>

            {driverLink && (
              <div className="mt-3 border-t border-[var(--color-hairline)] pt-3">
                <p className="text-xs leading-relaxed text-[var(--color-warn)]">
                  {t('dev.secretOnce')}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="max-w-full flex-1 overflow-x-auto border border-[var(--color-hairline)] bg-[var(--color-void)] px-2 py-1.5 font-mono text-xs break-all">
                    {driverLink}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(driverLink).then(() => setCopied(true));
                    }}
                    className="h-8 shrink-0 border border-[var(--color-hairline-bright)] px-3 text-xs"
                  >
                    {copied ? t('dev.copied') : t('dev.copyLink')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </Panel>

      {/* -------------------------------------------------------------- list */}
      <Panel title={t('dev.title')} loading={devices.isFetching}>
        {devices.isLoading ? (
          <Loading />
        ) : devices.error ? (
          <ErrorNote error={devices.error} />
        ) : !devices.data || devices.data.length === 0 ? (
          <Empty title={t('dev.none')} hint={t('dev.noneHint')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-hairline)] text-left font-mono text-[0.5625rem] tracking-[0.16em] text-[var(--color-ink-faint)] uppercase">
                  <th className="px-3.5 py-2">{t('dev.kind')}</th>
                  <th className="px-3.5 py-2">{t('dev.identifier')}</th>
                  <th className="px-3.5 py-2">{t('dev.vehicle')}</th>
                  <th className="px-3.5 py-2">{t('dev.status')}</th>
                  <th className="px-3.5 py-2">{t('dev.lastSeen')}</th>
                  <th className="px-3.5 py-2 text-right">{t('dev.accepted')}</th>
                  <th className="px-3.5 py-2 text-right">{t('dev.rejected')}</th>
                  <th className="px-3.5 py-2 text-right">{t('dev.battery')}</th>
                  <th className="px-3.5 py-2" />
                </tr>
              </thead>
              <tbody>
                {devices.data.map((device) => (
                  <tr
                    key={device.id}
                    className="border-b border-[var(--color-hairline)] last:border-0"
                  >
                    <td className="px-3.5 py-2.5 whitespace-nowrap">
                      {t(`dev.kind.${device.kind}` as TranslationKey)}
                      {device.label && (
                        <span className="ml-2 text-xs text-[var(--color-ink-faint)]">
                          {device.label}
                        </span>
                      )}
                    </td>
                    <td className="px-3.5 py-2.5 font-mono text-xs">{device.identifier}</td>
                    <td className="px-3.5 py-2.5 font-mono text-xs">
                      {device.vehicle?.plateNumber ?? (
                        <span className="text-[var(--color-ink-faint)]">{t('dev.unbound')}</span>
                      )}
                    </td>
                    <td className="px-3.5 py-2.5">
                      <Chip tone={statusTone(device.status)}>{device.status}</Chip>
                    </td>
                    <td className="px-3.5 py-2.5 text-xs whitespace-nowrap">
                      {device.lastSeenAt ? (
                        <span
                          className={
                            device.isReportingLate
                              ? 'text-[var(--color-warn)]'
                              : 'text-[var(--color-ink-dim)]'
                          }
                        >
                          {relative(device.lastSeenAt)}
                          {device.isReportingLate && ` · ${t('dev.late')}`}
                        </span>
                      ) : (
                        <span className="text-[var(--color-ink-faint)]">—</span>
                      )}
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-mono text-xs tnum">
                      {device.positionsAccepted}
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-mono text-xs tnum">
                      <span
                        className={
                          device.positionsRejected > 0
                            ? 'text-[var(--color-warn)]'
                            : 'text-[var(--color-ink-faint)]'
                        }
                      >
                        {device.positionsRejected}
                      </span>
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-mono text-xs tnum">
                      {device.lastBatteryPercent == null ? (
                        <span className="text-[var(--color-ink-faint)]">—</span>
                      ) : (
                        <span
                          className={
                            device.lastBatteryPercent < 20 ? 'text-[var(--color-alert)]' : ''
                          }
                        >
                          {device.lastBatteryPercent}%
                        </span>
                      )}
                    </td>
                    <td className="px-3.5 py-2.5 text-right">
                      {device.status !== 'DISABLED' && (
                        <button
                          type="button"
                          onClick={() => disable.mutate(device.id)}
                          disabled={disable.isPending}
                          className="text-xs text-[var(--color-ink-faint)] underline underline-offset-4 hover:text-[var(--color-alert)]"
                        >
                          {t('dev.disable')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[0.5625rem] tracking-[0.16em] text-[var(--color-ink-faint)] uppercase">
        {label}
      </span>
      {children}
      {hint && <span className="text-[0.6875rem] text-[var(--color-ink-faint)]">{hint}</span>}
    </label>
  );
}
