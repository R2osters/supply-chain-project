'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, ListChecks, Map as MapIcon, Play, Route, Truck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, type Explanation, type Paginated } from '@/lib/api';
import {
  Banner,
  Button,
  Empty,
  ErrorNote,
  Explain,
  Kpi,
  Legend,
  PageHeader,
  Panel,
} from '@/components/ui';
import { useFormat, useI18n } from '@/lib/i18n';
import {
  FieldLabel,
  ResultSkeleton,
  Timing,
  WhyToggle,
} from '../allocation/_components/optimise-kit';
import { RouteMap, type MapRoute } from './_components/route-map';

interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
}
interface CustomerRow {
  id: string;
  code: string;
  name: string;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
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

/** The solver names the depot step "depot"; every other step id is a customer id. */
const DEPOT_STEP = 'depot';

export default function RoutingPage() {
  const { t } = useI18n();
  const format = useFormat();
  const [warehouseId, setWarehouseId] = useState('');
  const [customerIds, setCustomerIds] = useState<string[]>([]);
  const [vehicleIds, setVehicleIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [why, setWhy] = useState(false);

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
    mutationFn: (input: { warehouseId: string; customerIds: string[]; vehicleIds: string[] }) =>
      api<RoutingResponse>('/ai/route/optimize', {
        method: 'POST',
        body: {
          warehouseId: input.warehouseId,
          customerIds: input.customerIds,
          ...(input.vehicleIds.length ? { vehicleIds: input.vehicleIds } : {}),
        },
      }),
  });

  const data = optimise.data;
  const routable = (customers.data?.data ?? []).filter(
    (customer) => customer.latitude !== null && customer.longitude !== null,
  );

  // Select the first route whenever a new plan arrives.
  useEffect(() => {
    setSelected(data?.routes[0]?.vehicleId ?? null);
  }, [data]);

  // The depot of the plan on screen, not whatever is selected in the form since.
  const plannedDepot = warehouses.data?.data.find((row) => row.id === optimise.variables?.warehouseId);
  const depot = useMemo(
    () =>
      plannedDepot && plannedDepot.latitude !== null && plannedDepot.longitude !== null
        ? { name: plannedDepot.name, coord: [plannedDepot.longitude, plannedDepot.latitude] as [number, number] }
        : null,
    [plannedDepot],
  );

  const mapRoutes = useMemo<MapRoute[]>(() => {
    if (!data) return [];
    const coords = new Map<string, [number, number]>();
    for (const customer of customers.data?.data ?? []) {
      if (customer.latitude !== null && customer.longitude !== null) {
        coords.set(customer.id, [customer.longitude, customer.latitude]);
      }
    }
    return data.routes.map((route) => {
      const path: Array<[number, number]> = [];
      const stops: MapRoute['stops'] = [];
      let order = 0;
      for (const step of route.sequence) {
        const coord = step.id === DEPOT_STEP ? depot?.coord : coords.get(step.id);
        if (!coord) continue;
        path.push(coord);
        if (step.id !== DEPOT_STEP) stops.push({ id: step.id, name: step.name, order: ++order, coord });
      }
      return { vehicleId: route.vehicleId, vehicleName: route.vehicleName, path, stops };
    });
  }, [data, customers.data, depot]);

  function toggle(list: string[], id: string, set: (value: string[]) => void) {
    set(list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id]);
  }

  const run = () => optimise.mutate({ warehouseId, customerIds, vehicleIds });
  const stopCount = data?.routes.reduce(
    (sum, route) => sum + route.sequence.filter((step) => step.id !== DEPOT_STEP).length,
    0,
  );

  const title = optimise.isPending
    ? t('rt.v3.titleRunning')
    : data
      ? data.unassignedStops.length > 0
        ? t('rt.v3.titleUnassigned', {
            routes: data.routes.length,
            stops: stopCount ?? 0,
            n: data.unassignedStops.length,
          })
        : t('rt.v3.titleResult', {
            routes: data.routes.length,
            stops: stopCount ?? 0,
            km: format.int(data.totalDistanceKm),
          })
      : t('rt.v3.titleIdle');

  const solvedSource = data ? <Timing ms={data.solverWallTimeMs} kind="solver" /> : undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={`${t('nav.pillar.optimise')} · ${t('nav.routing')}`}
        title={title}
        description={t('rt.intro')}
      />

      {/* ------------------------------------------------------------ inputs */}
      <Panel icon={Route} title={t('rt.inputs')}>
        <div className="grid gap-5 px-5 pb-5 pt-3 lg:grid-cols-3">
          <div className="flex flex-col gap-3">
            <div>
              <FieldLabel htmlFor="rt-depot">{t('rt.depot')}</FieldLabel>
              <select
                id="rt-depot"
                className="field"
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
              >
                <option value="">{t('rt.selectWarehouse')}</option>
                {warehouses.data?.data.map((warehouse) => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.code} — {warehouse.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                icon={Play}
                className="flex-1"
                disabled={!warehouseId || customerIds.length === 0}
                loading={optimise.isPending}
                onClick={run}
              >
                {optimise.isPending ? t('rt.searching') : t('rt.plan')}
              </Button>
              <Button onClick={() => setCustomerIds(routable.map((c) => c.id))}>{t('rt.allStops')}</Button>
            </div>
          </div>

          <div>
            <span className="t-label mb-1.5 flex flex-wrap items-baseline gap-x-2">
              {t('rt.stopsSelected', { n: customerIds.length })}
              {customers.data && routable.length < customers.data.data.length && (
                <span className="normal-case tracking-normal text-[var(--color-muted)]">
                  {t('rt.hiddenNoCoords', { n: customers.data.data.length - routable.length })}
                </span>
              )}
            </span>
            <div className="tile max-h-56 overflow-y-auto py-1">
              {customers.isError ? (
                <ErrorNote error={customers.error} onRetry={() => void customers.refetch()} />
              ) : (
                routable.map((customer) => (
                  <label
                    key={customer.id}
                    className="flex min-h-8 cursor-pointer items-center gap-2 px-3 py-1 transition-colors duration-100 hover:bg-[var(--color-surface)]"
                  >
                    <input
                      type="checkbox"
                      className="accent-[var(--color-ink)]"
                      checked={customerIds.includes(customer.id)}
                      onChange={() => toggle(customerIds, customer.id, setCustomerIds)}
                    />
                    <span className="truncate text-[13px]">{customer.name}</span>
                    <span className="t-data ml-auto shrink-0 text-[11px] text-[var(--color-dim)]">
                      {customer.city}
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>

          <div>
            <span className="t-label mb-1.5 block">
              {t('rt.vehicles', {
                what: vehicleIds.length ? t('rt.vehiclesSelected', { n: vehicleIds.length }) : t('rt.allAvailable'),
              })}
            </span>
            <div className="tile max-h-56 overflow-y-auto py-1">
              {vehicles.isError ? (
                <ErrorNote error={vehicles.error} onRetry={() => void vehicles.refetch()} />
              ) : (
                vehicles.data?.data.map((vehicle) => (
                  <label
                    key={vehicle.id}
                    className="flex min-h-8 cursor-pointer items-center gap-2 px-3 py-1 transition-colors duration-100 hover:bg-[var(--color-surface)]"
                  >
                    <input
                      type="checkbox"
                      className="accent-[var(--color-ink)]"
                      checked={vehicleIds.includes(vehicle.id)}
                      onChange={() => toggle(vehicleIds, vehicle.id, setVehicleIds)}
                    />
                    <span className="t-data text-[12px]">{vehicle.plateNumber}</span>
                    {vehicle.label && (
                      <span className="truncate text-[12px] text-[var(--color-muted)]">{vehicle.label}</span>
                    )}
                    <span className="t-data ml-auto shrink-0 text-[11px] text-[var(--color-dim)]">
                      {format.int(vehicle.capacityUnits)} u
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>
        </div>
        {warehouses.isError && <ErrorNote error={warehouses.error} onRetry={() => void warehouses.refetch()} />}
      </Panel>

      {optimise.isError && <ErrorNote error={optimise.error} onRetry={run} />}

      {optimise.isPending && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="panel p-4">
                <ResultSkeleton rows={1} />
              </div>
            ))}
          </div>
          <Panel loading title={t('rt.guidedSearch')}>
            <ResultSkeleton chart rows={4} />
          </Panel>
        </div>
      )}

      {data && !optimise.isPending && (
        <div className="flex flex-col gap-4" aria-live="polite">
          <div className="stagger grid grid-cols-2 gap-4 md:grid-cols-5">
            <Kpi
              label={t('rt.status')}
              value={data.status.toLowerCase()}
              tone={data.unassignedStops.length > 0 ? 'warn' : 'neutral'}
              source={solvedSource}
            />
            <Kpi label={t('rt.routes')} value={format.int(data.routes.length)} source={solvedSource} />
            <Kpi label={t('rt.distance')} value={format.int(data.totalDistanceKm)} unit="km" source={solvedSource} />
            <Kpi
              label={t('rt.duration')}
              value={format.num(data.totalDurationMinutes / 60, 1)}
              unit="h"
              source={solvedSource}
            />
            <Kpi label={t('rt.cost')} value={format.money(data.totalCost)} source={solvedSource} />
          </div>

          {data.unassignedStops.length > 0 && (
            <Banner tone="warn" icon={Truck} title={t('rt.unassigned', { n: data.unassignedStops.length })}>
              {t('rt.v3.unassignedHint')}
            </Banner>
          )}

          {/* --------------------------------------------------------- map */}
          <Panel
            icon={MapIcon}
            title={t('rt.v3.map')}
            actions={
              <Legend
                items={[
                  { label: t('rt.v3.legendDepot'), colour: 'var(--color-ink)' },
                  { label: t('rt.v3.legendSelected'), colour: 'var(--color-ink)', shape: 'line' },
                  { label: t('rt.v3.legendOther'), colour: 'var(--color-muted)', shape: 'line' },
                ]}
              />
            }
          >
            <div className="flex flex-col gap-3 px-5 pb-5 pt-3">
              {data.routes.length > 1 && (
                <div className="flex flex-wrap gap-2" role="group" aria-label={t('rt.routes')}>
                  {data.routes.map((route) => (
                    <button
                      key={route.vehicleId}
                      type="button"
                      className="pill"
                      aria-pressed={route.vehicleId === selected}
                      onClick={() => setSelected(route.vehicleId)}
                    >
                      <Truck />
                      <span className="t-data">{route.vehicleName}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="relative h-[420px] overflow-hidden rounded-[var(--radius-md)] bg-[var(--color-map)]">
                <RouteMap
                  depot={depot}
                  routes={mapRoutes}
                  selected={selected}
                  onSelect={setSelected}
                  labels={{ depot: t('rt.depot') }}
                />
              </div>
              <p className="m-0 text-[12px] text-[var(--color-dim)]">{t('rt.v3.straightNote')}</p>
            </div>
          </Panel>

          <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
            <Panel icon={Truck} title={t('rt.plans')}>
              <ul className="stagger m-0 flex list-none flex-col gap-2 p-3 pt-2">
                {data.routes.map((route) => {
                  const active = route.vehicleId === selected;
                  return (
                    <li key={route.vehicleId}>
                      <button
                        type="button"
                        onClick={() => setSelected(route.vehicleId)}
                        aria-pressed={active}
                        className={`flex w-full flex-col gap-3 rounded-[var(--radius-md)] p-3 text-left transition-colors duration-100 ${
                          active
                            ? 'bg-[var(--color-surface-2)] shadow-[inset_0_0_0_1px_var(--color-accent)]'
                            : 'hover:bg-[var(--color-surface-2)]'
                        }`}
                      >
                        <span className="flex flex-wrap items-center justify-between gap-2">
                          <span className="t-data flex items-center gap-2 text-[13px] text-[var(--color-ink)]">
                            <Truck className="h-3.5 w-3.5 text-[var(--color-muted)]" />
                            {route.vehicleName}
                          </span>
                          <span className="t-data text-[11px] text-[var(--color-muted)]">
                            {format.int(route.distanceKm)} km · {format.num(route.durationMinutes / 60, 1)} h ·{' '}
                            {format.int(route.loadUnits)} u · {format.num(route.fuelLiters, 0)} L ·{' '}
                            {format.money(route.cost)}
                          </span>
                        </span>

                        {/* The stop sequence as a strip: order and timing at a glance. */}
                        <ol className="m-0 flex list-none flex-wrap items-center gap-y-2 p-0">
                          {route.sequence.map((step, index) => {
                            const isDepot = step.id === DEPOT_STEP;
                            const stopNumber = isDepot
                              ? null
                              : route.sequence.slice(0, index + 1).filter((entry) => entry.id !== DEPOT_STEP).length;
                            return (
                              <li key={`${step.id}-${index}`} className="flex items-center">
                                {index > 0 && (
                                  <ArrowRight className="mx-1 h-3 w-3 shrink-0 text-[var(--color-dim)]" aria-hidden="true" />
                                )}
                                <span
                                  className={`flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 ${
                                    isDepot ? 'bg-[var(--color-surface)]' : 'border border-[var(--color-line)]'
                                  }`}
                                >
                                  <span
                                    className={`t-data flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] ${
                                      isDepot
                                        ? 'bg-[var(--color-ink)] text-[var(--color-surface-2)]'
                                        : active
                                          ? 'bg-[var(--color-accent)] text-[var(--color-accent-tx)]'
                                          : 'bg-[var(--color-line)] text-[var(--color-muted)]'
                                    }`}
                                  >
                                    {isDepot ? 'D' : stopNumber}
                                  </span>
                                  <span className="flex flex-col">
                                    <span className="text-[12px] leading-tight text-[var(--color-ink)]">{step.name}</span>
                                    <span className="t-data text-[11px] text-[var(--color-dim)]">
                                      +{step.arrivalMinutes} min
                                    </span>
                                  </span>
                                </span>
                              </li>
                            );
                          })}
                        </ol>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Panel>

            <div className="flex flex-col gap-4">
              <Panel icon={Route} title={t('rt.reasoning')} actions={solvedSource}>
                <div className="px-5 pb-5 pt-3">
                  <WhyToggle open={why} onToggle={() => setWhy((open) => !open)} label={t('rt.v3.why')}>
                    <Explain
                      summary={data.explanation.summary}
                      reasons={data.explanation.reasons}
                      assumptions={data.explanation.assumptions}
                    />
                  </WhyToggle>
                  {!why && (
                    <p className="m-0 mt-2 text-[13.5px] leading-relaxed text-[var(--color-ink)]">
                      {data.explanation.summary}
                    </p>
                  )}
                </div>
              </Panel>
              <Panel icon={ListChecks} title={t('rt.constraints')}>
                <ul className="m-0 flex list-none flex-col gap-1.5 px-5 pb-5 pt-3">
                  {data.constraints.map((constraint, index) => (
                    <li key={index} className="flex gap-2 text-[13px] leading-relaxed text-[var(--color-muted)]">
                      <span className="mt-[0.6rem] h-px w-2 shrink-0 bg-[var(--color-muted)]" />
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
          <Empty icon={Route} title={t('rt.none')} hint={t('rt.noneHint')} />
        </Panel>
      )}
    </div>
  );
}
