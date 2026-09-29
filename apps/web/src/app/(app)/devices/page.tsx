'use client';

/**
 * Devices (charte 08 · TRACK · Balises): « Les données de position sont-elles fiables ? »
 *
 * The screen answers that question first — which trackers are silent, which are reporting late
 * (the usual sign of a weak mobile network), whose battery is about to die, and whether the
 * hardware gateway is taking packets — and only then offers enrolment.
 *
 * Enrolment is organised around the decision an operator actually faces — *which* of the intake
 * paths to use for a given truck — rather than around the database table. Each kind states its
 * real cost and its real constraint up front, because choosing a €40 hardwired tracker for a
 * subcontractor's van that leaves the fleet next month is the expensive mistake, and choosing a
 * phone for an unattended trailer is the useless one.
 */

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  BatteryLow,
  Check,
  Copy,
  Cpu,
  Hand,
  PackageX,
  Plus,
  Radio,
  RadioTower,
  Server,
  Smartphone,
  Wifi,
  WifiLow,
  WifiOff,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  Banner,
  Button,
  Empty,
  ErrorNote,
  Kpi,
  Loading,
  PageHeader,
  Panel,
  Provenance,
  SeverityIcon,
  type Severity,
} from '@/components/ui';
import { useToast } from '@/components/toast';
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

const KIND_ICON: Record<DeviceKind, LucideIcon> = {
  PHONE: Smartphone,
  GT06: Radio,
  TELTONIKA: Cpu,
  MANUAL: Hand,
};

/** Below this a phone or tracker is likely to die before the end of a run. */
const LOW_BATTERY = 20;
/** Devices and gateway are polled at this interval; the provenance marker says so. */
const POLL_SECONDS = 15;

type Health = 'disabled' | 'offline' | 'weak' | 'lowBattery' | 'pending' | 'ok';

/**
 * One reading of a device's trustworthiness, worst first. "Weak network" is inferred, not
 * measured: the API reports no signal strength, but a device still online that has missed three
 * of its own reporting intervals is, on the routes this serves, almost always out of coverage.
 */
function healthOf(device: DeviceRow): Health {
  if (device.status === 'DISABLED') return 'disabled';
  if (device.status === 'OFFLINE') return 'offline';
  if (device.isReportingLate) return 'weak';
  if (device.lastBatteryPercent !== null && device.lastBatteryPercent < LOW_BATTERY) return 'lowBattery';
  if (device.status === 'PENDING' || !device.lastSeenAt) return 'pending';
  return 'ok';
}

const HEALTH_SEVERITY: Record<Health, Severity | null> = {
  disabled: null,
  offline: 'critical',
  weak: 'warning',
  lowBattery: 'warning',
  pending: 'info',
  ok: null,
};

const STATUS_KEY: Record<DeviceRow['status'], TranslationKey> = {
  PENDING: 'dev.v3.status.PENDING',
  ONLINE: 'dev.v3.status.ONLINE',
  OFFLINE: 'dev.v3.status.OFFLINE',
  DISABLED: 'dev.v3.status.DISABLED',
};

export default function DevicesPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [enrolled, setEnrolled] = useState<EnrolResult | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api<DeviceRow[]>('/devices'),
    // A tracker's health is only meaningful if it is current; the operator is watching for
    // silence, which is exactly the thing a stale cache hides.
    refetchInterval: POLL_SECONDS * 1000,
  });

  const gateway = useQuery({
    queryKey: ['devices', 'gateway'],
    queryFn: () => api<GatewayStatus>('/devices/gateway/status'),
    refetchInterval: POLL_SECONDS * 1000,
  });

  const disable = useMutation({
    mutationFn: (device: DeviceRow) => api<{ success: boolean }>(`/devices/${device.id}`, { method: 'DELETE' }),
    onSuccess: (_result, device) => {
      setConfirming(null);
      toast.show({ tone: 'success', message: t('dev.v3.disabled', { id: device.identifier }) });
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (error) => toast.show({ tone: 'error', message: error instanceof Error ? error.message : String(error) }),
  });

  /* -------------------------------------------------------------- derived */

  const list = devices.data ?? [];
  const active = list.filter((device) => device.status !== 'DISABLED');
  const healths = new Map(list.map((device) => [device.id, healthOf(device)]));
  const offline = active.filter((device) => healths.get(device.id) === 'offline').length;
  const weak = active.filter((device) => healths.get(device.id) === 'weak').length;
  const online = active.filter((device) => device.status === 'ONLINE' && !device.isReportingLate).length;
  const lowBattery = active.filter(
    (device) => device.lastBatteryPercent !== null && device.lastBatteryPercent < LOW_BATTERY,
  ).length;
  const rejectedPositions = list.reduce((sum, device) => sum + device.positionsRejected, 0);

  const title = devices.isLoading
    ? t('dev.title')
    : active.length === 0
      ? t('dev.v3.title.none')
      : offline > 0
        ? t(offline === 1 ? 'dev.v3.title.offlineOne' : 'dev.v3.title.offlineMany', { n: offline, total: active.length })
        : weak + lowBattery > 0
          ? t('dev.v3.title.watch', { n: weak + lowBattery, total: active.length })
          : t('dev.v3.title.ok', { total: active.length });

  // Rows whose last signal moved since the previous poll flash once, so a device coming back is seen.
  const previous = useRef(new Map<string, string | null>());
  const changed = new Set(
    list
      .filter((device) => previous.current.has(device.id) && previous.current.get(device.id) !== device.lastSeenAt)
      .map((device) => device.id),
  );
  useEffect(() => {
    previous.current = new Map(list.map((device) => [device.id, device.lastSeenAt]));
  });

  const devicesProvenance = devices.isError ? (
    <Provenance kind={devices.data ? 'stale' : 'offline'} label={devices.data ? `${t('prov.stale')} · ${fmt.relative(new Date(devices.dataUpdatedAt))}` : undefined} />
  ) : (
    <Provenance kind="poll" seconds={POLL_SECONDS} />
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={t('dev.v3.kicker')}
        title={title}
        description={t('dev.v3.question')}
        meta={devicesProvenance}
        actions={
          can('vehicle:create') ? (
            <Button variant="primary" icon={Plus} onClick={() => setDrawerOpen(true)}>
              {t('dev.v3.enrolAction')}
            </Button>
          ) : undefined
        }
      />

      {/* The pairing secret is shown once; if the drawer was closed on it, keep a way back. */}
      {enrolled && !drawerOpen && (
        <Banner
          tone="warn"
          icon={Smartphone}
          title={t('dev.v3.pendingSetup', { id: enrolled.device.identifier })}
          actions={
            <>
              <Button size="sm" onClick={() => setDrawerOpen(true)}>
                {t('dev.v3.showSetup')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEnrolled(null)}>
                {t('dev.v3.done')}
              </Button>
            </>
          }
        >
          {t('dev.secretOnce')}
        </Banner>
      )}

      {/* ---------------------------------------------------------------- KPIs */}
      <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi
          icon={Wifi}
          label={t('dev.v3.kpi.online')}
          value={devices.data ? fmt.int(online) : '—'}
          sub={devices.data ? t('dev.v3.kpi.ofTotal', { total: active.length }) : undefined}
          source={t('dev.v3.kpi.source', { s: POLL_SECONDS })}
        />
        <Kpi
          icon={WifiOff}
          label={t('dev.v3.kpi.offline')}
          value={devices.data ? fmt.int(offline) : '—'}
          tone={offline > 0 ? 'alert' : 'neutral'}
          sub={weak > 0 ? t('dev.v3.kpi.weak', { n: weak }) : undefined}
          source={t('dev.v3.kpi.source', { s: POLL_SECONDS })}
        />
        <Kpi
          icon={BatteryLow}
          label={t('dev.v3.kpi.lowBattery')}
          value={devices.data ? fmt.int(lowBattery) : '—'}
          tone={lowBattery > 0 ? 'warn' : 'neutral'}
          sub={t('dev.v3.kpi.lowBatteryHint', { pct: LOW_BATTERY })}
          source={t('dev.v3.kpi.source', { s: POLL_SECONDS })}
        />
        <Kpi
          icon={PackageX}
          label={t('dev.v3.kpi.rejected')}
          value={gateway.data ? fmt.int(gateway.data.packetsRejected) : '—'}
          sub={devices.data ? t('dev.v3.kpi.rejectedPositions', { n: fmt.int(rejectedPositions) }) : undefined}
          source={t('dev.v3.kpi.gatewaySource', { s: POLL_SECONDS })}
        />
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        {/* ------------------------------------------------------------- table */}
        <Panel
          icon={RadioTower}
          title={t('dev.title')}
          meta={devices.data ? <span className="pill-count">{fmt.int(list.length)}</span> : undefined}
          loading={devices.isFetching && !devices.isLoading}
        >
          {devices.isLoading ? (
            <Loading rows={5} />
          ) : devices.error && !devices.data ? (
            <ErrorNote error={devices.error} onRetry={() => void devices.refetch()} />
          ) : list.length === 0 ? (
            <Empty
              icon={RadioTower}
              title={t('dev.none')}
              hint={t('dev.noneHint')}
              action={
                can('vehicle:create') ? (
                  <Button variant="primary" icon={Plus} onClick={() => setDrawerOpen(true)}>
                    {t('dev.v3.enrolAction')}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto pb-2 pt-2">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th aria-label={t('dev.v3.col.health')} className="w-[36px]" />
                    <th>{t('dev.kind')}</th>
                    <th>{t('dev.identifier')}</th>
                    <th>{t('dev.vehicle')}</th>
                    <th>{t('dev.status')}</th>
                    <th>{t('dev.lastSeen')}</th>
                    <th className="text-right">{t('dev.accepted')}</th>
                    <th className="text-right">{t('dev.rejected')}</th>
                    <th className="text-right">{t('dev.battery')}</th>
                    <th>
                      <span className="sr-only">{t('dev.v3.col.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((device) => {
                    const health = healths.get(device.id) ?? 'ok';
                    const severity = HEALTH_SEVERITY[health];
                    const KindIcon = KIND_ICON[device.kind];
                    const muted = device.status === 'DISABLED';
                    return (
                      <tr
                        key={device.id}
                        className={`${changed.has(device.id) ? 'flash' : ''} ${muted ? 'opacity-60' : ''}`}
                      >
                        <td>{severity && <SeverityIcon severity={severity} size={14} />}</td>
                        <td className="whitespace-nowrap">
                          <span className="flex items-center gap-2">
                            <KindIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted)]" />
                            {t(`dev.kind.${device.kind}` as TranslationKey)}
                          </span>
                          {device.label && (
                            <span className="mt-0.5 block text-[12px] text-[var(--color-muted)]">{device.label}</span>
                          )}
                        </td>
                        <td className="t-data text-[12px]">{device.identifier}</td>
                        <td className="t-data text-[12px]">
                          {device.vehicle?.plateNumber ?? (
                            <span className="font-sans text-[var(--color-dim)]">{t('dev.unbound')}</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap">
                          <StatusCell device={device} health={health} />
                        </td>
                        <td className="whitespace-nowrap text-[12.5px]">
                          {device.lastSeenAt ? (
                            <span className="flex flex-col">
                              <span className="t-data text-[12px]">{fmt.relative(device.lastSeenAt)}</span>
                              {device.isReportingLate && (
                                <span className="text-[11px] text-[var(--color-muted)]">{t('dev.late')}</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-[var(--color-dim)]">{t('dev.v3.neverSeen')}</span>
                          )}
                        </td>
                        <td className="t-data text-right text-[12px]">{fmt.int(device.positionsAccepted)}</td>
                        <td className="t-data text-right text-[12px]">
                          <span className={device.positionsRejected > 0 ? '' : 'text-[var(--color-dim)]'}>
                            {fmt.int(device.positionsRejected)}
                          </span>
                        </td>
                        <td className="t-data text-right text-[12px]">
                          {device.lastBatteryPercent == null ? (
                            <span className="text-[var(--color-dim)]">—</span>
                          ) : (
                            <span className="inline-flex items-center justify-end gap-1.5">
                              {device.lastBatteryPercent < LOW_BATTERY && (
                                <BatteryLow
                                  className="h-3.5 w-3.5"
                                  style={{ color: 'var(--color-warn)' }}
                                  aria-label={t('dev.v3.health.lowBattery')}
                                />
                              )}
                              {device.lastBatteryPercent}%
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap text-right">
                          {device.status !== 'DISABLED' && can('vehicle:delete') && (
                            confirming === device.id ? (
                              // No re-enable endpoint exists, so this cannot be an Undo toast:
                              // disabling unbinds the device and it would have to be re-enrolled.
                              <span className="fade-in inline-flex items-center gap-1.5">
                                <span className="hidden text-[12px] text-[var(--color-muted)] 2xl:inline">
                                  {t('dev.v3.disableConfirm')}
                                </span>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  loading={disable.isPending}
                                  onClick={() => disable.mutate(device)}
                                  title={t('dev.v3.disableConfirm')}
                                >
                                  {t('dev.v3.disableYes')}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                                  {t('common.cancel')}
                                </Button>
                              </span>
                            ) : (
                              <Button size="sm" variant="ghost" onClick={() => setConfirming(device.id)}>
                                {t('dev.disable')}
                              </Button>
                            )
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* ----------------------------------------------------------- gateway */}
        <GatewayPanel gateway={gateway} />
      </div>

      {drawerOpen && (
        <EnrolDrawer
          enrolled={enrolled}
          onEnrolled={(result) => {
            setEnrolled(result);
            toast.show({ tone: 'success', message: t('dev.v3.enrolled', { id: result.device.identifier }) });
            void queryClient.invalidateQueries({ queryKey: ['devices'] });
          }}
          onReset={() => setEnrolled(null)}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </div>
  );
}

/* ================================================================ status cell */

function StatusCell({ device, health }: { device: DeviceRow; health: Health }) {
  const { t } = useI18n();
  const icon =
    health === 'offline' ? (
      <WifiOff className="h-3.5 w-3.5" style={{ color: 'var(--color-crit)' }} aria-hidden />
    ) : health === 'weak' ? (
      <WifiLow className="h-3.5 w-3.5" style={{ color: 'var(--color-warn)' }} aria-hidden />
    ) : null;
  return (
    <span className="flex flex-col">
      <span className="flex items-center gap-1.5 text-[13px]">
        {icon}
        {t(STATUS_KEY[device.status])}
      </span>
      {(health === 'weak' || health === 'offline') && (
        <span className="text-[11px] text-[var(--color-muted)]">{t(`dev.v3.health.${health}` as TranslationKey)}</span>
      )}
    </span>
  );
}

/* ================================================================== gateway */

function GatewayPanel({ gateway }: { gateway: UseQueryResult<GatewayStatus> }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const [copied, setCopied] = useState(false);
  const data = gateway.data;

  return (
    <Panel
      icon={Server}
      title={t('dev.gateway')}
      meta={
        gateway.isError ? (
          <Provenance kind={data ? 'stale' : 'offline'} />
        ) : data ? (
          <Provenance kind="poll" seconds={POLL_SECONDS} />
        ) : undefined
      }
      loading={gateway.isFetching && !gateway.isLoading}
    >
      {gateway.isLoading ? (
        <Loading rows={3} />
      ) : !data ? (
        <ErrorNote error={gateway.error ?? t('sit.unavailable')} onRetry={() => void gateway.refetch()} />
      ) : (
        <div className="flex flex-col gap-4 px-5 pb-5 pt-2">
          <span className="flex items-center gap-2 text-[14px]">
            {data.listening ? (
              <Wifi className="h-4 w-4 text-[var(--color-muted)]" aria-hidden />
            ) : (
              <SeverityIcon severity="critical" />
            )}
            {data.listening ? t('dev.gatewayUp', { port: data.port }) : t('dev.gatewayDown')}
          </span>

          <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3">
            <GatewayFact label={t('dev.v3.gw.protocol')} value={data.protocol} />
            <GatewayFact label={t('dev.v3.gw.connected')} value={fmt.int(data.connectedDevices)} />
            <GatewayFact label={t('dev.v3.gw.decoded')} value={fmt.int(data.packetsDecoded)} />
            <GatewayFact label={t('dev.v3.gw.stored')} value={fmt.int(data.positionsStored)} />
            <GatewayFact
              label={t('dev.v3.gw.rejected')}
              value={
                <span className="inline-flex items-center gap-1.5">
                  {data.packetsRejected > 0 && <SeverityIcon severity="warning" size={14} />}
                  {fmt.int(data.packetsRejected)}
                </span>
              }
            />
          </dl>
          <p className="sr-only">
            {t('dev.gatewayStats', {
              decoded: data.packetsDecoded,
              stored: data.positionsStored,
              rejected: data.packetsRejected,
            })}
          </p>

          <div className="tile flex flex-col gap-2 p-3">
            <span className="flex items-center justify-between gap-2">
              <span className="t-label">{t('dev.v3.gw.howTo')}</span>
              <Button
                size="sm"
                variant="ghost"
                icon={copied ? Check : Copy}
                onClick={() => void navigator.clipboard.writeText(data.howToPointADevice).then(() => setCopied(true))}
              >
                {copied ? t('dev.copied') : t('dev.v3.copy')}
              </Button>
            </span>
            <p className="t-data m-0 break-words text-[12px] leading-relaxed text-[var(--color-ink)]">
              {data.howToPointADevice}
            </p>
          </div>
        </div>
      )}
    </Panel>
  );
}

function GatewayFact({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[12px] text-[var(--color-muted)]">{label}</dt>
      <dd className="t-data m-0 truncate text-[13px] text-[var(--color-ink)]">{value}</dd>
    </div>
  );
}

/* ============================================================= enrol drawer */

function EnrolDrawer({
  enrolled,
  onEnrolled,
  onReset,
  onClose,
}: {
  enrolled: EnrolResult | null;
  onEnrolled(result: EnrolResult): void;
  onReset(): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<DeviceKind>('PHONE');
  const [identifier, setIdentifier] = useState('');
  const [label, setLabel] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const firstField = useRef<HTMLInputElement | null>(null);

  const vehicles = useQuery({
    queryKey: ['vehicles', 'for-devices'],
    queryFn: () => api<Paginated<VehicleRow> | VehicleRow[]>('/vehicles?limit=100'),
  });
  const vehicleList: VehicleRow[] = Array.isArray(vehicles.data) ? vehicles.data : (vehicles.data?.data ?? []);

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
      setIdentifier('');
      setLabel('');
      setVehicleId('');
      onEnrolled(result);
    },
  });

  useEffect(() => {
    if (!enrolled) firstField.current?.focus();
  }, [enrolled]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40" role="presentation">
      <div className="fade-in absolute inset-0 bg-[color-mix(in_srgb,var(--color-ink)_28%,transparent)]" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="enrol-title"
        className="slide-in-right absolute inset-y-0 right-0 flex w-full max-w-[600px] flex-col overflow-y-auto bg-[var(--color-surface)] shadow-[var(--shadow-lg)]"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-2 pt-6">
          <div className="flex flex-col gap-1">
            <span className="t-label">{t('dev.v3.kicker')}</span>
            <h2 id="enrol-title" className="t-h2 m-0">
              {enrolled ? t('dev.v3.setupTitle', { id: enrolled.device.identifier }) : t('dev.v3.enrolAction')}
            </h2>
          </div>
          <Button variant="ghost" icon={X} onClick={onClose} aria-label={t('common.close')} />
        </header>

        {enrolled ? (
          <SetupView enrolled={enrolled} onAnother={onReset} onDone={() => { onReset(); onClose(); }} />
        ) : (
          <div className="flex flex-col gap-6 px-6 pb-8 pt-2">
            <p className="m-0 text-[13.5px] leading-relaxed text-[var(--color-muted)]">{t('dev.intro')}</p>

            <fieldset className="m-0 border-0 p-0">
              <legend className="t-label mb-2 p-0">{t('dev.kind')}</legend>
              <div className="stagger grid gap-2 sm:grid-cols-2">
                {KINDS.map((option) => {
                  const Icon = KIND_ICON[option];
                  const selected = kind === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setKind(option)}
                      aria-pressed={selected}
                      className={`tile lift flex flex-col gap-1.5 p-4 text-left transition-shadow duration-150 ${
                        selected ? 'shadow-[inset_0_0_0_2px_var(--color-accent)]' : 'hover:shadow-[inset_0_0_0_1px_var(--color-line)]'
                      }`}
                    >
                      <span className="flex items-center gap-2 text-[14px] font-medium">
                        <Icon className="h-4 w-4 text-[var(--color-muted)]" />
                        {t(`dev.kind.${option}` as TranslationKey)}
                        {selected && <Check className="pop ml-auto h-4 w-4" />}
                      </span>
                      <span className="text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                        {t(`dev.kindHint.${option}` as TranslationKey)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (identifier.trim()) enrol.mutate();
              }}
            >
              <Field label={t('dev.identifier')} hint={t('dev.identifierHint')}>
                <input
                  ref={firstField}
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  placeholder={kind === 'GT06' || kind === 'TELTONIKA' ? '860123456789012' : 'kwame-phone-01'}
                  inputMode={kind === 'GT06' || kind === 'TELTONIKA' ? 'numeric' : undefined}
                  className="field t-data"
                  autoComplete="off"
                />
              </Field>

              <Field label={t('dev.label')} hint={t('dev.labelHint')}>
                <input value={label} onChange={(event) => setLabel(event.target.value)} className="field" />
              </Field>

              <Field label={t('dev.pickVehicle')}>
                <select value={vehicleId} onChange={(event) => setVehicleId(event.target.value)} className="field t-data">
                  <option value="">— {t('dev.unbound')} —</option>
                  {vehicleList.map((vehicle) => (
                    <option key={vehicle.id} value={vehicle.id}>
                      {vehicle.plateNumber}
                    </option>
                  ))}
                </select>
              </Field>

              {enrol.error && <ErrorNote error={enrol.error as ApiError} />}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  icon={Plus}
                  loading={enrol.isPending}
                  disabled={!identifier.trim()}
                >
                  {enrol.isPending ? t('dev.enrolling') : t('dev.enrol')}
                </Button>
                <Button variant="ghost" onClick={onClose}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          </div>
        )}
      </aside>
    </div>
  );
}

/** The one-time view after enrolment: setup steps and, for a phone, the secret and driver link. */
function SetupView({
  enrolled,
  onAnother,
  onDone,
}: {
  enrolled: EnrolResult;
  onAnother(): void;
  onDone(): void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<string | null>(null);

  const driverLink =
    enrolled.pairingSecret && typeof window !== 'undefined'
      ? `${window.location.origin}/drive?id=${encodeURIComponent(
          enrolled.device.identifier,
        )}&key=${encodeURIComponent(enrolled.pairingSecret)}`
      : null;

  const copy = (key: string, value: string): void => {
    void navigator.clipboard.writeText(value).then(() => setCopied(key));
  };

  const rows: Array<{ key: string; label: string; value: string }> = [
    { key: 'id', label: t('dev.identifier'), value: enrolled.device.identifier },
    ...(enrolled.pairingSecret ? [{ key: 'secret', label: t('dev.v3.secret'), value: enrolled.pairingSecret }] : []),
    ...(driverLink ? [{ key: 'link', label: t('dev.v3.driverLink'), value: driverLink }] : []),
  ];

  return (
    <div className="fade-in flex flex-col gap-6 px-6 pb-8 pt-2">
      <section className="flex flex-col gap-2">
        <h3 className="t-label m-0">{t('dev.setup')}</h3>
        <ol className="stagger m-0 flex list-none flex-col gap-2 p-0">
          {enrolled.setupInstructions.map((line, index) => (
            <li key={line} className="flex gap-3 text-[13.5px] leading-relaxed">
              <span className="t-data flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-2)] text-[11px]">
                {index + 1}
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ol>
      </section>

      {enrolled.pairingSecret && (
        <Banner tone="warn" icon={Smartphone} title={t('dev.v3.secretTitle')}>
          {t('dev.secretOnce')}
        </Banner>
      )}

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map((row) => (
          <li key={row.key} className="tile flex flex-col gap-1.5 p-3">
            <span className="flex items-center justify-between gap-2">
              <span className="t-label">{row.label}</span>
              <Button
                size="sm"
                variant={row.key === 'link' ? 'secondary' : 'ghost'}
                icon={copied === row.key ? Check : Copy}
                onClick={() => copy(row.key, row.value)}
              >
                {copied === row.key ? t('dev.copied') : row.key === 'link' ? t('dev.copyLink') : t('dev.v3.copy')}
              </Button>
            </span>
            <code className="t-data block break-all text-[12px] leading-relaxed text-[var(--color-ink)]">{row.value}</code>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon={Check} onClick={onDone}>
          {t('dev.v3.done')}
        </Button>
        <Button icon={Plus} onClick={onAnother}>
          {t('dev.v3.another')}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-[var(--color-ink)]">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-[var(--color-muted)]">{hint}</span>}
    </label>
  );
}
