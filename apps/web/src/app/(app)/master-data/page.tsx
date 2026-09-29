'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState, type ReactNode } from 'react';
import {
  Boxes,
  Building2,
  CircleAlert,
  Contact,
  MapPin,
  Package,
  Pencil,
  Plus,
  Search,
  Tags,
  Trash2,
  Truck,
  UserRound,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@scip/shared';
import { api, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat, useI18n, type TranslationKey } from '@/lib/i18n';
import { minutesToClock, type FieldOption, type FieldSpec } from '@/lib/entity-form';
import {
  CARRIER_FIELDS,
  CUSTOMER_FIELDS,
  LOCATION_FIELDS,
  WAREHOUSE_FIELDS,
  categoryFields,
  driverFields,
  productFields,
  vehicleFields,
} from '@/lib/master-data-fields';
import { Banner, Button, Chip, DemoTag, Empty, ErrorNote, Loading, PageHeader, Panel } from '@/components/ui';
import { ConfirmDialog, Drawer, EntityForm, useCrud } from '@/components/entity-form';
import { useToast } from '@/components/toast';

/* ------------------------------------------------------------------- types */

interface BaseRow {
  id: string;
  isActive?: boolean;
  isDemoData?: boolean;
}

interface ProductRow extends BaseRow {
  sku: string;
  name: string;
  unitOfMeasure: string;
  unitCost: string;
  unitPrice: string;
  currency: string;
  isPerishable: boolean;
  category: { id: string; name: string } | null;
}

interface CategoryRow {
  id: string;
  name: string;
  parentId: string | null;
  _count?: { products: number };
}

interface WarehouseRow extends BaseRow {
  code: string;
  name: string;
  country: string;
  city: string | null;
  latitude: number;
  longitude: number;
  capacityUnits: string | null;
  geofenceRadiusM: number;
  _count?: { inventories: number; locations: number };
}

interface LocationRow {
  id: string;
  code: string;
  zone: string | null;
  aisle: string | null;
  rack: string | null;
  shelf: string | null;
}

interface VehicleRow extends BaseRow {
  plateNumber: string;
  label: string | null;
  type: string;
  status: string;
  capacityUnits: string;
  lastPositionAt: string | null;
  carrier: { id: string; name: string } | null;
}

interface DriverRow extends BaseRow {
  firstName: string;
  lastName: string;
  phone: string | null;
  licenseNumber: string | null;
  carrier: { id: string; name: string } | null;
  defaultVehicle: { id: string; plateNumber: string } | null;
}

interface CustomerRow extends BaseRow {
  code: string;
  name: string;
  country: string;
  city: string | null;
  contactName: string | null;
  contactPhone: string | null;
  windowStartMinutes: number | null;
  windowEndMinutes: number | null;
}

interface CarrierRow extends BaseRow {
  code: string;
  name: string;
  country: string;
  contactEmail: string | null;
  contactPhone: string | null;
  costPerKm: string;
  onTimeRate: number;
  _count?: { vehicles: number; shipments: number };
}

/* -------------------------------------------------------------------- tabs */

type TabKey = 'products' | 'warehouses' | 'vehicles' | 'drivers' | 'customers' | 'carriers';

const TABS: Array<{ key: TabKey; labelKey: TranslationKey; icon: LucideIcon; permission: Permission }> = [
  { key: 'products', labelKey: 'md.tab.products', icon: Package, permission: 'product:read' },
  { key: 'warehouses', labelKey: 'md.tab.warehouses', icon: Warehouse, permission: 'warehouse:read' },
  { key: 'vehicles', labelKey: 'md.tab.vehicles', icon: Truck, permission: 'vehicle:read' },
  { key: 'drivers', labelKey: 'md.tab.drivers', icon: UserRound, permission: 'driver:read' },
  { key: 'customers', labelKey: 'md.tab.customers', icon: Contact, permission: 'customer:read' },
  { key: 'carriers', labelKey: 'md.tab.carriers', icon: Building2, permission: 'carrier:read' },
];

const PAGE_SIZE = 25;
/** The API's pagination ceiling, used to load look-up lists for selects. */
const OPTIONS_LIMIT = 200;

export default function MasterDataPage() {
  // `useSearchParams` needs a Suspense boundary in a static export.
  return (
    <Suspense fallback={<Loading rows={8} />}>
      <MasterDataScreen />
    </Suspense>
  );
}

function MasterDataScreen() {
  const { t } = useI18n();
  const { can } = useAuth();
  const router = useRouter();
  const params = useSearchParams();

  const allowed = TABS.filter((tab) => can(tab.permission));
  const requested = params.get('tab');
  const active = allowed.find((tab) => tab.key === requested) ?? allowed[0];

  const select = (key: TabKey) => router.replace(`/master-data?tab=${key}`, { scroll: false });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={`${t('nav.pillar.network')} · ${t('md.nav')}`}
        title={t('md.title')}
        description={t('md.intro')}
      />

      {allowed.length === 0 || !active ? (
        <Panel>
          <Empty title={t('md.noAccess')} icon={CircleAlert} />
        </Panel>
      ) : (
        <>
          <div role="tablist" aria-label={t('md.nav')} className="segmented self-start overflow-x-auto">
            {allowed.map((tab) => {
              const Icon = tab.icon;
              const selected = tab.key === active.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  id={`md-tab-${tab.key}`}
                  aria-selected={selected}
                  aria-controls="md-tabpanel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => select(tab.key)}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                    event.preventDefault();
                    const index = allowed.findIndex((item) => item.key === tab.key);
                    const step = event.key === 'ArrowRight' ? 1 : -1;
                    const next = allowed[(index + step + allowed.length) % allowed.length];
                    if (next) {
                      select(next.key);
                      document.getElementById(`md-tab-${next.key}`)?.focus();
                    }
                  }}
                >
                  <Icon />
                  {t(tab.labelKey)}
                </button>
              );
            })}
          </div>

          <div id="md-tabpanel" role="tabpanel" aria-labelledby={`md-tab-${active.key}`}>
            {active.key === 'products' && <ProductsTab />}
            {active.key === 'warehouses' && <WarehousesTab />}
            {active.key === 'vehicles' && <VehiclesTab />}
            {active.key === 'drivers' && <DriversTab />}
            {active.key === 'customers' && <CustomersTab />}
            {active.key === 'carriers' && <CarriersTab />}
          </div>
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- crud tab */

interface Column<Row> {
  header: string;
  cell: (row: Row) => ReactNode;
  align?: 'right';
}

/**
 * One reference table: search, paginated list, and the create / edit drawer and delete confirm.
 * Every tab of this screen is this component with its own columns and field spec.
 */
function CrudTab<Row extends BaseRow>({
  entity,
  icon,
  permissions,
  columns,
  fields,
  rowTitle,
  labels,
  toolbar,
  rowActions,
  extraInvalidate = [],
}: {
  /** API collection, also the root of its query keys. */
  entity: 'products' | 'warehouses' | 'vehicles' | 'drivers' | 'customers' | 'carriers';
  icon: LucideIcon;
  permissions: { create: Permission; update: Permission; delete: Permission };
  columns: Array<Column<Row>>;
  fields: FieldSpec[];
  rowTitle: (row: Row) => string;
  labels: { panel: string; add: string; newTitle: string; empty: string; emptyHint: string };
  toolbar?: ReactNode;
  rowActions?: (row: Row) => ReactNode;
  extraInvalidate?: string[][];
}) {
  const { t } = useI18n();
  const f = useFormat();
  const { can } = useAuth();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<{ row: Row | null } | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);

  const list = useQuery({
    queryKey: [entity, 'master', { search, page }],
    queryFn: () => {
      const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (search.trim()) query.set('search', search.trim());
      return api<Paginated<Row>>(`/${entity}?${query}`);
    },
    placeholderData: keepPreviousData,
  });

  const crud = useCrud<Row>({
    base: `/${entity}`,
    invalidate: [[entity], ...extraInvalidate],
    messages: {
      created: (row) => t('md.toast.created', { name: rowTitle(row) }),
      updated: (row) => t('md.toast.updated', { name: rowTitle(row) }),
      deleted: t('md.toast.deleted'),
    },
  });

  const canCreate = can(permissions.create);
  const canUpdate = can(permissions.update);
  const canDelete = can(permissions.delete);

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;

  const openCreate = () => {
    crud.create.reset();
    setEditing({ row: null });
  };
  const openEdit = (row: Row) => {
    crud.update.reset();
    setEditing({ row });
  };

  const Icon = icon;
  const pending = editing?.row ? crud.update.isPending : crud.create.isPending;
  const error = editing?.row ? crud.update.error : crud.create.error;

  return (
    <>
      <Panel
        title={labels.panel}
        icon={icon}
        meta={meta ? <span className="pill-count">{f.int(meta.total)}</span> : null}
        loading={list.isFetching && !list.isLoading}
        actions={
          <>
            {toolbar}
            {canCreate && (
              <Button variant="primary" size="sm" icon={Plus} onClick={openCreate}>
                {labels.add}
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
          <label className="relative flex min-w-[220px] max-w-[360px] flex-1 items-center">
            <span className="sr-only">{t('common.search')}</span>
            <Search className="pointer-events-none absolute left-2.5 h-4 w-4 text-[var(--color-dim)]" />
            <input
              type="search"
              className="field w-full pl-8"
              placeholder={t('common.search')}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </label>
        </div>

        {list.isError ? (
          <ErrorNote error={list.error} onRetry={() => void list.refetch()} />
        ) : list.isLoading ? (
          <Loading rows={6} />
        ) : rows.length === 0 ? (
          <Empty
            title={search ? t('md.noMatch') : labels.empty}
            hint={search ? undefined : labels.emptyHint}
            icon={Icon}
            action={
              canCreate && !search ? (
                <Button variant="primary" icon={Plus} onClick={openCreate}>
                  {labels.add}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto pt-2">
            <table className="grid-table">
              <thead>
                <tr>
                  {columns.map((column, index) => (
                    <th key={index} className={column.align === 'right' ? 'text-right' : ''}>
                      {column.header}
                    </th>
                  ))}
                  <th>
                    <span className="sr-only">{t('md.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const archived = row.isActive === false;
                  return (
                    <tr key={row.id} className={archived ? 'opacity-60' : ''}>
                      {columns.map((column, index) => (
                        <td key={index} className={column.align === 'right' ? 'text-right' : ''}>
                          {column.cell(row)}
                        </td>
                      ))}
                      <td className="text-right">
                        <span className="inline-flex items-center justify-end gap-1 whitespace-nowrap">
                          {row.isDemoData && <DemoTag />}
                          {archived ? (
                            <Chip tone="neutral" title={t('md.archivedHint')}>
                              {t('md.archived')}
                            </Chip>
                          ) : (
                            <>
                              {rowActions?.(row)}
                              {canUpdate && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  icon={Pencil}
                                  aria-label={`${t('md.edit')} ${rowTitle(row)}`}
                                  title={t('md.edit')}
                                  onClick={() => openEdit(row)}
                                />
                              )}
                              {canDelete && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  icon={Trash2}
                                  aria-label={`${t('md.delete')} ${rowTitle(row)}`}
                                  title={t('md.delete')}
                                  onClick={() => {
                                    crud.remove.reset();
                                    setDeleting(row);
                                  }}
                                />
                              )}
                            </>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {meta && meta.totalPages > 1 && (
              <div className="flex items-center justify-end gap-2 px-5 py-3">
                <Button size="sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                  {t('common.prev')}
                </Button>
                <span className="t-data text-[12px] text-[var(--color-muted)]">
                  {t('common.page', { page: meta.page, total: meta.totalPages })}
                </span>
                <Button size="sm" disabled={!meta.hasNextPage} onClick={() => setPage((value) => value + 1)}>
                  {t('common.next')}
                </Button>
              </div>
            )}
          </div>
        )}
      </Panel>

      {editing && (
        <Drawer
          kicker={labels.panel}
          title={editing.row ? t('md.editTitle', { name: rowTitle(editing.row) }) : labels.newTitle}
          onClose={() => setEditing(null)}
        >
          <EntityForm
            fields={fields}
            initial={editing.row as unknown as Record<string, unknown> | null}
            mode={editing.row ? 'edit' : 'create'}
            submitLabel={editing.row ? t('md.save') : t('md.create')}
            pending={pending}
            error={error}
            onCancel={() => setEditing(null)}
            onSubmit={(body) => {
              const done = { onSuccess: () => setEditing(null) };
              if (editing.row) crud.update.mutate({ id: editing.row.id, body }, done);
              else crud.create.mutate(body, done);
            }}
          />
        </Drawer>
      )}

      {deleting && (
        <ConfirmDialog
          title={t('md.deleteTitle', { name: rowTitle(deleting) })}
          body={t('md.deleteBody')}
          confirmLabel={t('md.delete')}
          pending={crud.remove.isPending}
          error={crud.remove.error}
          onCancel={() => setDeleting(null)}
          onConfirm={() => crud.remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
        />
      )}
    </>
  );
}

/* ---------------------------------------------------------------- lookups */

function useCarrierOptions(): FieldOption[] {
  const carriers = useQuery({
    queryKey: ['carriers', 'options'],
    queryFn: () => api<Paginated<CarrierRow>>(`/carriers?limit=${OPTIONS_LIMIT}&sortBy=name&order=asc`),
  });
  return useMemo(
    () =>
      (carriers.data?.data ?? [])
        .filter((row) => row.isActive !== false)
        .map((row) => ({ value: row.id, label: `${row.name} · ${row.code}` })),
    [carriers.data],
  );
}

function useVehicleOptions(): FieldOption[] {
  const vehicles = useQuery({
    queryKey: ['vehicles', 'options'],
    queryFn: () => api<Paginated<VehicleRow>>(`/vehicles?limit=${OPTIONS_LIMIT}&sortBy=plateNumber&order=asc`),
  });
  return useMemo(
    () =>
      (vehicles.data?.data ?? [])
        .filter((row) => row.isActive !== false)
        .map((row) => ({ value: row.id, label: row.label ? `${row.plateNumber} · ${row.label}` : row.plateNumber })),
    [vehicles.data],
  );
}

function useCategories() {
  return useQuery({
    queryKey: ['products', 'categories'],
    queryFn: () => api<CategoryRow[]>('/products/categories'),
  });
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-[12.5px] text-[var(--color-muted)]">{children}</span>;
}

function NameCell({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <>
      <span className="block text-[13.5px]">{title}</span>
      {sub && <span className="t-data text-[11px] text-[var(--color-dim)]">{sub}</span>}
    </>
  );
}

/* ---------------------------------------------------------------- products */

function ProductsTab() {
  const { t } = useI18n();
  const f = useFormat();
  const categories = useCategories();
  const [managing, setManaging] = useState(false);

  const categoryOptions = useMemo(
    () => (categories.data ?? []).map((row) => ({ value: row.id, label: row.name })),
    [categories.data],
  );
  const fields = useMemo(() => productFields(categoryOptions), [categoryOptions]);

  return (
    <>
      <CrudTab<ProductRow>
        entity="products"
        icon={Package}
        permissions={{ create: 'product:create', update: 'product:update', delete: 'product:delete' }}
        fields={fields}
        rowTitle={(row) => row.name}
        labels={{
          panel: t('md.tab.products'),
          add: t('md.products.add'),
          newTitle: t('md.products.new'),
          empty: t('md.products.empty'),
          emptyHint: t('md.products.emptyHint'),
        }}
        toolbar={
          <Button size="sm" icon={Tags} onClick={() => setManaging(true)}>
            {t('md.categories')}
          </Button>
        }
        extraInvalidate={[['inventory'], ['suppliers']]}
        columns={[
          { header: t('md.f.name'), cell: (row) => <NameCell title={row.name} sub={row.sku} /> },
          { header: t('md.f.category'), cell: (row) => <Muted>{row.category?.name ?? '—'}</Muted> },
          { header: t('md.f.uom'), cell: (row) => <span className="t-data text-[12px]">{row.unitOfMeasure}</span> },
          {
            header: t('md.f.unitCost'),
            align: 'right',
            cell: (row) => <span className="t-data text-[12.5px]">{f.num(row.unitCost, 2)}</span>,
          },
          {
            header: t('md.f.unitPrice'),
            align: 'right',
            cell: (row) => <span className="t-data text-[12.5px]">{f.num(row.unitPrice, 2)}</span>,
          },
          {
            header: t('md.f.perishable'),
            cell: (row) => (row.isPerishable ? <Chip tone="neutral">{t('md.perishable')}</Chip> : <Muted>—</Muted>),
          },
        ]}
      />
      {managing && <CategoriesDrawer onClose={() => setManaging(false)} />}
    </>
  );
}

function CategoriesDrawer({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const client = useQueryClient();
  const toast = useToast();
  const categories = useCategories();
  const [tick, setTick] = useState(0);
  const [deleting, setDeleting] = useState<CategoryRow | null>(null);

  const rows = categories.data ?? [];
  const byId = new Map(rows.map((row) => [row.id, row.name]));
  const fields = useMemo(() => categoryFields(rows.map((row) => ({ value: row.id, label: row.name }))), [rows]);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<CategoryRow>('/products/categories', { method: 'POST', body }),
    onSuccess: (row) => {
      void client.invalidateQueries({ queryKey: ['products'] });
      toast.show({ message: t('md.toast.created', { name: row.name }) });
      setTick((value) => value + 1);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/products/categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['products'] });
      toast.show({ message: t('md.toast.deleted') });
      setDeleting(null);
    },
  });

  return (
    <Drawer kicker={t('md.tab.products')} title={t('md.categories')} onClose={onClose}>
      <p className="m-0 text-[13px] leading-relaxed text-[var(--color-muted)]">{t('md.categoriesIntro')}</p>

      {categories.isError ? (
        <ErrorNote error={categories.error} onRetry={() => void categories.refetch()} />
      ) : categories.isLoading ? (
        <Loading rows={3} />
      ) : rows.length === 0 ? (
        <p className="m-0 text-[13px] text-[var(--color-muted)]">{t('md.categoriesNone')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-center gap-3 border-t border-[var(--color-line)] py-2 first:border-t-0"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13.5px]">{row.name}</span>
                <span className="text-[12px] text-[var(--color-muted)]">
                  {row.parentId ? `${t('md.f.parent')}: ${byId.get(row.parentId) ?? '—'} · ` : ''}
                  {t('md.productCount', { n: row._count?.products ?? 0 })}
                </span>
              </span>
              {can('product:delete') && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Trash2}
                  aria-label={`${t('md.delete')} ${row.name}`}
                  title={t('md.delete')}
                  onClick={() => {
                    remove.reset();
                    setDeleting(row);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {can('product:create') && (
        <section className="flex flex-col gap-3 border-t border-[var(--color-line)] pt-5">
          <h3 className="t-h4 m-0">{t('md.categoryAdd')}</h3>
          <EntityForm
            fields={fields}
            mode="create"
            submitLabel={t('md.create')}
            pending={create.isPending}
            error={create.error}
            resetOnSuccess
            successTick={tick}
            onSubmit={(body) => create.mutate(body)}
          />
        </section>
      )}

      {deleting && (
        <ConfirmDialog
          title={t('md.deleteTitle', { name: deleting.name })}
          body={t('md.categoryDeleteBody')}
          confirmLabel={t('md.delete')}
          pending={remove.isPending}
          error={remove.error}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id)}
        />
      )}
    </Drawer>
  );
}

/* -------------------------------------------------------------- warehouses */

function WarehousesTab() {
  const { t } = useI18n();
  const f = useFormat();
  const [locationsOf, setLocationsOf] = useState<WarehouseRow | null>(null);

  return (
    <>
      <CrudTab<WarehouseRow>
        entity="warehouses"
        icon={Warehouse}
        permissions={{ create: 'warehouse:create', update: 'warehouse:update', delete: 'warehouse:delete' }}
        fields={WAREHOUSE_FIELDS}
        rowTitle={(row) => row.name}
        labels={{
          panel: t('md.tab.warehouses'),
          add: t('md.warehouses.add'),
          newTitle: t('md.warehouses.new'),
          empty: t('md.warehouses.empty'),
          emptyHint: t('md.warehouses.emptyHint'),
        }}
        extraInvalidate={[['inventory']]}
        rowActions={(row) => (
          <Button
            variant="ghost"
            size="sm"
            icon={MapPin}
            aria-label={`${t('md.locations')} ${row.name}`}
            title={t('md.locations')}
            onClick={() => setLocationsOf(row)}
          />
        )}
        columns={[
          { header: t('md.f.name'), cell: (row) => <NameCell title={row.name} sub={row.code} /> },
          {
            header: t('md.place'),
            cell: (row) => <Muted>{[row.city, row.country].filter(Boolean).join(', ')}</Muted>,
          },
          {
            header: t('md.coordinates'),
            cell: (row) => (
              <span className="t-data text-[12px] text-[var(--color-muted)]">
                {f.num(row.latitude, 4)}, {f.num(row.longitude, 4)}
              </span>
            ),
          },
          {
            header: t('md.f.capacityUnits'),
            align: 'right',
            cell: (row) => <span className="t-data text-[12.5px]">{row.capacityUnits ? f.int(row.capacityUnits) : '—'}</span>,
          },
          {
            header: t('md.locations'),
            align: 'right',
            cell: (row) => <span className="t-data text-[12.5px]">{f.int(row._count?.locations ?? 0)}</span>,
          },
        ]}
      />
      {locationsOf && <LocationsDrawer warehouse={locationsOf} onClose={() => setLocationsOf(null)} />}
    </>
  );
}

function LocationsDrawer({ warehouse, onClose }: { warehouse: WarehouseRow; onClose: () => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const client = useQueryClient();
  const toast = useToast();
  const [tick, setTick] = useState(0);

  const locations = useQuery({
    queryKey: ['warehouses', warehouse.id, 'locations'],
    queryFn: () => api<LocationRow[]>(`/warehouses/${warehouse.id}/locations`),
  });

  const add = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<LocationRow>(`/warehouses/${warehouse.id}/locations`, { method: 'POST', body }),
    onSuccess: (row) => {
      void client.invalidateQueries({ queryKey: ['warehouses'] });
      toast.show({ message: t('md.toast.created', { name: row.code }) });
      setTick((value) => value + 1);
    },
  });

  const rows = locations.data ?? [];

  return (
    <Drawer kicker={`${warehouse.name} · ${warehouse.code}`} title={t('md.locations')} onClose={onClose}>
      <p className="m-0 text-[13px] leading-relaxed text-[var(--color-muted)]">{t('md.locationsIntro')}</p>

      {locations.isError ? (
        <ErrorNote error={locations.error} onRetry={() => void locations.refetch()} />
      ) : locations.isLoading ? (
        <Loading rows={3} />
      ) : rows.length === 0 ? (
        <p className="m-0 text-[13px] text-[var(--color-muted)]">{t('md.locationsNone')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="grid-table">
            <thead>
              <tr>
                <th>{t('md.f.locationCode')}</th>
                <th>{t('md.f.zone')}</th>
                <th>{t('md.f.aisle')}</th>
                <th>{t('md.f.rack')}</th>
                <th>{t('md.f.shelf')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="t-data text-[12.5px]">{row.code}</td>
                  <td className="text-[12.5px]">{row.zone ?? '—'}</td>
                  <td className="text-[12.5px]">{row.aisle ?? '—'}</td>
                  <td className="text-[12.5px]">{row.rack ?? '—'}</td>
                  <td className="text-[12.5px]">{row.shelf ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {can('warehouse:update') && (
        <section className="flex flex-col gap-3 border-t border-[var(--color-line)] pt-5">
          <h3 className="t-h4 m-0">{t('md.locationAdd')}</h3>
          <EntityForm
            fields={LOCATION_FIELDS}
            mode="create"
            submitLabel={t('md.create')}
            pending={add.isPending}
            error={add.error}
            resetOnSuccess
            successTick={tick}
            onSubmit={(body) => add.mutate(body)}
          />
        </section>
      )}
    </Drawer>
  );
}

/* ---------------------------------------------------------------- vehicles */

function VehiclesTab() {
  const { t } = useI18n();
  const f = useFormat();
  const carriers = useCarrierOptions();
  const fields = useMemo(() => vehicleFields(carriers, (key) => t(key)), [carriers, t]);

  return (
    <div className="flex flex-col gap-4">
      <Banner icon={Truck} title={t('md.vehicles.trackingTitle')}>
        {t('md.vehicles.trackingBody')}{' '}
        <Link href="/devices" className="underline underline-offset-2 hover:text-[var(--color-ink)]">
          {t('md.vehicles.trackingLink')}
        </Link>
      </Banner>
      <CrudTab<VehicleRow>
        entity="vehicles"
        icon={Truck}
        permissions={{ create: 'vehicle:create', update: 'vehicle:update', delete: 'vehicle:delete' }}
        fields={fields}
        rowTitle={(row) => row.plateNumber}
        labels={{
          panel: t('md.tab.vehicles'),
          add: t('md.vehicles.add'),
          newTitle: t('md.vehicles.new'),
          empty: t('md.vehicles.empty'),
          emptyHint: t('md.vehicles.emptyHint'),
        }}
        extraInvalidate={[['fleet'], ['devices']]}
        columns={[
          { header: t('md.f.plate'), cell: (row) => <NameCell title={row.plateNumber} sub={row.label ?? undefined} /> },
          { header: t('md.f.vehicleType'), cell: (row) => <Muted>{t(`md.vt.${row.type}` as TranslationKey)}</Muted> },
          {
            header: t('md.f.vehicleStatus'),
            cell: (row) => <Chip tone="neutral">{t(`md.vs.${row.status}` as TranslationKey)}</Chip>,
          },
          { header: t('md.f.carrier'), cell: (row) => <Muted>{row.carrier?.name ?? '—'}</Muted> },
          {
            header: t('md.f.capacityUnits'),
            align: 'right',
            cell: (row) => <span className="t-data text-[12.5px]">{f.int(row.capacityUnits)}</span>,
          },
          {
            header: t('md.lastPosition'),
            cell: (row) => (
              <span className="t-data text-[12px] text-[var(--color-muted)]">
                {row.lastPositionAt ? f.relative(row.lastPositionAt) : t('md.never')}
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}

/* ----------------------------------------------------------------- drivers */

function DriversTab() {
  const { t } = useI18n();
  const carriers = useCarrierOptions();
  const vehicles = useVehicleOptions();
  const fields = useMemo(() => driverFields(carriers, vehicles), [carriers, vehicles]);

  return (
    <CrudTab<DriverRow>
      entity="drivers"
      icon={UserRound}
      permissions={{ create: 'driver:create', update: 'driver:update', delete: 'driver:delete' }}
      fields={fields}
      rowTitle={(row) => `${row.firstName} ${row.lastName}`}
      labels={{
        panel: t('md.tab.drivers'),
        add: t('md.drivers.add'),
        newTitle: t('md.drivers.new'),
        empty: t('md.drivers.empty'),
        emptyHint: t('md.drivers.emptyHint'),
      }}
      columns={[
        { header: t('md.f.name'), cell: (row) => <NameCell title={`${row.firstName} ${row.lastName}`} sub={row.licenseNumber ?? undefined} /> },
        { header: t('md.f.phone'), cell: (row) => <span className="t-data text-[12px]">{row.phone ?? '—'}</span> },
        { header: t('md.f.carrier'), cell: (row) => <Muted>{row.carrier?.name ?? '—'}</Muted> },
        {
          header: t('md.f.defaultVehicle'),
          cell: (row) => <span className="t-data text-[12px]">{row.defaultVehicle?.plateNumber ?? '—'}</span>,
        },
      ]}
    />
  );
}

/* --------------------------------------------------------------- customers */

function CustomersTab() {
  const { t } = useI18n();
  return (
    <CrudTab<CustomerRow>
      entity="customers"
      icon={Contact}
      permissions={{ create: 'customer:create', update: 'customer:update', delete: 'customer:delete' }}
      fields={CUSTOMER_FIELDS}
      rowTitle={(row) => row.name}
      labels={{
        panel: t('md.tab.customers'),
        add: t('md.customers.add'),
        newTitle: t('md.customers.new'),
        empty: t('md.customers.empty'),
        emptyHint: t('md.customers.emptyHint'),
      }}
      columns={[
        { header: t('md.f.name'), cell: (row) => <NameCell title={row.name} sub={row.code} /> },
        { header: t('md.place'), cell: (row) => <Muted>{[row.city, row.country].filter(Boolean).join(', ')}</Muted> },
        {
          header: t('md.contact'),
          cell: (row) => <Muted>{[row.contactName, row.contactPhone].filter(Boolean).join(' · ') || '—'}</Muted>,
        },
        {
          header: t('md.window'),
          cell: (row) => (
            <span className="t-data text-[12px] text-[var(--color-muted)]">
              {row.windowStartMinutes === null && row.windowEndMinutes === null
                ? '—'
                : `${minutesToClock(row.windowStartMinutes)}–${minutesToClock(row.windowEndMinutes)}`}
            </span>
          ),
        },
      ]}
    />
  );
}

/* ---------------------------------------------------------------- carriers */

function CarriersTab() {
  const { t } = useI18n();
  const f = useFormat();
  return (
    <CrudTab<CarrierRow>
      entity="carriers"
      icon={Boxes}
      permissions={{ create: 'carrier:create', update: 'carrier:update', delete: 'carrier:delete' }}
      fields={CARRIER_FIELDS}
      rowTitle={(row) => row.name}
      labels={{
        panel: t('md.tab.carriers'),
        add: t('md.carriers.add'),
        newTitle: t('md.carriers.new'),
        empty: t('md.carriers.empty'),
        emptyHint: t('md.carriers.emptyHint'),
      }}
      columns={[
        { header: t('md.f.name'), cell: (row) => <NameCell title={row.name} sub={row.code} /> },
        { header: t('md.f.country'), cell: (row) => <span className="t-data text-[12px]">{row.country}</span> },
        {
          header: t('md.contact'),
          cell: (row) => <Muted>{[row.contactEmail, row.contactPhone].filter(Boolean).join(' · ') || '—'}</Muted>,
        },
        {
          header: t('md.f.costPerKm'),
          align: 'right',
          cell: (row) => <span className="t-data text-[12.5px]">{f.num(row.costPerKm, 2)}</span>,
        },
        {
          header: t('md.onTime'),
          align: 'right',
          cell: (row) => <span className="t-data text-[12.5px]">{f.pct(row.onTimeRate, 0)}</span>,
        },
        {
          header: t('md.tab.vehicles'),
          align: 'right',
          cell: (row) => <span className="t-data text-[12.5px]">{f.int(row._count?.vehicles ?? 0)}</span>,
        },
      ]}
    />
  );
}
