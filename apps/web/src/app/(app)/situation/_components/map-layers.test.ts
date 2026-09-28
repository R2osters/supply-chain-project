import { describe, expect, it } from 'vitest';
import type { Hazard } from '@/lib/intel';
import { conesToGeoJson, hazardsToGeoJson, satellitesToGeoJson, tracksToGeoJson } from './map-layers';

const cyclone: Hazard = {
  id: 'nhc:al05',
  kind: 'CYCLONE',
  title: 'Hurricane Test',
  severity: 'HIGH',
  severityScore: 0.8,
  latitude: 20,
  longitude: -60,
  radiusKm: 300,
  observedAt: '2026-09-28T10:00:00Z',
  source: 'NOAA NHC',
  url: null,
  details: {},
  track: [
    { latitude: 20, longitude: -60, at: null },
    { latitude: 22, longitude: -63, at: null },
  ],
  cone: [
    [
      [-60, 20],
      [-64, 23],
      [-62, 24],
      [-60, 20],
    ],
  ],
};

const quake: Hazard = { ...cyclone, id: 'usgs:1', kind: 'EARTHQUAKE', track: null, cone: null };

describe('hazard layers', () => {
  it('puts every hazard on the map as a coloured point in lon, lat order', () => {
    const collection = hazardsToGeoJson([cyclone, quake]);
    expect(collection.features).toHaveLength(2);
    expect(collection.features[0].geometry).toEqual({ type: 'Point', coordinates: [-60, 20] });
    expect(collection.features[1].properties.colour).toBe('#ffa53d');
  });

  it('draws cones and tracks only for hazards that have them', () => {
    expect(conesToGeoJson([cyclone, quake]).features).toHaveLength(1);
    expect(tracksToGeoJson([cyclone, quake]).features).toHaveLength(1);
  });
});

describe('satellite layer', () => {
  it('marks the selected satellite so it can be styled apart', () => {
    const collection = satellitesToGeoJson(
      [
        { noradId: 1, name: 'A', latitude: 0, longitude: 0, altitudeKm: 20_000 },
        { noradId: 2, name: 'B', latitude: 1, longitude: 1, altitudeKm: 20_000 },
      ],
      2,
    );
    expect(collection.features.map((feature) => feature.properties.selected)).toEqual([false, true]);
  });
});
