'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Chip, Empty, ErrorNote, Loading, Meter, Panel, fmt } from '@/components/ui';
import { useAuth } from '@/lib/auth';

interface LeaderboardRow {
  rank: number;
  id: string;
  code: string;
  name: string;
  country: string;
  reliabilityScore: number;
  onTimeDeliveryRate: number;
  qualityAcceptanceRate: number;
  fillRate: number;
  observedLeadTimeDays: number;
  observedLeadTimeStdDays: number;
  ordersPlaced: number;
  scoreIsMeasured: boolean;
  performanceUpdatedAt: string | null;
}

export default function SuppliersPage() {
  const client = useQueryClient();
  const { can } = useAuth();

  const leaderboard = useQuery({
    queryKey: ['suppliers', 'leaderboard'],
    queryFn: () => api<LeaderboardRow[]>('/suppliers/leaderboard?limit=50'),
  });

  const recompute = useMutation({
    mutationFn: () => api('/suppliers/recompute-performance', { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['suppliers'] }),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Supplier performance</h1>
        <p className="mt-0.5 max-w-3xl text-[0.8125rem] leading-relaxed text-[var(--color-ink-dim)]">
          Reliability is computed from each supplier’s own purchase-order history, not entered by
          hand. Rates are shrunk toward a neutral prior when there are few orders, so one late
          delivery out of two does not brand a new supplier as 50 % reliable.
        </p>
      </div>

      <Panel
        title="League table"
        loading={leaderboard.isFetching}
        actions={
          can('supplier:update') ? (
            <button
              onClick={() => recompute.mutate()}
              disabled={recompute.isPending}
              className="hover:text-[var(--color-signal)]"
            >
              {recompute.isPending ? 'recomputing…' : 'recompute all'}
            </button>
          ) : null
        }
      >
        {leaderboard.isError ? (
          <ErrorNote error={leaderboard.error} />
        ) : leaderboard.isLoading ? (
          <Loading />
        ) : leaderboard.data && leaderboard.data.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="grid-table">
              <thead>
                <tr>
                  <th className="w-8">#</th>
                  <th>Supplier</th>
                  <th>Country</th>
                  <th className="w-32">Reliability</th>
                  <th className="text-right">On time</th>
                  <th className="text-right">Quality</th>
                  <th className="text-right">Fill rate</th>
                  <th className="text-right">Lead time</th>
                  <th className="text-right">Orders</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {leaderboard.data.map((supplier) => (
                  <tr key={supplier.id}>
                    <td className="tnum font-mono text-[0.6875rem] text-[var(--color-ink-faint)]">
                      {supplier.rank}
                    </td>
                    <td>
                      <span className="block text-[0.8125rem]">{supplier.name}</span>
                      <span className="font-mono text-[0.625rem] text-[var(--color-ink-faint)]">
                        {supplier.code}
                      </span>
                    </td>
                    <td className="font-mono text-[0.6875rem] text-[var(--color-ink-dim)]">
                      {supplier.country}
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="flex-1">
                          <Meter
                            value={supplier.reliabilityScore / 100}
                            tone={
                              supplier.reliabilityScore >= 90
                                ? 'ok'
                                : supplier.reliabilityScore >= 80
                                  ? 'signal'
                                  : 'alert'
                            }
                          />
                        </div>
                        <span className="tnum font-mono text-[0.75rem]">
                          {fmt.num(supplier.reliabilityScore, 1)}
                        </span>
                      </div>
                    </td>
                    <td className="tnum text-right font-mono text-[0.75rem]">
                      {fmt.pct(supplier.onTimeDeliveryRate, 1)}
                    </td>
                    <td className="tnum text-right font-mono text-[0.75rem]">
                      {fmt.pct(supplier.qualityAcceptanceRate, 1)}
                    </td>
                    <td className="tnum text-right font-mono text-[0.75rem]">
                      {fmt.pct(supplier.fillRate, 1)}
                    </td>
                    <td className="tnum whitespace-nowrap text-right font-mono text-[0.75rem] text-[var(--color-ink-dim)]">
                      {fmt.num(supplier.observedLeadTimeDays, 1)}
                      <span className="text-[var(--color-ink-faint)]">
                        {' '}
                        ± {fmt.num(supplier.observedLeadTimeStdDays, 1)} d
                      </span>
                    </td>
                    <td className="tnum text-right font-mono text-[0.75rem] text-[var(--color-ink-faint)]">
                      {supplier.ordersPlaced}
                    </td>
                    <td className="text-right">
                      {supplier.scoreIsMeasured ? (
                        <Chip tone="ok">measured</Chip>
                      ) : (
                        <Chip tone="neutral">prior</Chip>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-[var(--color-hairline)] px-3 py-2 text-[0.6875rem] leading-relaxed text-[var(--color-ink-faint)]">
              A “prior” badge means no performance has been computed for that supplier yet — the
              score is the neutral starting value, not a measurement. Lead-time spread is what
              drives safety stock: a supplier at 5 ± 4 days costs more buffer than one at 12 ± 0.5.
            </div>
          </div>
        ) : (
          <Empty title="No suppliers" />
        )}
      </Panel>
    </div>
  );
}
