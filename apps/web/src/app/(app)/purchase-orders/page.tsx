'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Paginated } from '@/lib/api';
import { Chip, Empty, ErrorNote, Loading, Panel, fmt, statusTone } from '@/components/ui';
import { useAuth } from '@/lib/auth';

interface PurchaseOrderRow {
  id: string;
  orderNumber: string;
  status: string;
  currency: string;
  totalAmount: string;
  expectedDeliveryDate: string | null;
  actualDeliveryDate: string | null;
  createdAt: string;
  isDemoData: boolean;
  sourceRecommendationId: string | null;
  supplier: { id: string; code: string; name: string; reliabilityScore: number };
  warehouse: { id: string; code: string; name: string } | null;
  _count: { items: number; shipments: number };
}

const STATUSES = [
  'DRAFT',
  'PENDING',
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'IN_TRANSIT',
  'DELIVERED',
  'CANCELLED',
] as const;

/** Mirrors the API's state machine, so the UI only offers moves the server will accept. */
const NEXT: Record<string, string[]> = {
  DRAFT: ['PENDING', 'CANCELLED'],
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT: ['CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

export default function PurchaseOrdersPage() {
  const client = useQueryClient();
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  const orders = useQuery({
    queryKey: ['purchase-orders', { status, page }],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: '30' });
      if (status) params.set('status', status);
      return api<Paginated<PurchaseOrderRow>>(`/purchase-orders?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  const transition = useMutation({
    mutationFn: (input: { id: string; status: string }) =>
      api(`/purchase-orders/${input.id}/transition`, {
        method: 'POST',
        body: {
          status: input.status,
          ...(input.status === 'CANCELLED' ? { reason: 'Cancelled from the orders screen' } : {}),
        },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['purchase-orders'] }),
  });

  return (
    <div className="space-y-4">
      <Panel
        title="Purchase orders"
        meta={orders.data ? <Chip tone="neutral">{fmt.int(orders.data.meta.total)}</Chip> : null}
        loading={orders.isFetching}
        actions={
          <select
            className="field !py-1 !text-[0.6875rem]"
            style={{ width: 130 }}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">all statuses</option>
            {STATUSES.map((option) => (
              <option key={option} value={option}>
                {option.toLowerCase()}
              </option>
            ))}
          </select>
        }
      >
        {orders.isError ? (
          <ErrorNote error={orders.error} />
        ) : orders.isLoading ? (
          <Loading />
        ) : orders.data && orders.data.data.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Status</th>
                  <th>Supplier</th>
                  <th>Receiving</th>
                  <th className="text-right">Lines</th>
                  <th className="text-right">Value</th>
                  <th className="text-right">Expected</th>
                  <th className="text-right">Actual</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {orders.data.data.map((order) => {
                  const late =
                    order.actualDeliveryDate &&
                    order.expectedDeliveryDate &&
                    new Date(order.actualDeliveryDate) > new Date(order.expectedDeliveryDate);

                  return (
                    <tr key={order.id}>
                      <td>
                        <span className="font-mono text-[0.75rem]">{order.orderNumber}</span>
                        {order.sourceRecommendationId && (
                          <span
                            className="ml-1.5 font-mono text-[0.5625rem] uppercase tracking-[0.1em] text-[var(--color-signal)]"
                            title="Raised by accepting a recommendation"
                          >
                            ai
                          </span>
                        )}
                      </td>
                      <td>
                        <Chip tone={statusTone(order.status)}>{order.status}</Chip>
                      </td>
                      <td>
                        <span className="block text-[0.8125rem]">{order.supplier.name}</span>
                        <span className="tnum font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
                          reliability {fmt.num(order.supplier.reliabilityScore, 0)}
                        </span>
                      </td>
                      <td className="font-mono text-[0.6875rem] text-[var(--color-ink-dim)]">
                        {order.warehouse?.code ?? '—'}
                      </td>
                      <td className="tnum text-right font-mono text-[0.75rem]">{order._count.items}</td>
                      <td className="tnum text-right font-mono text-[0.75rem]">
                        {fmt.money(order.totalAmount, order.currency)}
                      </td>
                      <td className="tnum text-right font-mono text-[0.6875rem] text-[var(--color-ink-dim)]">
                        {fmt.date(order.expectedDeliveryDate)}
                      </td>
                      <td
                        className={`tnum text-right font-mono text-[0.6875rem] ${
                          late ? 'text-[var(--color-alert)]' : 'text-[var(--color-ink-dim)]'
                        }`}
                      >
                        {fmt.date(order.actualDeliveryDate)}
                      </td>
                      <td className="text-right">
                        {can('purchase_order:approve') && NEXT[order.status]?.length > 0 && (
                          <select
                            className="field !py-0.5 !text-[0.625rem]"
                            style={{ width: 110 }}
                            value=""
                            disabled={transition.isPending}
                            onChange={(event) => {
                              if (!event.target.value) return;
                              transition.mutate({ id: order.id, status: event.target.value });
                            }}
                          >
                            <option value="">move to…</option>
                            {NEXT[order.status].map((next) => (
                              <option key={next} value={next}>
                                {next.toLowerCase()}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="No purchase orders"
            hint="Accept an ORDER_NOW recommendation and a draft order appears here."
          />
        )}

        {orders.data && orders.data.meta.totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-[var(--color-hairline)] px-3 py-2">
            <span className="font-mono text-[0.625rem] uppercase text-[var(--color-ink-faint)]">
              page {orders.data.meta.page} / {orders.data.meta.totalPages}
            </span>
            <div className="flex gap-2">
              <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                prev
              </button>
              <button
                className="btn"
                disabled={!orders.data.meta.hasNextPage}
                onClick={() => setPage((p) => p + 1)}
              >
                next
              </button>
            </div>
          </div>
        )}
      </Panel>

      {transition.isError && <ErrorNote error={transition.error} />}
    </div>
  );
}
