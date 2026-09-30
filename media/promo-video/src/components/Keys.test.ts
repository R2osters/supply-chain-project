// src/components/Keys.test.ts — geometry of the supplier keyboard (spec § 4 S13: five tall keys, 180 × 520 px).
import {capOffset, fillHeight, KEY_GAP, KEY_H, KEY_TRAVEL, KEY_W, keyboardWidth, keyLeft} from './Keys';

describe('Keys geometry', () => {
  it('uses the spec key size, 180 × 520 px', () => {
    expect(KEY_W).toBe(180);
    expect(KEY_H).toBe(520);
  });

  it('lays five keys side by side with one gap between neighbours', () => {
    expect(keyLeft(0)).toBe(0);
    expect(keyLeft(1)).toBe(KEY_W + KEY_GAP);
    expect(keyLeft(4)).toBe(4 * (KEY_W + KEY_GAP));
    expect(keyboardWidth(5)).toBe(keyLeft(4) + KEY_W);
  });

  it('fills a key from its bottom edge in proportion to its share of the order', () => {
    expect(fillHeight(0)).toBe(0);
    expect(fillHeight(0.5)).toBe(KEY_H / 2);
    expect(fillHeight(1)).toBe(KEY_H);
    expect(fillHeight(1.4)).toBe(KEY_H);
    expect(fillHeight(-0.2)).toBe(0);
  });

  it('draws the cap where a fill of the same share tops out on a key at rest', () => {
    expect(capOffset(0.5)).toBe(KEY_H - fillHeight(0.5));
    expect(capOffset(0.5)).toBe(260);
  });

  it('presses a key by a few px, never through its neighbours', () => {
    expect(KEY_TRAVEL).toBeGreaterThan(0);
    expect(KEY_TRAVEL).toBeLessThanOrEqual(16);
  });
});
