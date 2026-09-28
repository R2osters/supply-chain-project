import { normalizeTfl } from './tfl.pack';

const place = (overrides: Record<string, unknown> = {}, props: Record<string, string> = {}) => ({
  id: 'JamCams_00002.00865',
  commonName: 'A406 Billet Upass E',
  lat: 51.60067,
  lon: -0.01594,
  additionalProperties: Object.entries({
    available: 'true',
    imageUrl: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.jpg',
    ...props,
  }).map(([key, value]) => ({ key, value })),
  ...overrides,
});

describe('normalizeTfl', () => {
  it('maps a JamCam place to a camera with the JamCams_ prefix stripped', () => {
    expect(normalizeTfl([place()])).toEqual([
      {
        upstreamId: '00002.00865',
        name: 'A406 Billet Upass E',
        latitude: 51.60067,
        longitude: -0.01594,
        headingDegrees: null,
        direction: null,
        frameUrl: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.jpg',
      },
    ]);
  });

  it('drops cameras TfL marks as unavailable', () => {
    expect(normalizeTfl([place({}, { available: 'false' })])).toEqual([]);
  });

  it('drops frames outside the TfL bucket even on the same S3 host', () => {
    const foreign = place({}, { imageUrl: 'https://s3-eu-west-1.amazonaws.com/someone-else/x.jpg' });
    expect(normalizeTfl([foreign])).toEqual([]);
  });

  it('drops rows outside London and tolerates junk', () => {
    expect(normalizeTfl([place({ lat: 0, lon: 0 }), null, 'x', {}])).toEqual([]);
    expect(normalizeTfl({ not: 'an array' })).toEqual([]);
  });
});
