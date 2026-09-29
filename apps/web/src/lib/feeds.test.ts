import { describe, expect, it } from 'vitest';
import { buildFeedUpdate, isCoolingDown, isEmptyUpdate } from './feeds';

describe('buildFeedUpdate', () => {
  it('sends only what was typed, trimmed, under the PUT field names', () => {
    expect(buildFeedUpdate({ aisStream: '  abc123\n', marineTraffic: '', openskyClientId: 'me' })).toEqual({
      aisStreamApiKey: 'abc123',
      openskyClientId: 'me',
    });
  });

  it('sends null for a field marked for clearing, whatever was typed', () => {
    expect(buildFeedUpdate({ openskyClientSecret: 'typed' }, { openskyClientSecret: true, marineTraffic: true })).toEqual({
      marineTrafficApiKey: null,
      openskyClientSecret: null,
    });
  });

  it('is empty when nothing changed', () => {
    expect(isEmptyUpdate(buildFeedUpdate({ aisStream: '   ' }))).toBe(true);
    expect(isEmptyUpdate(buildFeedUpdate({}, { aisStream: true }))).toBe(false);
  });
});

describe('isCoolingDown', () => {
  const now = Date.parse('2026-09-29T10:00:00Z');
  it('is true only while the date is in the future', () => {
    expect(isCoolingDown({ coolingDownUntil: '2026-09-29T10:05:00Z' }, now)).toBe(true);
    expect(isCoolingDown({ coolingDownUntil: '2026-09-29T09:55:00Z' }, now)).toBe(false);
    expect(isCoolingDown({ coolingDownUntil: null }, now)).toBe(false);
    expect(isCoolingDown({ coolingDownUntil: 'garbage' }, now)).toBe(false);
  });
});
