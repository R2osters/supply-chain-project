import { fromDigitrafficLocation, indexDigitrafficVessels } from './digitraffic-feed';

// Shapes copied from live responses of https://meri.digitraffic.fi/api/ais/v1/{locations,vessels}.
const LOCATION = {
  mmsi: 230356000,
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [21.571232, 63.081152] },
  properties: { mmsi: 230356000, sog: 11.4, cog: 310, navStat: 0, rot: 0, heading: 27, timestampExternal: 1790680000000 },
};

describe('Digitraffic AIS', () => {
  it('turns a location feature into a fix, joined with the vessel metadata', () => {
    const metadata = indexDigitrafficVessels([
      { mmsi: 230356000, name: 'FINNMAID@@', destination: 'FIHEL', imo: 9468889, draught: 72 },
    ]);
    expect(fromDigitrafficLocation(LOCATION, metadata)).toMatchObject({
      mmsi: '230356000',
      name: 'FINNMAID',
      destination: 'FIHEL',
      imoNumber: '9468889',
      draughtM: 7.2,
      latitude: 63.081152,
      longitude: 21.571232,
      speedKnots: 11.4,
      courseDegrees: 310,
      headingDegrees: 27,
      navStatus: 'UNDERWAY',
      source: 'DIGITRAFFIC',
    });
  });

  it('reads the AIS "not available" sentinels as nulls', () => {
    const fix = fromDigitrafficLocation(
      { ...LOCATION, properties: { sog: 102.3, cog: 360, heading: 511, navStat: 15 } },
      new Map(),
    )!;
    expect(fix.speedKnots).toBeNull();
    expect(fix.courseDegrees).toBeNull();
    expect(fix.headingDegrees).toBeNull();
    expect(fix.name).toBeNull();
  });

  it('rejects features without a usable position or MMSI', () => {
    expect(fromDigitrafficLocation({ mmsi: 1, geometry: { coordinates: [200, 10] } }, new Map())).toBeNull();
    expect(fromDigitrafficLocation({ geometry: { coordinates: [20, 60] } }, new Map())).toBeNull();
    expect(fromDigitrafficLocation({ mmsi: 1 }, new Map())).toBeNull();
  });

  it('ignores placeholder IMO and draught values', () => {
    const index = indexDigitrafficVessels([{ mmsi: 265001870, name: 'P10', imo: 0, draught: 0, destination: '' }]);
    expect(index.get('265001870')).toEqual({ name: 'P10', destination: null, imoNumber: null, draughtM: null });
  });
});
