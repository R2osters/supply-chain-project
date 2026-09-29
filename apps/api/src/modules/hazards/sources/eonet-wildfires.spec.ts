import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  eonetFireToHazard,
  eonetUrl,
  fireAreaScore,
  parseEonetFires,
  placeFromTitle,
} from './eonet-wildfires';

// Real EONET v3 events of 2026-09-28/29: two live IRWIN wildfires, a prescribed burn, an old
// GDACS copy EONET never closed, a 2024 fire still "open", and a GDACS copy closed on arrival.
const FIXTURE = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'eonet-wildfires.json'), 'utf8')) as {
  events: unknown[];
};
const NOW = Date.UTC(2026, 8, 28, 12, 0);

describe('EONET wildfires', () => {
  it('keeps live wildfires and drops burns, stale events, closed events and GDACS copies', () => {
    const fires = parseEonetFires(FIXTURE, NOW);
    expect(fires.map((f) => f.id)).toEqual(['EONET_24904', 'EONET_24484']);
  });

  it('reads the position, the reported size in hectares and the incident link', () => {
    const [rafter] = parseEonetFires(FIXTURE, NOW);
    expect(rafter).toMatchObject({
      title: 'Wildfire Rafter 4B, Schleicher, Texas',
      description: '8 Miles SE from Eldorado, TX',
      latitude: 30.7663,
      longitude: -100.4981,
      lastSeenAt: '2026-09-26T15:18:00.000Z',
      reportedArea: '2125 acres',
      polygon: false,
      observations: 1,
      upstream: 'IRWIN',
      url: 'https://irwin.doi.gov/observer/incidents/2026-TXTXS-268989',
    });
    expect(rafter.areaHa).toBeCloseTo(860, 0);
  });

  it('refuses a payload without an events list', () => {
    expect(() => parseEonetFires({ title: 'EONET Events' }, NOW)).toThrow('events');
  });

  it('asks only for open wildfires of the last two weeks', () => {
    const url = new URL(eonetUrl());
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ status: 'open', category: 'wildfires', days: '14' });
  });

  it('places a perimeter at its centroid and remembers it had one', () => {
    const [fire] = parseEonetFires(
      {
        events: [
          {
            id: 'EONET_1',
            title: 'Wildfire Test, Somewhere, Oregon',
            closed: null,
            categories: [{ id: 'wildfires', title: 'Wildfires' }],
            sources: [{ id: 'IRWIN', url: 'https://irwin.doi.gov/observer/incidents/2026-ORXXX-1' }],
            geometry: [
              {
                magnitudeValue: 500,
                magnitudeUnit: 'acres',
                date: '2026-09-26T10:00:00Z',
                type: 'Point',
                coordinates: [-120, 44],
              },
              {
                magnitudeValue: 4200,
                magnitudeUnit: 'acres',
                date: '2026-09-27T10:00:00Z',
                type: 'Polygon',
                coordinates: [
                  [
                    [-121, 44],
                    [-121, 45],
                    [-120, 45],
                    [-120, 44],
                    [-121, 44],
                  ],
                ],
              },
            ],
          },
        ],
      },
      NOW,
    );
    expect(fire).toMatchObject({ latitude: 44.5, longitude: -120.5, polygon: true, observations: 2 });
    expect(fire.firstSeenAt).toBe('2026-09-26T10:00:00.000Z');
    expect(fire.reportedArea).toBe('4200 acres');
  });

  it('scores burned area on a conservative log scale', () => {
    expect([100, 1_000, 10_000, 100_000, 1_000_000].map(fireAreaScore)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('makes a FIRE hazard named after the incident, with its county as the news place', () => {
    const [rafter] = parseEonetFires(FIXTURE, NOW);
    expect(eonetFireToHazard(rafter)).toMatchObject({
      id: 'eonet:EONET_24904',
      kind: 'FIRE',
      title: 'Wildfire Rafter 4B, Schleicher, Texas',
      severity: 'LOW',
      severityScore: 0.23,
      radiusKm: 10,
      source: 'NASA EONET',
      observedAt: '2026-09-26T15:18:00.000Z',
      details: expect.objectContaining({ areaHa: 860, place: 'Schleicher, Texas', eonetId: 'EONET_24904' }),
    });
    expect(placeFromTitle('Wildfire without a county')).toBeNull();
  });
});
