import { describe, expect, it } from 'vitest';
import {
  LIVE_ICON,
  aircraftSourceLabel,
  aircraftTitle,
  aircraftToGeoJson,
  bboxFromBounds,
  bboxQuery,
  extrapolate,
  extrapolateAircraft,
  formatAltitude,
  formatBearing,
  formatKnots,
  formatVerticalRate,
  normaliseBearing,
  vesselBearing,
  vesselSourceLabel,
  vesselTitle,
  vesselsToGeoJson,
  type Aircraft,
  type Vessel,
} from './live-traffic';

const bounds = (west: number, south: number, east: number, north: number) => ({
  getWest: () => west,
  getSouth: () => south,
  getEast: () => east,
  getNorth: () => north,
});

const plane: Aircraft = {
  id: '3c6444',
  callsign: 'DLH4AB ',
  registration: 'D-AIBL',
  type: 'A319',
  latitude: 6.6,
  longitude: -1.2,
  altitudeM: 10668,
  speedKts: 450,
  trackDeg: 370,
  verticalRateMs: -5.2,
  onGround: false,
  originCountry: 'Germany',
};

const ship: Vessel = {
  mmsi: '636019825',
  name: 'MSC TEMA',
  latitude: 5.6,
  longitude: 0.01,
  speedKnots: 12.4,
  courseDegrees: 95,
  headingDegrees: 511,
  navStatus: 'Under way using engine',
  destination: 'GHTEM',
  tracked: false,
  lastSeenAt: '2026-09-29T10:00:00Z',
};

describe('bboxFromBounds', () => {
  it('rounds outward to two decimals', () => {
    expect(bboxFromBounds(bounds(-1.234, 5.678, 0.111, 7.001))).toEqual({
      minLat: 5.67,
      maxLat: 7.01,
      minLon: -1.24,
      maxLon: 0.12,
    });
  });

  it('turns a view wider than the world into the whole world', () => {
    const box = bboxFromBounds(bounds(-400, -120, 300, 120));
    expect(box).toEqual({ minLat: -85, maxLat: 85, minLon: -180, maxLon: 180 });
  });

  it('clamps a view that crosses the antimeridian', () => {
    const box = bboxFromBounds(bounds(170, -10, 190, 10));
    expect(box.minLon).toBe(170);
    expect(box.maxLon).toBe(180);
  });

  it('serialises to the query string the API expects', () => {
    expect(bboxQuery({ minLat: 5.67, minLon: -1.24, maxLat: 7.01, maxLon: 0.12 })).toBe(
      'minLat=5.67&minLon=-1.24&maxLat=7.01&maxLon=0.12',
    );
  });
});

describe('aircraftToGeoJson', () => {
  it('maps each aircraft to a rotated point', () => {
    const collection = aircraftToGeoJson([plane], '3c6444');
    expect(collection.features).toHaveLength(1);
    const [feature] = collection.features;
    expect(feature.geometry.coordinates).toEqual([-1.2, 6.6]);
    expect(feature.properties).toMatchObject({
      id: '3c6444',
      icon: LIVE_ICON.aircraft,
      rotation: 10,
      selected: true,
      sortKey: 10668,
    });
  });

  it('marks planes on the ground and defaults a missing track to north', () => {
    const [feature] = aircraftToGeoJson([{ ...plane, onGround: true, trackDeg: null, altitudeM: null }]).features;
    expect(feature.properties).toMatchObject({ icon: LIVE_ICON.aircraftGround, rotation: 0, selected: false, sortKey: 0 });
  });

  it('drops positions that are not on Earth', () => {
    const collection = aircraftToGeoJson([plane, { ...plane, id: 'bad', latitude: Number.NaN }, { ...plane, id: 'far', longitude: 200 }]);
    expect(collection.features.map((feature) => feature.properties.id)).toEqual(['3c6444']);
  });
});

describe('vesselsToGeoJson', () => {
  it('uses the course when AIS has no heading (511)', () => {
    expect(vesselBearing(ship)).toBe(95);
    const [feature] = vesselsToGeoJson([ship]).features;
    expect(feature.properties).toMatchObject({ id: '636019825', icon: LIVE_ICON.vessel, rotation: 95 });
  });

  it('prefers the heading when present', () => {
    expect(vesselBearing({ headingDegrees: 90, courseDegrees: 95 })).toBe(90);
  });

  it('shows a moored ship as an idle mark', () => {
    const [feature] = vesselsToGeoJson([{ ...ship, speedKnots: 0.1 }]).features;
    expect(feature.properties.icon).toBe(LIVE_ICON.vesselIdle);
  });

  it('gives tracked vessels their own icon and puts them on top', () => {
    const [feature] = vesselsToGeoJson([{ ...ship, tracked: true }], ship.mmsi).features;
    expect(feature.properties).toMatchObject({ icon: LIVE_ICON.vesselTracked, sortKey: 1, selected: true });
  });
});

describe('dead reckoning', () => {
  it('moves north by speed × time', () => {
    // 60 kn for one hour = 60 nautical miles = 1 degree of latitude.
    const next = extrapolate(0, 0, 60, 0, 3600);
    expect(next.latitude).toBeCloseTo(1, 1);
    expect(next.longitude).toBeCloseTo(0, 6);
  });

  it('stays put without speed or track', () => {
    expect(extrapolate(5, 5, null, 90, 10)).toEqual({ latitude: 5, longitude: 5 });
    expect(extrapolate(5, 5, 400, null, 10)).toEqual({ latitude: 5, longitude: 5 });
  });

  it('wraps across the antimeridian', () => {
    // 600 kn for 10 min = 100 nm ≈ 1.67° east of 179.99°.
    const next = extrapolate(0, 179.99, 600, 90, 600);
    expect(next.longitude).toBeCloseTo(-178.34, 1);
  });

  it('caps the glide and leaves parked aircraft alone', () => {
    const [moved, parked] = extrapolateAircraft([plane, { ...plane, id: 'gnd', onGround: true }], 3600);
    const capped = extrapolate(plane.latitude, plane.longitude, plane.speedKts, plane.trackDeg, 45);
    expect(moved.latitude).toBeCloseTo(capped.latitude, 9);
    expect(parked.latitude).toBe(plane.latitude);
  });
});

describe('card formatting', () => {
  it('formats altitude in feet and metres, nothing on the ground', () => {
    expect(formatAltitude(10668, false, 'en-GB')).toBe('35,000 ft · 10,668 m');
    expect(formatAltitude(10668, true, 'en-GB')).toBeNull();
    expect(formatAltitude(null, false, 'en-GB')).toBe('—');
  });

  it('formats speed, bearing and vertical rate', () => {
    expect(formatKnots(451.6, 'en-GB')).toBe('452 kn');
    expect(formatKnots(null, 'en-GB')).toBe('—');
    expect(formatBearing(370)).toBe('010°');
    expect(formatBearing(null)).toBe('—');
    expect(formatVerticalRate(-5.2, 'en-GB')).toBe('↓ 1,000 ft/min');
    expect(formatVerticalRate(0.1, 'en-GB')).toBeNull();
  });

  it('normalises bearings', () => {
    expect(normaliseBearing(-90)).toBe(270);
    expect(normaliseBearing(undefined)).toBeNull();
  });

  it('picks the best title', () => {
    expect(aircraftTitle(plane)).toBe('DLH4AB');
    expect(aircraftTitle({ ...plane, callsign: '  ' })).toBe('D-AIBL');
    expect(aircraftTitle({ ...plane, callsign: null, registration: null })).toBe('3C6444');
    expect(vesselTitle(ship)).toBe('MSC TEMA');
    expect(vesselTitle({ ...ship, name: null })).toBe('MMSI 636019825');
  });

  it('names the feed for the credit line', () => {
    expect(aircraftSourceLabel({ source: 'opensky', attribution: '' })).toBe('OpenSky Network');
    expect(aircraftSourceLabel({ source: 'adsb.lol', attribution: '' })).toBe('adsb.lol (ODbL)');
    expect(aircraftSourceLabel({ source: 'adsb.lol', attribution: 'Data: adsb.lol, ODbL 1.0' })).toBe('Data: adsb.lol, ODbL 1.0');
    expect(vesselSourceLabel('aisstream')).toBe('AISStream');
    expect(vesselSourceLabel('demo')).toBe('demo');
  });
});
