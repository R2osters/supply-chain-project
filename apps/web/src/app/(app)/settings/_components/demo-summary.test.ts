import { describe, expect, it } from 'vitest';
import { rehearsalSummary } from './demo-summary';

const base = {
  shipments: 11,
  delayedSoon: ['SHP-DEMO-0054', 'SHP-DEMO-0055'],
  inventoryReset: true,
  cancelledOrders: [],
  clearedRecommendations: 0,
};

describe('rehearsalSummary', () => {
  it('says what was staged, in the order the demo uses it', () => {
    expect(rehearsalSummary(base).map((line) => line.key)).toEqual([
      'settings.demo.result.shipments',
      'settings.demo.result.delayed',
      'settings.demo.result.inventory',
    ]);
    expect(rehearsalSummary(base)[0].params).toEqual({ count: 11 });
    expect(rehearsalSummary(base)[1].params).toEqual({ list: 'SHP-DEMO-0054, SHP-DEMO-0055' });
  });

  it('mentions what a previous demo left behind only when something was cleared', () => {
    const lines = rehearsalSummary({ ...base, cancelledOrders: ['PO-1', 'PO-2'], clearedRecommendations: 3 });
    expect(lines.slice(3)).toEqual([
      { key: 'settings.demo.result.orders', params: { count: 2, list: 'PO-1, PO-2' } },
      { key: 'settings.demo.result.recommendations', params: { count: 3 } },
    ]);
  });

  it('does not claim a stock reset or a delay that did not happen', () => {
    const keys = rehearsalSummary({ ...base, delayedSoon: [], inventoryReset: false }).map((line) => line.key);
    expect(keys).toEqual(['settings.demo.result.shipments']);
  });
});
