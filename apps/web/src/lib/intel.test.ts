import { describe, expect, it } from 'vitest';
import { HAZARD_KINDS, boundsQuery, newsKeyword, safeExternalUrl, type Hazard } from './intel';

function hazard(overrides: Partial<Hazard>): Hazard {
  return {
    id: 'h1',
    kind: 'EARTHQUAKE',
    title: 'M 5.1 - 12 km SSW of Tema, Ghana',
    severity: 'MEDIUM',
    severityScore: 0.5,
    latitude: 5.5,
    longitude: 0,
    radiusKm: 50,
    observedAt: '2026-09-28T10:00:00Z',
    source: 'USGS',
    url: null,
    details: {},
    track: null,
    cone: null,
    ...overrides,
  };
}

describe('safeExternalUrl', () => {
  it('keeps http and https links', () => {
    expect(safeExternalUrl('https://example.org/a')).toBe('https://example.org/a');
  });

  it('drops script and data URLs written by third parties', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,hi')).toBeNull();
    expect(safeExternalUrl('not a url')).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
  });
});

describe('boundsQuery', () => {
  it('rounds outward so the box still covers the view', () => {
    const query = new URLSearchParams(boundsQuery({ minLat: 5.04, minLon: -1.06, maxLat: 6.01, maxLon: 0.02 }, 1));
    expect(query.get('minLat')).toBe('5');
    expect(query.get('minLon')).toBe('-1.1');
    expect(query.get('maxLat')).toBe('6.1');
    expect(query.get('maxLon')).toBe('0.1');
  });

  it('clamps to valid coordinates', () => {
    const query = new URLSearchParams(boundsQuery({ minLat: -95, minLon: -200, maxLat: 95, maxLon: 200 }, 0));
    expect(query.get('minLat')).toBe('-90');
    expect(query.get('maxLon')).toBe('180');
  });
});

describe('newsKeyword', () => {
  it('searches the place a USGS title names, not the magnitude', () => {
    expect(newsKeyword(hazard({}))).toBe('Tema, Ghana');
  });

  it('prefers an explicit place detail', () => {
    expect(newsKeyword(hazard({ details: { place: '40 km N of Kumasi, Ghana' } }))).toBe('Kumasi, Ghana');
  });

  it('uses the title of other hazards as is', () => {
    expect(newsKeyword(hazard({ kind: 'CYCLONE', title: 'Hurricane Maria' }))).toBe('Hurricane Maria');
  });

  it('searches the place the API names for GDACS and EONET hazards', () => {
    expect(newsKeyword(hazard({ kind: 'FLOOD', title: 'Flood in Guinea', details: { place: 'Guinea' } }))).toBe('Guinea');
    expect(newsKeyword(hazard({ kind: 'VOLCANO', title: 'Eruption Etna', details: { place: 'Etna' } }))).toBe('Etna');
    expect(
      newsKeyword(hazard({ kind: 'FIRE', title: 'Wildfire Rafter 4B, Schleicher, Texas', details: { place: 'Schleicher, Texas' } })),
    ).toBe('Schleicher, Texas');
  });
});

describe('HAZARD_KINDS', () => {
  it('lists every kind once, the keyless GDACS kinds included', () => {
    expect(new Set(HAZARD_KINDS).size).toBe(HAZARD_KINDS.length);
    expect(HAZARD_KINDS).toEqual(expect.arrayContaining(['FLOOD', 'DROUGHT', 'VOLCANO']));
  });
});
