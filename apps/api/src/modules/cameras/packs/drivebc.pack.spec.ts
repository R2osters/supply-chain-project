import { normalizeDriveBc } from './drivebc.pack';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 478,
  name: 'Lempriere',
  is_on: true,
  should_appear: true,
  orientation: 'S',
  location: { type: 'Point', coordinates: [-119.179818, 52.38554] },
  // A retired-host URL in the payload must never be what we fetch.
  links: { imageDisplay: 'https://images.drivebc.ca/bchighwaycam/pub/cameras/478.jpg' },
  ...overrides,
});

describe('normalizeDriveBc', () => {
  it('builds the frame URL from the numeric id and reads the orientation as a bearing', () => {
    expect(normalizeDriveBc([row()])).toEqual([
      {
        upstreamId: '478',
        name: 'Lempriere',
        latitude: 52.38554,
        longitude: -119.179818,
        headingDegrees: 180,
        direction: 'S',
        frameUrl: 'https://www.drivebc.ca/images/478.jpg',
      },
    ]);
  });

  it('skips cameras that are off or unpublished', () => {
    expect(normalizeDriveBc([row({ is_on: false }), row({ id: 479, should_appear: false })])).toEqual([]);
  });

  it('refuses non-integer ids', () => {
    expect(normalizeDriveBc([row({ id: '478/../x' }), row({ id: 1.5 })])).toEqual([]);
  });
});
