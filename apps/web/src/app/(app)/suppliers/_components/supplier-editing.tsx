'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link2, Pencil } from 'lucide-react';
import { api, type Paginated } from '@/lib/api';
import { useFormat, useI18n } from '@/lib/i18n';
import { SUPPLIER_FIELDS, supplierProductFields } from '@/lib/master-data-fields';
import { ConfirmDialog, Drawer, EntityForm } from '@/components/entity-form';
import { useToast } from '@/components/toast';
import { Button, DemoTag, ErrorNote, Loading } from '@/components/ui';

interface SupplierRecord {
  id: string;
  code: string;
  name: string;
}

interface CatalogueRow {
  id: string;
  unitPrice: string;
  currency: string;
  minimumOrderQuantity: string;
  capacityPerCycle: string;
  leadTimeDays: number;
  isDemoData?: boolean;
  product: { id: string; sku: string; name: string };
}

interface ProductOption {
  id: string;
  sku: string;
  name: string;
  isActive?: boolean;
}

/** Create a supplier, or edit one (its full record is fetched first — the league table is a summary). */
export function SupplierFormDrawer({ supplierId, onClose }: { supplierId?: string; onClose: () => void }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const toast = useToast();

  const detail = useQuery({
    queryKey: ['suppliers', supplierId, 'detail'],
    queryFn: () => api<SupplierRecord & Record<string, unknown>>(`/suppliers/${supplierId}`),
    enabled: Boolean(supplierId),
  });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      supplierId
        ? api<SupplierRecord>(`/suppliers/${supplierId}`, { method: 'PATCH', body })
        : api<SupplierRecord>('/suppliers', { method: 'POST', body }),
    onSuccess: (row) => {
      void client.invalidateQueries({ queryKey: ['suppliers'] });
      toast.show({
        message: supplierId
          ? t('md.toast.updated', { name: row.name })
          : t('md.toast.created', { name: row.name }),
      });
      onClose();
    },
  });

  return (
    <Drawer
      kicker={t('nav.suppliers')}
      title={
        supplierId
          ? t('md.editTitle', { name: detail.data?.name ?? '…' })
          : t('md.suppliers.new')
      }
      onClose={onClose}
    >
      {supplierId && detail.isError ? (
        <ErrorNote error={detail.error} onRetry={() => void detail.refetch()} />
      ) : supplierId && !detail.data ? (
        <Loading rows={6} />
      ) : (
        <EntityForm
          fields={SUPPLIER_FIELDS}
          initial={detail.data ?? null}
          mode={supplierId ? 'edit' : 'create'}
          submitLabel={supplierId ? t('md.save') : t('md.create')}
          pending={save.isPending}
          error={save.error}
          onCancel={onClose}
          onSubmit={(body) => save.mutate(body)}
        />
      )}
    </Drawer>
  );
}

/** Deactivation, not erasure: purchase orders raised with this supplier keep pointing at it. */
export function DeleteSupplierDialog({
  supplier,
  onClose,
  onDeleted,
}: {
  supplier: SupplierRecord;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const toast = useToast();

  const remove = useMutation({
    mutationFn: () => api(`/suppliers/${supplier.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['suppliers'] });
      toast.show({ message: t('md.toast.deleted') });
      onDeleted();
    },
  });

  return (
    <ConfirmDialog
      title={t('md.deleteTitle', { name: supplier.name })}
      body={t('md.suppliers.deleteBody')}
      confirmLabel={t('md.delete')}
      pending={remove.isPending}
      error={remove.error}
      onCancel={onClose}
      onConfirm={() => remove.mutate()}
    />
  );
}

/**
 * What this supplier sells, at what price and lead time. Linking a product (or repricing one)
 * posts to `/suppliers/:id/products`; the API versions the price rather than overwriting it.
 */
export function SupplierCatalogue({ supplier, canEdit }: { supplier: SupplierRecord; canEdit: boolean }) {
  const { t } = useI18n();
  const f = useFormat();
  const [linking, setLinking] = useState<CatalogueRow | 'new' | null>(null);

  const catalogue = useQuery({
    // Same key as the purchase-order composer, so a new link shows up there at once.
    queryKey: ['suppliers', supplier.id, 'products'],
    queryFn: () => api<CatalogueRow[]>(`/suppliers/${supplier.id}/products`),
  });

  const rows = catalogue.data ?? [];

  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-2">
        <h3 className="t-h4 m-0 flex items-center gap-2">
          {t('md.suppliers.catalogue')}
          {catalogue.data && <span className="pill-count">{rows.length}</span>}
        </h3>
        {canEdit && (
          <Button size="sm" icon={Link2} onClick={() => setLinking('new')}>
            {t('md.suppliers.link')}
          </Button>
        )}
      </header>

      {catalogue.isError ? (
        <ErrorNote error={catalogue.error} onRetry={() => void catalogue.refetch()} />
      ) : catalogue.isLoading ? (
        <Loading rows={2} />
      ) : rows.length === 0 ? (
        <p className="m-0 text-[13px] text-[var(--color-muted)]">{t('md.suppliers.catalogueEmpty')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {rows.map((row) => (
            <li
              key={row.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-[var(--color-line)] py-2 first:border-t-0"
            >
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[13px]">{row.product.name}</span>
                  {row.isDemoData && <DemoTag />}
                </span>
                <span className="t-data text-[11.5px] text-[var(--color-muted)]">
                  {row.product.sku} · {f.num(row.unitPrice, 2)} {row.currency} ·{' '}
                  {t('sup.v3.days', { n: row.leadTimeDays })} · {t('md.moqShort')} {f.int(row.minimumOrderQuantity)}
                </span>
              </span>
              {canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Pencil}
                  aria-label={`${t('md.suppliers.reprice')} ${row.product.name}`}
                  title={t('md.suppliers.reprice')}
                  onClick={() => setLinking(row)}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {linking && (
        <LinkProductDrawer
          supplier={supplier}
          existing={linking === 'new' ? null : linking}
          onClose={() => setLinking(null)}
        />
      )}
    </section>
  );
}

function LinkProductDrawer({
  supplier,
  existing,
  onClose,
}: {
  supplier: SupplierRecord;
  existing: CatalogueRow | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const toast = useToast();

  const products = useQuery({
    queryKey: ['products', 'options'],
    queryFn: () => api<Paginated<ProductOption>>('/products?limit=200&sortBy=sku&order=asc'),
  });

  const options = useMemo(
    () =>
      (products.data?.data ?? [])
        .filter((row) => row.isActive !== false)
        .map((row) => ({ value: row.id, label: `${row.sku} · ${row.name}` })),
    [products.data],
  );
  const fields = useMemo(() => supplierProductFields(options), [options]);

  const initial = existing
    ? {
        productId: existing.product.id,
        unitPrice: existing.unitPrice,
        currency: existing.currency,
        minimumOrderQuantity: existing.minimumOrderQuantity,
        capacityPerCycle: existing.capacityPerCycle,
        leadTimeDays: existing.leadTimeDays,
      }
    : null;

  const link = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/suppliers/${supplier.id}/products`, { method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['suppliers'] });
      toast.show({ message: t('md.suppliers.linked', { name: supplier.name }) });
      onClose();
    },
  });

  return (
    <Drawer
      kicker={`${supplier.name} · ${supplier.code}`}
      title={existing ? t('md.suppliers.reprice') : t('md.suppliers.link')}
      onClose={onClose}
    >
      <p className="m-0 text-[13px] leading-relaxed text-[var(--color-muted)]">{t('md.suppliers.linkIntro')}</p>
      {products.isError ? (
        <ErrorNote error={products.error} onRetry={() => void products.refetch()} />
      ) : products.isLoading ? (
        <Loading rows={4} />
      ) : options.length === 0 ? (
        <p className="m-0 text-[13px] text-[var(--color-muted)]">{t('md.suppliers.noProducts')}</p>
      ) : (
        <EntityForm
          fields={fields}
          initial={initial}
          // The endpoint is an upsert: every submission is a complete price line, so the payload is
          // always built in create mode (blank optional fields fall back to the server defaults).
          mode="create"
          submitLabel={t('md.save')}
          pending={link.isPending}
          error={link.error}
          onCancel={onClose}
          onSubmit={(body) => link.mutate(body)}
        />
      )}
    </Drawer>
  );
}
