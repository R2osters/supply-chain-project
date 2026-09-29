import {rand} from './prng';
import {dampedSpring} from './spring';
import {frInt, frDecimal, frPercent} from './format';
import {palette, signal} from '../theme/tokens';

describe('prng', () => {
  it('is deterministic and in range', () => {
    expect(rand(7, 1, 2)).toBe(rand(7, 1, 2));
    expect(rand(7, 1, 2)).not.toBe(rand(7, 1, 3));
    for (let i = 0; i < 1000; i++) { const r = rand(1, i); expect(r).toBeGreaterThanOrEqual(0); expect(r).toBeLessThan(1); }
  });
});
describe('dampedSpring', () => {
  it('starts at from, overshoots to ~73 and settles on to', () => {
    const cfg = {from: 0, to: 68, damping: 12, stiffness: 90};
    expect(dampedSpring(0, cfg)).toBe(0);
    const peak = Math.max(...Array.from({length: 60}, (_, f) => dampedSpring(f, cfg)));
    expect(peak).toBeGreaterThan(72);
    expect(peak).toBeLessThan(75);
    expect(dampedSpring(90, cfg)).toBeCloseTo(68, 1);
  });
});
describe('format', () => {
  it('uses French typography', () => {
    expect(frInt(3000)).toBe('3\u202f000');
    expect(frInt(20000)).toBe('20\u202f000');
    expect(frDecimal(24.13, 2)).toBe('24,13');
    expect(frPercent(68)).toBe('68\u00a0%');
  });
});
describe('tokens', () => {
  it('follows the charter', () => {
    expect(palette('light').bg).toBe('#e3e4e6');
    expect(palette('dark').bg).toBe('#121314');
    expect(signal('light', 'crit')).toBe('#c8412f');
    expect(signal('dark', 'demo')).toBe('#a993ec');
  });
});
