'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type InventoryRow, type Paginated } from '@/lib/api';
import { Chip, Empty, ErrorNote, Loading, Meter, Panel, fmt } from '@/components/ui';
import { useAuth } from '@/lib/auth';

interface Valuation {
  inventoryValue: number;
  totalUnits: number;
  distinctSkus: number;
  outOfStockRows: number;
  belowReorderPointRows: number;
  overstockRows: number;
}

interface AlertRow {
  id: string;
  type: string;
  severity: string;
  message: string;
  currentValue: string;
  threshold: string;
  createdAt: string;
  product: { id: string; sku: string; name: string };
}

export default function InventoryPage() {
  const client = useQueryClient();
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [belowReorder, setBelowReorder] = useState(false);
  const [page, setPage] = useState(1);

  const valuation = useQuery({
    queryKey: ['inventory', 'valuation'],
    queryFn: () => api<Valuation>('/inventory/valuation'),
  });

  const rows = useQuery({
    queryKey: ['inventory', { search, belowReorder, page }],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: '40' });
      if (search) params.set('search', search);
      if (belowReorder) params.set('belowReorderPoint', 'true');
      return api<Paginated<InventoryRow>>(`/inventory?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  const alerts = useQuery({
    queryKey: ['inventory', 'alerts'],
    queryFn: () => api<Paginated<AlertRow>>('/inventory/alerts?limit=15'),
  });

  const sweep = useMutation({
    mutationFn: () => api('/inventory/alerts/sweep', { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['inventory'] }),
  });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Tile label="Stock value" value={fmt.int(valuation.data?.inventoryValue)} unit="GHS" tone="signal" />
        <Tile label="Units" value={fmt.int(valuation.data?.totalUnits)} />
        <Tile label="SKUs" value={fmt.int(valuation.data?.distinctSkus)} />
        <Tile
          label="Out of stock"
          value={fmt.int(valuation.data?.outOfStockRows)}
          tone={valuation.data?.outOfStockRows ? 'alert' : 'ok'}
        />
        <Tile
          label="Below reorder"
          value={fmt.int(valuation.data?.belowReorderPointRows)}
          tone={valuation.data?.belowReorderPointRows ? 'warn' : 'ok'}
        />
        <Tile
          label="Overstocked"
          value={fmt.int(valuation.data?.overstockRows)}
          tone={valuation.data?.overstockRows ? 'warn' : 'ok'}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Panel
          title="Stock by product and warehouse"
          loading={rows.isFetching}
          actions={
            <div className="flex items-center gap-2">
              <input
                className="field !py-1 !text-[0.6875rem]"
                style={{ width: 170 }}
                placeholder="sku or name"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
              />
              <label className="flex cursor-pointer items-center gap-1.5 text-[0.625rem] uppercase tracking-[0.1em]">
                <input
                  type="checkbox"
                  checked={belowReorder}
                  onChange={(event) => {
                    setBelowReorder(event.target.checked);
                    setPage(1);
                  }}
                  className="accent-[var(--color-signal)]"
                />
                below reorder
              </label>
            </div>
          }
        >
          {rows.isError ? (
            <ErrorNote error={rows.error} />
          ) : rows.isLoading ? (
            <Loading />
          ) : rows.data && rows.data.data.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Product</th>
                    <th>Warehouse</th>
                    <th className="text-right">Free</th>
                    <th className="text-right">Reserved</th>
                    <th className="text-right">Incoming</th>
                    <th className="text-right">Reorder pt</th>
                    <th className="w-24">Cover</th>
                    <th className="text-right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.data.data.map((row) => {
                    const reorderPoint = Number(row.reorderPoint);
                    const ratio = reorderPoint > 0 ? row.availableStock / (reorderPoint * 2) : 1;
                    return (
                      <tr key={row.id}>
                        <td className="font-mono text-[0.75rem]">{row.product.sku}</td>
                        <td className="max-w-[220px] truncate text-[var(--color-ink-dim)]">
                          {row.product.name}
                        </td>
                        <td className="font-mono text-[0.6875rem] text-[var(--color-ink-faint)]">
                          {row.warehouse.code}
                        </td>
                        <td
                          className={`tnum text-right font-mono ${
                            row.freeStock <= 0
                              ? 'text-[var(--color-alert)]'
                              : row.belowReorderPoint
                                ? 'text-[var(--color-warn)]'
                                : ''
                          }`}
                        >
                          {fmt.int(row.freeStock)}
                        </td>
                        <td className="tnum text-right font-mono text-[var(--color-ink-faint)]">
                          {fmt.int(row.reservedStock)}
                        </td>
                        <td className="tnum text-right font-mono text-[var(--color-info)]">
                          {row.incomingStock > 0 ? fmt.int(row.incomingStock) : '—'}
                        </td>
                        <td className="tnum text-right font-mono text-[var(--color-ink-faint)]">
                          {fmt.int(reorderPoint)}
                        </td>
                        <td>
                          <Meter
                            value={Math.min(1, ratio)}
                            tone={row.freeStock <= 0 ? 'alert' : row.belowReorderPoint ? 'warn' : 'ok'}
                          />
                        </td>
                        <td className="tnum text-right font-mono text-[var(--color-ink-dim)]">
                          {fmt.int(row.value)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No stock rows" />
          )}

          {rows.data && rows.data.meta.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-[var(--color-hairline)] px-3 py-2">
              <span className="font-mono text-[0.625rem] uppercase text-[var(--color-ink-faint)]">
                page {rows.data.meta.page} / {rows.data.meta.totalPages}
              </span>
              <div className="flex gap-2">
                <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  prev
                </button>
                <button
                  className="btn"
                  disabled={!rows.data.meta.hasNextPage}
                  onClick={() => setPage((p) => p + 1)}
                >
                  next
                </button>
              </div>
            </div>
          )}
        </Panel>

        <Panel
          title="Open alerts"
          meta={alerts.data ? <Chip tone="neutral">{alerts.data.meta.total}</Chip> : null}
          actions={
            can('inventory:update') ? (
              <button
                onClick={() => sweep.mutate()}
                disabled={sweep.isPending}
                className="hover:text-[var(--color-signal)]"
              >
                {sweep.isPending ? 'sweeping…' : 're-evaluate'}
              </button>
            ) : null
          }
        >
          {alerts.data && alerts.data.data.length > 0 ? (
            <ul className="divide-y divide-[var(--color-hairline)]">
              {alerts.data.data.map((alert) => (
                <li key={alert.id} className="px-3.5 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[0.6875rem]">{alert.product.sku}</span>
                    <Chip
                      tone={
                        alert.severity === 'CRITICAL'
                          ? 'alert'
                          : alert.severity === 'HIGH'
                            ? 'warn'
                            : 'neutral'
                      }
                    >
                      {alert.type.replace(/_/g, ' ')}
                    </Chip>
                  </div>
                  <p className="mt-1 text-[0.75rem] text-[var(--color-ink-dim)]">{alert.message}</p>
                  <div className="mt-1 font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
                    {fmt.relative(alert.createdAt)}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              title="No open alerts"
              hint="Alerts resolve themselves when the condition clears, so an empty list means the stock position is healthy."
            />
          )}
        </Panel>
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  unit,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: 'ok' | 'warn' | 'alert' | 'signal' | 'neutral';
}) {
  const colour = {
    ok: 'var(--color-ok)',
    warn: 'var(--color-warn)',
    alert: 'var(--color-alert)',
    signal: 'var(--color-signal)',
    neutral: 'var(--color-ink)',
  }[tone];

  return (
    <div className="panel px-3.5 py-2.5">
      <div className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="tnum font-mono text-lg" style={{ color: colour }}>
          {value}
        </span>
        {unit && <span className="font-mono text-[0.5625rem] text-[var(--color-ink-faint)]">{unit}</span>}
      </div>
    </div>
  );
}
