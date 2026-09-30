import {
  buildStormGeometry,
  cycloneSeverityScore,
  normaliseAdvisory,
  parseCurrentStorms,
  parseGisLayer,
  stormToHazard,
} from './nhc-cyclones';

// Trimmed from the real CurrentStorms.json shape.
const STATUS = {
  activeStorms: [
    {
      id: 'al052026',
      binNumber: 'AT5',
      name: 'Ernesto',
      classification: 'HU',
      intensity: '105',
      pressure: '962',
      latitudeNumeric: 24.1,
      longitudeNumeric: -71.3,
      movementDir: 330,
      movementSpeed: 12,
      lastUpdate: '2026-09-28T09:00:00.000Z',
      forecastAdvisory: {
        advNum: '012',
        issuance: '2026-09-28T09:00:00.000Z',
        url: 'https://www.nhc.noaa.gov/text/MIATCMAT5.shtml',
      },
    },
    { id: 'not-a-storm', name: 'Bogus', latitudeNumeric: 1, longitudeNumeric: 1 },
    { id: 'ep102026', name: 'Kay', classification: 'TS', intensity: '45', latitudeNumeric: 400, longitudeNumeric: 0 },
  ],
};

const POINTS = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-72, 26] },
      properties: { idp_source: 'al052026-012_5day_pts', advisnum: '12', tau: 24 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-71.3, 24.1] },
      properties: { idp_source: 'al052026-012_5day_pts', advisnum: '12', tau: 0 },
    },
    // A point from the previous advisory must never be drawn under the current storm.
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-60, 20] },
      properties: { idp_source: 'al052026-011_5day_pts', advisnum: '11', tau: 0 },
    },
  ],
};

const CONE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-71, 24],
            [-73, 27],
            [-70, 27],
            [-71, 24],
          ],
        ],
      },
      properties: { idp_source: 'al052026-012_5day_pgn', advisnum: '12' },
    },
  ],
};

describe('NHC cyclones', () => {
  it('keeps valid storms and drops malformed ones without failing the feed', () => {
    const storms = parseCurrentStorms(STATUS);
    expect(storms).toHaveLength(1);
    expect(storms[0]).toMatchObject({ id: 'al052026', name: 'Ernesto', windKt: 105, advisoryNumber: '12' });
  });

  it('rejects a payload that is not a storm list', () => {
    expect(() => parseCurrentStorms({ nope: true })).toThrow('activeStorms');
  });

  it('attaches forecast track and cone only from the matching advisory', () => {
    const [storm] = parseCurrentStorms(STATUS);
    const geometry = buildStormGeometry(storm, parseGisLayer(POINTS, 'points'), [], parseGisLayer(CONE, 'cone'));

    expect(geometry.track).toEqual([
      { latitude: 24.1, longitude: -71.3, at: '2026-09-28T09:00:00.000Z' },
      { latitude: 26, longitude: -72, at: '2026-09-29T09:00:00.000Z' },
    ]);
    expect(geometry.cone).toHaveLength(1);
    expect(geometry.cone?.[0][0]).toEqual([-71, 24]);
  });

  it('maps a Category 3 hurricane to CRITICAL with a hurricane-sized footprint', () => {
    const [storm] = parseCurrentStorms(STATUS);
    const hazard = stormToHazard(storm, { track: null, cone: null });
    expect(hazard).toMatchObject({
      id: 'nhc:al052026',
      kind: 'CYCLONE',
      title: 'Ouragan Ernesto',
      severity: 'CRITICAL',
      radiusKm: 300,
      url: 'https://www.nhc.noaa.gov/text/MIATCMAT5.shtml',
    });
    expect(hazard.details.geometry).toBe('unavailable');
    // The French title is for people; the news search runs on NHC's English wording.
    expect(hazard.details.place).toBe('Hurricane Ernesto');
  });

  it('orders intensity bands monotonically', () => {
    const scores = [20, 40, 70, 100, 150].map(cycloneSeverityScore);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
  });

  it('normalises advisory numbers', () => {
    expect(normaliseAdvisory('007')).toBe('7');
    expect(normaliseAdvisory('12a')).toBe('12A');
    expect(normaliseAdvisory('x')).toBeNull();
  });
});
