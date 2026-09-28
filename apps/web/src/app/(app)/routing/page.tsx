'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Explanation, type Paginated } from '@/lib/api';
import { Chip, Empty, ErrorNote, Explain, Loading, Panel, fmt } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

interface WarehouseRow {
  id: string;
  code: string;
  name: string;
}
interface CustomerRow {
  id: string;
  code: string;
  name: string;
  city: string | null;
  latitude: number | null;
}
interface VehicleRow {
  id: string;
  plateNumber: string;
  label: string | null;
  capacityUnits: string;
  status: string;
}

interface RouteStep {
  id: string;
  name: string;
  arrivalMinutes: number;
  loadAfter: number;
}
interface RoutePlan {
  vehicleId: string;
  vehicleName: string;
  sequence: RouteStep[];
  distanceKm: number;
  durationMinutes: number;
  loadUnits: number;
  fuelLiters: number;
  cost: number;
}
interface RoutingResponse {
  status: string;
  routes: RoutePlan[];
  unassignedStops: string[];
  totalDistanceKm: number;
  totalDurationMinutes: number;
  totalCost: number;
  constraints: string[];
  solverWallTimeMs: number;
  explanation: Explanation;
}

export default function RoutingPage() {
  const { t } = useI18n();
  const [warehouseId, setWarehouseId] = useState('');
  const [customerIds, setCustomerIds] = useState<string[]>([]);
  const [vehicleIds, setVehicleIds] = useState<string[]>([]);

  const warehouses = useQuery({
    queryKey: ['warehouses', 'routing'],
    queryFn: () => api<Paginated<WarehouseRow>>('/warehouses?limit=50'),
  });
  const customers = useQuery({
    queryKey: ['customers', 'routing'],
    queryFn: () => api<Paginated<CustomerRow>>('/customers?limit=100'),
  });
  const vehicles = useQuery({
    queryKey: ['vehicles', 'routing'],
    queryFn: () => api<Paginated<VehicleRow>>('/vehicles?limit=50'),
  });

  const optimise = useMutation({
    mutationFn: () =>
      api<RoutingResponse>('/ai/route/optimize', {
        method: 'POST',
        body: {
          warehouseId,
          customerIds,
          ...(vehicleIds.length ? { vehicleIds } : {}),
        },
      }),
  });

  const data = optimise.data;
  const routable = (customers.data?.data ?? []).filter((customer) => customer.latitude !== null);

  function toggle(list: string[], id: string, set: (value: string[]) => void) {
    set(list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id]);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">{t('rt.title')}</h1>
        <p className="mt-0.5 max-w-3xl text-[0.8125rem] leading-relaxed text-[var(--color-ink-dim)]">
          {t('rt.intro')}
        </p>
      </div>

      <Panel title={t('rt.inputs')}>
        <div className="grid gap-4 p-3.5 lg:grid-cols-3">
          <div>
            <Legend>{t('rt.depot')}</Legend>
            <select className="field" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">{t('rt.selectWarehouse')}</option>
              {warehouses.data?.data.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {warehouse.code} — {warehouse.name}
                </option>
              ))}
            </select>

            <div className="mt-3 flex gap-2">
              <button
                className="btn btn-primary flex-1"
                disabled={!warehouseId || customerIds.length === 0 || optimise.isPending}
                onClick={() => optimise.mutate()}
              >
                {optimise.isPending ? t('rt.searching') : t('rt.plan')}
              </button>
              <button className="btn" onClick={() => setCustomerIds(routable.map((c) => c.id))}>
                {t('rt.allStops')}
              </button>
            </div>
          </div>

          <div>
            <Legend>
              {t('rt.stopsSelected', { n: customerIds.length })}
              {customers.data && routable.length < customers.data.data.length && (
                <span className="ml-1 normal-case tracking-normal text-[var(--color-warn)]">
                  {t('rt.hiddenNoCoords', {
                    n: customers.data.data.length - routable.length,
                  })}
                </span>
              )}
            </Legend>
            <div className="max-h-56 overflow-y-auto border border-[var(--color-hairline)]">
              {routable.map((customer) => (
                <label
                  key={customer.id}
                  className="flex cursor-pointer items-center gap-2 px-2.5 py-1 hover:bg-[color-mix(in_srgb,var(--color-signal)_5%,transparent)]"
                >
                  <input
                    type="checkbox"
                    className="accent-[var(--color-signal)]"
                    checked={customerIds.includes(customer.id)}
                    onChange={() => toggle(customerIds, customer.id, setCustomerIds)}
                  />
                  <span className="truncate text-[0.75rem]">{customer.name}</span>
                  <span className="ml-auto shrink-0 font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
                    {customer.city}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <Legend>
              {t('rt.vehicles', {
                what: vehicleIds.length
                  ? t('rt.vehiclesSelected', { n: vehicleIds.length })
                  : t('rt.allAvailable'),
              })}
            </Legend>
            <div className="max-h-56 overflow-y-auto border border-[var(--color-hairline)]">
              {vehicles.data?.data.map((vehicle) => (
                <label
                  key={vehicle.id}
                  className="flex cursor-pointer items-center gap-2 px-2.5 py-1 hover:bg-[color-mix(in_srgb,var(--color-signal)_5%,transparent)]"
                >
                  <input
                    type="checkbox"
                    className="accent-[var(--color-signal)]"
                    checked={vehicleIds.includes(vehicle.id)}
                    onChange={() => toggle(vehicleIds, vehicle.id, setVehicleIds)}
                  />
                  <span className="font-mono text-[0.6875rem]">{vehicle.plateNumber}</span>
                  <span className="ml-auto shrink-0 font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
                    {fmt.int(vehicle.capacityUnits)} u
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Panel>

      {optimise.isError && <ErrorNote error={optimise.error} />}
      {optimise.isPending && (
        <Panel loading>
          <Loading label={t('rt.guidedSearch')} />
        </Panel>
      )}

      {data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Tile label={t('rt.status')} value={data.status} />
            <Tile label={t('rt.routes')} value={String(data.routes.length)} />
            <Tile label={t('rt.distance')} value={`${fmt.int(data.totalDistanceKm)} km`} />
            <Tile
              label={t('rt.duration')}
              value={`${fmt.num(data.totalDurationMinutes / 60, 1)} h`}
            />
            <Tile label={t('rt.cost')} value={fmt.money(data.totalCost)} tone="signal" />
          </div>

          {data.unassignedStops.length > 0 && (
            <div className="border border-[var(--color-warn-dim)] bg-[color-mix(in_srgb,var(--color-warn)_7%,transparent)] px-3.5 py-2.5 text-[0.8125rem] text-[var(--color-warn)]">
              {t('rt.unassigned', { n: data.unassignedStops.length })}
            </div>
          )}

          <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
            <Panel title={t('rt.plans')}>
              <ul className="divide-y divide-[var(--color-hairline)]">
                {data.routes.map((route) => (
                  <li key={route.vehicleId} className="p-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-[0.8125rem] text-[var(--color-signal)]">
                        {route.vehicleName}
                      </span>
                      <span className="tnum font-mono text-[0.6875rem] text-[var(--color-ink-faint)]">
                        {fmt.int(route.distanceKm)} km · {fmt.num(route.durationMinutes / 60, 1)} h ·{' '}
                        {fmt.int(route.loadUnits)} u · {fmt.num(route.fuelLiters, 0)} L ·{' '}
                        {fmt.money(route.cost)}
                      </span>
                    </div>

                    {/* The stop sequence as a strip: order and timing at a glance. */}
                    <ol className="mt-2.5 flex flex-wrap items-stretch gap-0">
                      {route.sequence.map((step, index) => (
                        <li key={`${step.id}-${index}`} className="flex items-stretch">
                          {index > 0 && (
                            <span className="mx-1.5 self-center text-[var(--color-ink-faint)]">→</span>
                          )}
                          <span
                            className={`border px-2 py-1 ${
                              step.id === 'depot'
                                ? 'border-[var(--color-info-dim)] text-[var(--color-info)]'
                                : 'border-[var(--color-hairline)] text-[var(--color-ink-dim)]'
                            }`}
                          >
                            <span className="block text-[0.6875rem] leading-tight">{step.name}</span>
                            <span className="tnum block font-mono text-[0.5625rem] text-[var(--color-ink-faint)]">
                              +{step.arrivalMinutes} min
                            </span>
                          </span>
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ul>
            </Panel>

            <div className="space-y-4">
              <Panel title={t('rt.reasoning')}>
                <div className="p-3.5">
                  <Explain
                    summary={data.explanation.summary}
                    reasons={data.explanation.reasons}
                    assumptions={data.explanation.assumptions}
                  />
                </div>
              </Panel>
              <Panel title={t('rt.constraints')}>
                <ul className="space-y-1.5 p-3.5">
                  {data.constraints.map((constraint, index) => (
                    <li
                      key={index}
                      className="flex gap-2 text-[0.6875rem] leading-relaxed text-[var(--color-ink-dim)]"
                    >
                      <span className="mt-[0.4rem] h-px w-2 shrink-0 bg-[var(--color-info)]" />
                      {constraint}
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          </div>
        </div>
      )}

      {!data && !optimise.isPending && (
        <Panel>
          <Empty
            title="No plan yet"
            hint="Choose a depot and at least one stop. Customers without coordinates cannot be routed and are hidden."
          />
        </Panel>
      )}
    </div>
  );
}

function Legend({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
      {children}
    </span>
  );
}

function Tile({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'signal' | 'neutral';
}) {
  return (
    <div className="panel px-3.5 py-2.5">
      <div className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
        {label}
      </div>
      <div
        className="tnum mt-1 font-mono text-base"
        style={{ color: tone === 'signal' ? 'var(--color-signal)' : 'var(--color-ink)' }}
      >
        {value}
      </div>
    </div>
  );
}
