import { normalizeFintraffic } from './fintraffic.pack';

const station = (overrides: Record<string, unknown> = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [23.99616, 60.05374, 0] },
  properties: {
    id: 'C01503',
    name: 'kt51_Inkoo',
    collectionStatus: 'GATHERING',
    presets: [
      { id: 'C0150301', inCollection: true },
      { id: 'C0150302', inCollection: false },
      { id: 'C0150309', inCollection: true },
    ],
    ...overrides,
  },
});

describe('normalizeFintraffic', () => {
  it('turns each collecting preset into a camera with a frame URL built from its id', () => {
    const cameras = normalizeFintraffic({ features: [station()] });
    expect(cameras.map((camera) => camera.upstreamId)).toEqual(['C0150301', 'C0150309']);
    expect(cameras[0]).toEqual({
      upstreamId: 'C0150301',
      name: 'kt51 Inkoo (vue 01)',
      latitude: 60.05374,
      longitude: 23.99616,
      headingDegrees: null,
      direction: null,
      frameUrl: 'https://weathercam.digitraffic.fi/C0150301.jpg',
    });
  });

  it('skips stations that are not gathering images', () => {
    expect(normalizeFintraffic({ features: [station({ collectionStatus: 'REMOVED_TEMPORARILY' })] })).toEqual([]);
  });

  it('refuses preset ids that do not have the official shape', () => {
    const hostile = station({ presets: [{ id: 'C01503/../../x', inCollection: true }] });
    expect(normalizeFintraffic({ features: [hostile] })).toEqual([]);
  });

  it('returns nothing for a payload without features', () => {
    expect(normalizeFintraffic(null)).toEqual([]);
    expect(normalizeFintraffic({})).toEqual([]);
  });
});
