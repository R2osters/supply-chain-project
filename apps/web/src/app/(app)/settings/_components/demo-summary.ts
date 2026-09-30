import type { TranslationKey } from '@/lib/i18n';

/** `POST /setup/demo/rehearse` */
export interface RehearsalResult {
  shipments: number;
  delayedSoon: string[];
  inventoryReset: boolean;
  cancelledOrders: string[];
  clearedRecommendations: number;
}

export interface SummaryLine {
  key: TranslationKey;
  params?: Record<string, string | number>;
}

/** What a rehearsal did, one line each, leaving out what did not happen. */
export function rehearsalSummary(result: RehearsalResult): SummaryLine[] {
  const lines: SummaryLine[] = [{ key: 'settings.demo.result.shipments', params: { count: result.shipments } }];
  if (result.delayedSoon.length > 0) {
    lines.push({ key: 'settings.demo.result.delayed', params: { list: result.delayedSoon.join(', ') } });
  }
  if (result.inventoryReset) lines.push({ key: 'settings.demo.result.inventory' });
  if (result.cancelledOrders.length > 0) {
    lines.push({
      key: 'settings.demo.result.orders',
      params: { count: result.cancelledOrders.length, list: result.cancelledOrders.join(', ') },
    });
  }
  if (result.clearedRecommendations > 0) {
    lines.push({ key: 'settings.demo.result.recommendations', params: { count: result.clearedRecommendations } });
  }
  return lines;
}
