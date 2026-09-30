import { describe, expect, it } from 'vitest';
import { parseBudget } from './traffic-budget-value';

describe('parseBudget', () => {
  it('accepts whole numbers of tiles, 0 meaning unlimited', () => {
    expect(parseBudget('0')).toBe(0);
    expect(parseBudget(' 6000 ')).toBe(6000);
    expect(parseBudget('10000000')).toBe(10_000_000);
  });

  it('refuses anything the API would refuse', () => {
    for (const bad of ['', '-1', '1.5', '1e3', '6 000', 'abc', '10000001', '123456789']) expect(parseBudget(bad)).toBeNull();
  });
});
