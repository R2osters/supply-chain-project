'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ClipboardPlus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Button, DemoTag, DisabledReason, ErrorNote, Facts, Loading } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useFormat, useI18n } from '@/lib/i18n';

interface SupplierOption {
  id: string;
  code: string;
  name: string;
}

interface SupplierProductRow {
  id: string;
  unitPrice: string;
  currency: string;
  minimumOrderQuantity: string;
  leadTimeDays: number;
  isPreferred: boolean;
  isDemoData: boolean;
  product: { id: string; sku: string; name: string };
}

interface CreatedOrder {
  id: string;
  orderNumber: string;
}

/**
 * Raises a purchase order as a DRAFT. Shared by the suppliers and orders tabs, which the charte
 * presents as one screen. A draft commits nothing and reaches no one, so the charte's "undo rather
 * than confirm" applies: create at once, and Undo cancels the draft.
 */
export function NewOrderPanel({
  suppliers,
  initialSupplierId,
  onClose,
}: {
  suppliers: SupplierOption[];
  initialSupplierId?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const f = useFormat();
  const client = useQueryClient();
  const router = useRouter();
  const toast = useToast();

  const [supplierId, setSupplierId] = useState(initialSupplierId ?? suppliers[0]?.id ?? '');
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('');

  useEffect(() => {
    if (initialSupplierId) setSupplierId(initialSupplierId);
  }, [initialSupplierId]);

  const products = useQuery({
    queryKey: ['suppliers', supplierId, 'products'],
    queryFn: () => api<SupplierProductRow[]>(`/suppliers/${supplierId}/products`),
    enabled: Boolean(supplierId),
  });

  const line = useMemo(
    () => products.data?.find((row) => row.product.id === productId) ?? null,
    [products.data, productId],
  );

  // Picking a product proposes its minimum order quantity, the smallest order the server accepts.
  useEffect(() => {
    if (line) setQuantity(String(Number(line.minimumOrderQuantity)));
  }, [line]);

  const qty = Number(quantity);
  const moq = line ? Number(line.minimumOrderQuantity) : 0;
  const belowMoq = Boolean(line) && qty > 0 && qty < moq;
  const canSubmit = Boolean(supplierId && line && qty > 0 && !belowMoq);

  const cancelDraft = useMutation({
    mutationFn: (order: CreatedOrder) =>
      api(`/purchase-orders/${order.id}/transition`, {
        method: 'POST',
        body: { status: 'CANCELLED', reason: t('po.v3.new.undoReason') },
      }),
    onSuccess: (_data, order) => {
      void client.invalidateQueries({ queryKey: ['purchase-orders'] });
      toast.show({ message: t('po.v3.new.undone', { order: order.orderNumber }), tone: 'info' });
    },
    onError: (error) => toast.show({ message: error instanceof Error ? error.message : String(error), tone: 'error' }),
  });

  const create = useMutation({
    mutationFn: () =>
      api<CreatedOrder>('/purchase-orders', {
        method: 'POST',
        body: { supplierId, items: [{ productId, quantity: qty }] },
      }),
    onSuccess: (order) => {
      void client.invalidateQueries({ queryKey: ['purchase-orders'] });
      toast.show({
        message: t('po.v3.new.created', { order: order.orderNumber }),
        onUndo: () => cancelDraft.mutate(order),
        action: { label: t('po.v3.new.view'), onClick: () => router.push('/purchase-orders') },
      });
      onClose();
    },
  });

  return (
    <aside
      className="panel slide-in-right flex flex-col gap-4 p-5"
      aria-label={t('po.v3.new.title')}
    >
      <header className="flex items-start justify-between gap-3">
        <span className="flex items-center gap-2">
          <ClipboardPlus className="h-4 w-4 text-[var(--color-muted)]" />
          <h2 className="t-h4 m-0">{t('po.v3.new.title')}</h2>
        </span>
        <Button variant="ghost" size="sm" icon={X} onClick={onClose} aria-label={t('common.close')} />
      </header>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) create.mutate();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="t-label">{t('po.v3.new.supplier')}</span>
          <select
            className="field"
            value={supplierId}
            onChange={(event) => {
              setSupplierId(event.target.value);
              setProductId('');
              setQuantity('');
            }}
          >
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name} · {supplier.code}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="t-label">{t('po.v3.new.product')}</span>
          {products.isLoading ? (
            <Loading rows={1} />
          ) : products.isError ? (
            <ErrorNote error={products.error} onRetry={() => void products.refetch()} />
          ) : products.data && products.data.length > 0 ? (
            <select className="field" value={productId} onChange={(event) => setProductId(event.target.value)}>
              <option value="">{t('po.v3.new.pickProduct')}</option>
              {products.data.map((row) => (
                <option key={row.id} value={row.product.id}>
                  {row.product.sku} · {row.product.name}
                </option>
              ))}
            </select>
          ) : (
            <DisabledReason>{t('po.v3.new.noProducts')}</DisabledReason>
          )}
        </label>

        {line && (
          <div className="tile fade-in flex flex-col gap-3 p-4">
            {line.isDemoData && (
              <span>
                <DemoTag />
              </span>
            )}
            <Facts
              items={[
                [t('po.v3.new.unitPrice'), <span className="t-data">{f.num(line.unitPrice, 2)} {line.currency}</span>],
                [t('po.v3.new.lead'), <span className="t-data">{t('sup.v3.days', { n: line.leadTimeDays })}</span>],
                [t('po.v3.new.moq'), <span className="t-data">{f.int(line.minimumOrderQuantity)}</span>],
                [
                  t('po.v3.new.estimate'),
                  <span className="t-data">
                    {qty > 0 ? `${f.num(qty * Number(line.unitPrice), 0)} ${line.currency}` : '—'}
                  </span>,
                ],
              ]}
            />
          </div>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="t-label">{t('po.v3.new.quantity')}</span>
          <input
            className="field t-data"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={quantity}
            disabled={!line}
            aria-invalid={belowMoq || undefined}
            onChange={(event) => setQuantity(event.target.value)}
          />
          {belowMoq && <DisabledReason>{t('po.v3.new.belowMoq', { n: f.int(moq) })}</DisabledReason>}
        </label>

        {create.isError && <ErrorNote error={create.error} />}

        <p className="m-0 text-[12.5px] text-[var(--color-muted)]">{t('po.v3.new.draftNote')}</p>

        <Button type="submit" variant="primary" icon={ClipboardPlus} loading={create.isPending} disabled={!canSubmit}>
          {t('po.v3.new.submit')}
        </Button>
      </form>
    </aside>
  );
}
