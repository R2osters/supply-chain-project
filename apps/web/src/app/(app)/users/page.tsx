'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Lock, Pencil, Search, UserCheck, UserPlus, UserX, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { USER_ROLES, type UserRole } from '@scip/shared';
import { api, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { FieldOption, FieldSpec } from '@/lib/entity-form';
import { useFormat, useI18n, type TranslationKey } from '@/lib/i18n';
import { accountStatus, assignableRoles, canManageRole, type AccountStatus } from '@/lib/user-roles';
import { Button, Chip, DemoTag, Empty, ErrorNote, Loading, PageHeader, Panel, type Tone } from '@/components/ui';
import { ConfirmDialog, Drawer, EntityForm, useCrud } from '@/components/entity-form';
import { useToast } from '@/components/toast';
import { OneTimePassword } from './_components/one-time-password';

/* ------------------------------------------------------------------- types */

interface UserRow {
  id: string;
  companyId: string | null;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  role: UserRole;
  isActive: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  createdAt: string;
  isDemoData: boolean;
  linkedSupplierId: string | null;
  linkedCustomerId: string | null;
  driver: { id: string; name: string } | null;
}

/** What POST /users and POST /users/:id/reset-password answer: the account, and the password once. */
type UserWithPassword = UserRow & { temporaryPassword: string };

interface DriverRow {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  userId: string | null;
  isActive?: boolean;
}

interface PartyRow {
  id: string;
  code?: string;
  name: string;
  isActive?: boolean;
}

const PAGE_SIZE = 25;
/** The API's pagination ceiling, used to load look-up lists for selects. */
const OPTIONS_LIMIT = 200;

const STATUS: Record<AccountStatus, { tone: Tone; labelKey: TranslationKey }> = {
  active: { tone: 'ok', labelKey: 'users.status.active' },
  inactive: { tone: 'neutral', labelKey: 'users.status.inactive' },
  locked: { tone: 'alert', labelKey: 'users.status.locked' },
  mustChange: { tone: 'warn', labelKey: 'users.status.mustChange' },
};

const roleLabelKey = (role: string) => `users.role.${role}` as TranslationKey;
const roleHintKey = (role: string): TranslationKey =>
  (USER_ROLES as readonly string[]).includes(role) ? (`users.roleHint.${role}` as TranslationKey) : 'users.f.roleHint';
const fullName = (row: { firstName: string; lastName: string }) => `${row.firstName} ${row.lastName}`.trim();

/** Active suppliers or customers, plus the one already linked (even if archived since). */
function partyOptions(data: Paginated<PartyRow> | undefined, current: string | null | undefined): FieldOption[] {
  return (data?.data ?? [])
    .filter((party) => party.id === current || party.isActive !== false)
    .map((party) => ({ value: party.id, label: party.code ? `${party.name} · ${party.code}` : party.name }));
}

/* -------------------------------------------------------------------- page */

/**
 * Utilisateurs: colleagues and drivers of this company. A desktop install sends no e-mail, so an
 * account is created (or its password reset) with a temporary password that SCIP shows once;
 * the person chooses their own at the first sign-in. Reached from the account menu, like Réglages.
 */
export default function UsersPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  if (!can('user:read')) {
    return <Empty icon={Lock} title={t('settings.forbiddenTitle')} hint={t('users.forbidden')} />;
  }
  return <UsersScreen />;
}

function UsersScreen() {
  const { t } = useI18n();
  const f = useFormat();
  const { user: me, can } = useAuth();
  const client = useQueryClient();
  const toast = useToast();
  const myRole = (me?.role ?? 'VIEWER') as UserRole;

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<{ row: UserRow | null } | null>(null);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [deactivating, setDeactivating] = useState<UserRow | null>(null);

  const list = useQuery({
    queryKey: ['users', { search, page }],
    queryFn: () => {
      const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (search.trim()) query.set('search', search.trim());
      return api<Paginated<UserRow>>(`/users?${query}`);
    },
    placeholderData: keepPreviousData,
  });

  // Edits and deactivation go through the shared CRUD kit; creation and resets have their own
  // mutations because their answer carries the one-time password.
  const crud = useCrud<UserRow>({
    base: '/users',
    invalidate: [['users'], ['drivers']],
    messages: {
      created: (row) => t('md.toast.created', { name: fullName(row) }),
      updated: (row) => t('md.toast.updated', { name: fullName(row) }),
      deleted: t('users.toast.deactivated'),
    },
  });

  const reset = useMutation({
    mutationFn: (id: string) => api<UserWithPassword>(`/users/${id}/reset-password`, { method: 'POST' }),
    // Nothing keeps the password once the panel is closed, not even the mutation cache.
    gcTime: 0,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['users'] });
      setResetting(null);
    },
  });

  const canCreate = can('user:create');
  const canUpdate = can('user:update');
  const canDelete = can('user:delete');

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;

  const openCreate = () => setEditing({ row: null });

  const reactivate = (row: UserRow) =>
    crud.update.mutate(
      { id: row.id, body: { isActive: true } },
      { onError: (error) => toast.show({ tone: 'error', message: error.message }) },
    );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader kicker={t('users.kicker')} title={t('users.title')} description={t('users.description')} />

      <Panel
        title={t('users.panel')}
        icon={Users}
        meta={meta ? <span className="pill-count">{f.int(meta.total)}</span> : null}
        loading={list.isFetching && !list.isLoading}
        actions={
          canCreate ? (
            <Button variant="primary" size="sm" icon={UserPlus} onClick={openCreate}>
              {t('users.add')}
            </Button>
          ) : null
        }
      >
        <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
          <label className="relative flex min-w-[220px] max-w-[360px] flex-1 items-center">
            <span className="sr-only">{t('common.search')}</span>
            <Search className="pointer-events-none absolute left-2.5 h-4 w-4 text-[var(--color-dim)]" />
            <input
              type="search"
              className="field w-full pl-8"
              placeholder={t('users.searchPlaceholder')}
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
            title={search ? t('md.noMatch') : t('users.empty')}
            hint={search ? undefined : t('users.emptyHint')}
            icon={Users}
            action={
              canCreate && !search ? (
                <Button variant="primary" icon={UserPlus} onClick={openCreate}>
                  {t('users.add')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto pt-2">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>{t('md.f.name')}</th>
                  <th>{t('users.f.role')}</th>
                  <th>{t('users.col.status')}</th>
                  <th>{t('users.col.lastLogin')}</th>
                  <th>
                    <span className="sr-only">{t('md.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const self = row.id === me?.id;
                  const name = fullName(row);
                  const status = accountStatus(row);
                  const manageable = canManageRole(myRole, row.role);
                  const statusHint =
                    status === 'locked' && row.lockedUntil
                      ? t('users.status.lockedHint', { time: f.time(row.lockedUntil) })
                      : status === 'mustChange'
                        ? t('users.status.mustChangeHint')
                        : undefined;
                  return (
                    <tr key={row.id} className={row.isActive ? '' : 'opacity-60'}>
                      <td>
                        <span className="flex items-center gap-2 text-[13.5px]">
                          {name}
                          {self && <Chip tone="info">{t('users.you')}</Chip>}
                        </span>
                        <span className="t-data text-[11px] text-[var(--color-dim)]">{row.email}</span>
                      </td>
                      <td>
                        <span className="block text-[13px]">{t(roleLabelKey(row.role))}</span>
                        {row.driver && (
                          <span className="text-[12px] text-[var(--color-muted)]">
                            {t('users.driverLinked', { name: row.driver.name })}
                          </span>
                        )}
                      </td>
                      <td>
                        <Chip tone={STATUS[status].tone} title={statusHint}>
                          {t(STATUS[status].labelKey)}
                        </Chip>
                      </td>
                      <td>
                        <span className="t-data text-[12px] text-[var(--color-muted)]">
                          {row.lastLoginAt ? f.relative(row.lastLoginAt) : t('md.never')}
                        </span>
                      </td>
                      <td className="text-right">
                        <span className="inline-flex items-center justify-end gap-1 whitespace-nowrap">
                          {row.isDemoData && <DemoTag />}
                          {manageable && canUpdate && (
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={Pencil}
                              aria-label={`${t('md.edit')} ${name}`}
                              title={t('md.edit')}
                              onClick={() => {
                                crud.update.reset();
                                setEditing({ row });
                              }}
                            />
                          )}
                          {manageable && canUpdate && !self && row.isActive && (
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={KeyRound}
                              aria-label={`${t('users.reset')} ${name}`}
                              title={t('users.reset')}
                              onClick={() => {
                                reset.reset();
                                setResetting(row);
                              }}
                            />
                          )}
                          {manageable && canUpdate && !row.isActive && (
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={UserCheck}
                              aria-label={`${t('users.reactivate')} ${name}`}
                              title={t('users.reactivate')}
                              disabled={crud.update.isPending}
                              onClick={() => reactivate(row)}
                            />
                          )}
                          {manageable && canDelete && !self && row.isActive && (
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={UserX}
                              aria-label={`${t('users.deactivate')} ${name}`}
                              title={t('users.deactivate')}
                              onClick={() => {
                                crud.remove.reset();
                                setDeactivating(row);
                              }}
                            />
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

      {editing && <UserDrawer row={editing.row} update={crud.update} onClose={() => setEditing(null)} />}

      {resetting && (
        <ConfirmDialog
          title={t('users.resetTitle', { name: fullName(resetting) })}
          body={t('users.resetBody')}
          confirmLabel={t('users.resetConfirm')}
          confirmIcon={KeyRound}
          errorTitle={t('users.resetFailed')}
          pending={reset.isPending}
          error={reset.error}
          onCancel={() => setResetting(null)}
          onConfirm={() => reset.mutate(resetting.id)}
        />
      )}

      {reset.data && (
        <Drawer kicker={reset.data.email} title={t('users.reset')} onClose={() => reset.reset()}>
          <OneTimePassword
            title={t('users.resetDone', { name: fullName(reset.data) })}
            email={reset.data.email}
            password={reset.data.temporaryPassword}
            onDone={() => reset.reset()}
          />
        </Drawer>
      )}

      {deactivating && (
        <ConfirmDialog
          title={t('users.deactivateTitle', { name: fullName(deactivating) })}
          body={t('users.deactivateBody')}
          confirmLabel={t('users.deactivate')}
          confirmIcon={UserX}
          errorTitle={t('users.deactivateFailed')}
          pending={crud.remove.isPending}
          error={crud.remove.error}
          onCancel={() => setDeactivating(null)}
          onConfirm={() => crud.remove.mutate(deactivating.id, { onSuccess: () => setDeactivating(null) })}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ drawer */

/**
 * Create or edit one account. The fields follow the chosen role: a DRIVER can be linked to a
 * driver profile, a SUPPLIER / CUSTOMER portal account to its supplier / customer. Your own
 * account has no role or "active" field: the API refuses both changes anyway.
 */
function UserDrawer({
  row,
  update,
  onClose,
}: {
  row: UserRow | null;
  update: ReturnType<typeof useCrud<UserRow>>['update'];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { user: me, can, refreshUser } = useAuth();
  const client = useQueryClient();
  const myRole = (me?.role ?? 'VIEWER') as UserRole;
  const self = row !== null && row.id === me?.id;

  const [role, setRole] = useState<string>(row?.role ?? '');

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<UserWithPassword>('/users', { method: 'POST', body }),
    gcTime: 0,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['users'] });
      void client.invalidateQueries({ queryKey: ['drivers'] });
    },
  });

  const drivers = useQuery({
    queryKey: ['drivers', 'options', 'accounts'],
    queryFn: () => api<Paginated<DriverRow>>(`/drivers?limit=${OPTIONS_LIMIT}&sortBy=lastName&order=asc`),
    enabled: role === 'DRIVER' && can('driver:read'),
  });
  const suppliers = useQuery({
    queryKey: ['suppliers', 'options', 'accounts'],
    queryFn: () => api<Paginated<PartyRow>>(`/suppliers?limit=${OPTIONS_LIMIT}&sortBy=name&order=asc`),
    enabled: role === 'SUPPLIER' && can('supplier:read'),
  });
  const customers = useQuery({
    queryKey: ['customers', 'options', 'accounts'],
    queryFn: () => api<Paginated<PartyRow>>(`/customers?limit=${OPTIONS_LIMIT}&sortBy=name&order=asc`),
    enabled: role === 'CUSTOMER' && can('customer:read'),
  });

  const roleOptions = useMemo<FieldOption[]>(() => {
    const allowed = assignableRoles(myRole);
    // An account whose current role you could not give stays listed, so saving other fields works.
    const roles = row && !allowed.includes(row.role) ? [row.role, ...allowed] : allowed;
    return roles.map((value) => ({ value, label: t(roleLabelKey(value)) }));
  }, [myRole, row, t]);

  const driverOptions = useMemo<FieldOption[]>(
    () =>
      (drivers.data?.data ?? [])
        // Free profiles, plus the one already linked to this account.
        .filter((d) => d.id === row?.driver?.id || (d.isActive !== false && (!d.userId || d.userId === row?.id)))
        .map((d) => ({ value: d.id, label: d.phone ? `${fullName(d)} · ${d.phone}` : fullName(d) })),
    [drivers.data, row],
  );
  const supplierOptions = useMemo(() => partyOptions(suppliers.data, row?.linkedSupplierId), [suppliers.data, row]);
  const customerOptions = useMemo(() => partyOptions(customers.data, row?.linkedCustomerId), [customers.data, row]);

  const fields = useMemo<FieldSpec[]>(() => {
    const spec: FieldSpec[] = [
      { name: 'firstName', labelKey: 'md.f.firstName', kind: 'text', required: true, maxLength: 80 },
      { name: 'lastName', labelKey: 'md.f.lastName', kind: 'text', required: true, maxLength: 80 },
    ];
    if (!row) {
      spec.push({ name: 'email', labelKey: 'users.f.email', kind: 'email', required: true, maxLength: 254, createOnly: true });
    }
    spec.push({ name: 'phone', labelKey: 'md.f.phone', kind: 'tel', maxLength: 30, nullable: true, placeholder: '+233 20 123 4567' });
    if (!self) {
      spec.push({
        name: 'role',
        labelKey: 'users.f.role',
        kind: 'select',
        required: true,
        options: roleOptions,
        hintKey: role ? roleHintKey(role) : 'users.f.roleHint',
        wide: true,
      });
    }
    if (role === 'DRIVER') {
      spec.push({
        name: 'driverId',
        labelKey: 'users.f.driver',
        kind: 'select',
        allowEmpty: true,
        nullable: true,
        options: driverOptions,
        hintKey: 'users.f.driverHint',
        wide: true,
      });
    }
    if (role === 'SUPPLIER') {
      spec.push({
        name: 'linkedSupplierId',
        labelKey: 'users.f.supplier',
        kind: 'select',
        required: true,
        options: supplierOptions,
        hintKey: 'users.f.supplierHint',
        wide: true,
      });
    }
    if (role === 'CUSTOMER') {
      spec.push({
        name: 'linkedCustomerId',
        labelKey: 'users.f.customer',
        kind: 'select',
        required: true,
        options: customerOptions,
        hintKey: 'users.f.customerHint',
        wide: true,
      });
    }
    if (row && !self) spec.push({ name: 'isActive', labelKey: 'users.f.active', kind: 'checkbox', wide: true });
    return spec;
  }, [row, self, role, roleOptions, driverOptions, supplierOptions, customerOptions]);

  const initial = useMemo(() => (row ? { ...row, driverId: row.driver?.id ?? '' } : null), [row]);
  const created = create.data;

  return (
    <Drawer
      kicker={row ? row.email : t('users.title')}
      title={row ? t('md.editTitle', { name: fullName(row) }) : t('users.new')}
      onClose={onClose}
    >
      {created ? (
        <OneTimePassword
          title={t('users.createdTitle', { name: fullName(created) })}
          email={created.email}
          password={created.temporaryPassword}
          onDone={onClose}
        />
      ) : (
        <>
          <p className="m-0 text-[13px] leading-relaxed text-[var(--color-muted)]">
            {self ? t('users.selfNote') : row ? t('users.editIntro') : t('users.newIntro')}
          </p>
          <EntityForm
            fields={fields}
            initial={initial}
            mode={row ? 'edit' : 'create'}
            submitLabel={row ? t('md.save') : t('users.createSubmit')}
            pending={row ? update.isPending : create.isPending}
            error={row ? update.error : create.error}
            onCancel={onClose}
            onChange={(values) => {
              if (typeof values.role === 'string') setRole(values.role);
            }}
            onSubmit={(body) => {
              if (!row) {
                create.mutate(body);
                return;
              }
              update.mutate(
                { id: row.id, body },
                {
                  onSuccess: () => {
                    // Your own names are in the header: read the profile again.
                    if (self) void refreshUser();
                    onClose();
                  },
                },
              );
            }}
          />
        </>
      )}
    </Drawer>
  );
}
