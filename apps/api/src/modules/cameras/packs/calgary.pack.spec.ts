import { normalizeCalgary } from './calgary.pack';

const row = (overrides: Record<string, unknown> = {}) => ({
  camera_url: { url: 'http://trafficcam.calgary.ca/loc86.jpg', description: 'Camera 87' },
  quadrant: 'SE',
  camera_location: 'Stoney Trail / Deerfoot Trail SE',
  point: { type: 'Point', coordinates: [-113.9766063, 50.9007257] },
  ...overrides,
});

describe('normalizeCalgary', () => {
  it('upgrades the frame URL to https, keys on the file number and derives no heading', () => {
    expect(normalizeCalgary([row()])).toEqual([
      {
        upstreamId: '86',
        name: 'Stoney Trail / Deerfoot Trail SE',
        latitude: 50.9007257,
        longitude: -113.9766063,
        // "SE" is an address quadrant, not a facing.
        headingDegrees: null,
        direction: null,
        frameUrl: 'https://trafficcam.calgary.ca/loc86.jpg',
      },
    ]);
  });

  it('drops frames on other hosts or non-default ports', () => {
    const elsewhere = row({ camera_url: { url: 'http://example.com/loc1.jpg' } });
    const port = row({ camera_url: { url: 'http://trafficcam.calgary.ca:8080/loc1.jpg' } });
    expect(normalizeCalgary([elsewhere, port])).toEqual([]);
  });

  it('keeps one camera when a row is listed twice', () => {
    expect(normalizeCalgary([row(), row()])).toHaveLength(1);
  });
});
