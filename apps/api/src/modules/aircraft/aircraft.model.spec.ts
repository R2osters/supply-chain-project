import {
  circleAround,
  clampBoundingBox,
  fromAdsbLol,
  fromOpenSkyState,
  openSkyTtlMs,
  parseBoundingBox,
  snapBoundingBox,
} from './aircraft.model';

describe('aircraft model', () => {
  describe('bounding boxes', () => {
    it('parses a valid box and rejects inverted or out-of-range ones', () => {
      expect(parseBoundingBox({ minLat: '48', minLon: '2', maxLat: '49', maxLon: '3' })).toEqual({
        minLat: 48,
        minLon: 2,
        maxLat: 49,
        maxLon: 3,
      });
      expect(parseBoundingBox({ minLat: '49', minLon: '2', maxLat: '48', maxLon: '3' })).toBeNull();
      expect(parseBoundingBox({ minLat: '-95', minLon: '2', maxLat: '48', maxLon: '3' })).toBeNull();
      expect(parseBoundingBox({ minLat: 'x' })).toBeNull();
    });

    it('shrinks a very wide view around its centre', () => {
      const box = clampBoundingBox({ minLat: -60, minLon: -170, maxLat: 70, maxLon: 170 }, 20);
      expect(box).toEqual({ minLat: -5, minLon: -10, maxLat: 15, maxLon: 10 });
    });

    it('snaps outward so neighbouring views share a cache entry', () => {
      expect(snapBoundingBox({ minLat: 48.3, minLon: 2.1, maxLat: 48.9, maxLon: 2.7 })).toEqual({
        minLat: 48,
        minLon: 2,
        maxLat: 49,
        maxLon: 3,
      });
    });

    it('covers a box with a circle for the adsb.lol point query, capped at 250 nm', () => {
      const small = circleAround({ minLat: 48, minLon: 2, maxLat: 49, maxLon: 3 });
      expect(small.lat).toBe(48.5);
      expect(small.lon).toBe(2.5);
      expect(small.radiusNm).toBeGreaterThan(30);
      expect(small.radiusNm).toBeLessThan(40);
      expect(circleAround({ minLat: 0, minLon: 0, maxLat: 20, maxLon: 20 }).radiusNm).toBe(250);
    });
  });

  describe('normalisation', () => {
    it('reads an OpenSky state row, converting m/s to knots', () => {
      const row = ['3c6444', 'DLH9U  ', 'Germany', 1, 1, 8.5, 50.03, 1000, false, 100, 270, -2.5, null, 1050, null, false, 0];
      expect(fromOpenSkyState(row)).toEqual({
        id: '3c6444',
        callsign: 'DLH9U',
        registration: null,
        type: null,
        latitude: 50.03,
        longitude: 8.5,
        altitudeM: 1050,
        speedKts: 194,
        trackDeg: 270,
        verticalRateMs: -2.5,
        onGround: false,
        originCountry: 'Germany',
      });
    });

    it('drops OpenSky rows without a position', () => {
      expect(fromOpenSkyState(['abc', 'X', 'Y', 1, 1, null, null])).toBeNull();
    });

    it('reads an adsb.lol entry, converting feet to metres', () => {
      const aircraft = fromAdsbLol({
        hex: '39D026',
        flight: 'EAP62   ',
        r: 'F-HUBG',
        t: 'P68',
        alt_baro: 6075,
        gs: 134,
        track: 154.86,
        baro_rate: 151,
        lat: 48.86,
        lon: 1.18,
      });
      expect(aircraft).toMatchObject({
        id: '39d026',
        callsign: 'EAP62',
        registration: 'F-HUBG',
        type: 'P68',
        altitudeM: 1852,
        speedKts: 134,
        trackDeg: 154.86,
        verticalRateMs: 0.8,
        onGround: false,
      });
    });

    it('treats adsb.lol "ground" altitude as on the ground', () => {
      expect(fromAdsbLol({ hex: 'abc', lat: 1, lon: 2, alt_baro: 'ground' })).toMatchObject({
        onGround: true,
        altitudeM: 0,
      });
    });
  });

  it('stretches the cache as the OpenSky credit budget thins', () => {
    expect(openSkyTtlMs(null)).toBe(10_000);
    expect(openSkyTtlMs(3000)).toBe(10_000);
    expect(openSkyTtlMs(2000)).toBe(30_000);
    expect(openSkyTtlMs(800)).toBe(90_000);
    expect(openSkyTtlMs(100)).toBe(300_000);
  });

  it('scales the tiers to the anonymous 400-credit quota', () => {
    expect(openSkyTtlMs(398, 400)).toBe(10_000);
    expect(openSkyTtlMs(200, 400)).toBe(30_000);
    expect(openSkyTtlMs(20, 400)).toBe(300_000);
  });
});
