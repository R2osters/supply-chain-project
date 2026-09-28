import { normalizeNsw } from './nsw.pack';

const feature = (overrides: Record<string, unknown> = {}, props: Record<string, unknown> = {}) => ({
  type: 'Feature',
  id: '023651ee-389c-4677-978e-d39b6c24c1e7',
  geometry: { type: 'Point', coordinates: [151.10533, -34.02977] },
  properties: {
    region: 'SYD_SOUTH',
    title: '5 Ways (Miranda)',
    view: '5 Ways at The Boulevarde looking west towards Sutherland.',
    direction: 'N-E',
    href: 'https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/5_ways_miranda.jpeg',
    ...props,
  },
  ...overrides,
});

describe('normalizeNsw', () => {
  it('maps a feature, reading "N-E" as 45 degrees and using the view sentence as the name', () => {
    expect(normalizeNsw({ features: [feature()] })).toEqual([
      {
        upstreamId: '023651ee-389c-4677-978e-d39b6c24c1e7',
        name: '5 Ways at The Boulevarde looking west towards Sutherland.',
        latitude: -34.02977,
        longitude: 151.10533,
        headingDegrees: 45,
        direction: 'N-E',
        frameUrl: 'https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/5_ways_miranda.jpeg',
      },
    ]);
  });

  it('falls back to the title when `view` is a works notice', () => {
    const [camera] = normalizeNsw({ features: [feature({}, { view: 'Roadworks.\nExpect delays.' })] });
    expect(camera.name).toBe('5 Ways (Miranda)');
  });

  it('drops frames on any other host and null coordinates', () => {
    expect(normalizeNsw({ features: [feature({}, { href: 'https://example.com/a.jpeg' })] })).toEqual([]);
    expect(normalizeNsw({ features: [feature({ geometry: { coordinates: [null, null] } })] })).toEqual([]);
  });
});
