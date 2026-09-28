import { normalizeOntario511 } from './ontario511.pack';

const row = (overrides: Record<string, unknown> = {}) => ({
  Id: 12,
  Latitude: 43.6532,
  Longitude: -79.3832,
  Location: 'Hwy 401 near Yonge St',
  Roadway: 'Highway 401',
  Direction: 'Eastbound',
  Views: [
    { Url: 'https://511on.ca/map/Cctv/99', Status: 'Enabled', Description: 'Camera down' },
    { Url: 'https://511on.ca/map/Cctv/100', Status: 'Enabled', Description: 'Toronto Bound' },
  ],
  ...overrides,
});

describe('normalizeOntario511', () => {
  it('picks the first enabled view that is not down and reads the travel direction', () => {
    expect(normalizeOntario511([row()])).toEqual([
      {
        upstreamId: '12',
        name: 'Hwy 401 near Yonge St - Toronto Bound',
        latitude: 43.6532,
        longitude: -79.3832,
        headingDegrees: 90,
        direction: 'Eastbound',
        frameUrl: 'https://511on.ca/map/Cctv/100',
      },
    ]);
  });

  it('rebuilds view URLs on the canonical host and drops foreign ones', () => {
    const legacy = row({ Views: [{ Url: 'https://on.traveliq.co/map/Cctv/7', Status: 'Enabled' }] });
    expect(normalizeOntario511([legacy])[0].frameUrl).toBe('https://511on.ca/map/Cctv/7');

    const foreign = row({ Views: [{ Url: 'https://evil.example/map/Cctv/7', Status: 'Enabled' }] });
    expect(normalizeOntario511([foreign])).toEqual([]);
  });

  it('treats an "Unknown" direction as no direction', () => {
    const [camera] = normalizeOntario511([row({ Direction: 'Unknown' })]);
    expect(camera.direction).toBeNull();
  });

  it('drops rows outside Ontario', () => {
    expect(normalizeOntario511([row({ Latitude: 0, Longitude: 0 })])).toEqual([]);
  });
});
