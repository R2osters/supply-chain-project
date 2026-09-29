import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { BASEMAP_FONT, BASEMAP_OFFLINE, basemapStyle } from '../src/lib/map-style';
import { PALETTES } from '../src/lib/theme';
import {
  FONT_STACK,
  NATURAL_EARTH_FILES,
  bboxOf,
  buildBorders,
  buildLand,
  buildLayers,
  buildPlaces,
  buildRoads,
  buildWater,
  cleanLabel,
  clipLine,
  clipRing,
  glyphRanges,
  roundLine,
  roundPolygon,
  roundRing,
  roundTo,
  simplifyLine,
} from './fetch-basemap.mjs';

const BOX = [0, 0, 10, 10];
const square = (x0, y0, x1, y1) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];
const polygon = (ring) => ({ type: 'Polygon', coordinates: [ring] });
const line = (points) => ({ type: 'LineString', coordinates: points });
const point = (x, y) => ({ type: 'Point', coordinates: [x, y] });
const feature = (properties, geometry) => ({ type: 'Feature', properties, geometry });
const collection = (...features) => ({ type: 'FeatureCollection', features });
const area = (ring) => Math.abs(ring.slice(1).reduce((sum, [x, y], i) => sum + ring[i][0] * y - x * ring[i][1], 0)) / 2;

describe('rounding', () => {
  it('rounds and drops the points that rounding merged', () => {
    expect(roundTo(1.23456, 3)).toBe(1.235);
    expect(roundLine([[0.0001, 0], [0.0002, 0], [1.00049, 1]], 3)).toEqual([[0, 0], [1, 1]]);
    expect(roundLine([[0.0001, 0], [0.0002, 0]], 3)).toBeNull();
  });

  it('keeps rings closed and drops those that collapse', () => {
    expect(roundRing(square(0, 0, 1, 1), 3)).toEqual(square(0, 0, 1, 1));
    expect(roundRing(square(0, 0, 0.0001, 0.0001), 3)).toBeNull();
    // A collapsed hole goes; the outer ring stays.
    expect(roundPolygon([square(0, 0, 1, 1), square(0.5, 0.5, 0.5001, 0.5001)], 3)).toEqual([square(0, 0, 1, 1)]);
    expect(roundPolygon([square(0, 0, 0.0001, 0.0001), square(0, 0, 1, 1)], 3)).toBeNull();
  });
});

describe('clipRing', () => {
  it('cuts a ring at the box and keeps it closed', () => {
    const clipped = clipRing(square(-5, -5, 5, 5), BOX);
    expect(bboxOf(clipped)).toEqual([0, 0, 5, 5]);
    expect(area(clipped)).toBe(25);
    expect(clipped[0]).toEqual(clipped[clipped.length - 1]);
  });

  it('keeps a ring inside as it is and drops one outside', () => {
    expect(clipRing(square(1, 1, 2, 2), BOX)).toEqual(square(1, 1, 2, 2));
    expect(clipRing(square(20, 20, 30, 30), BOX)).toBeNull();
  });
});

describe('clipLine', () => {
  const across = [
    [-5, 5],
    [5, 5],
    [15, 5],
  ];

  it('keeps the part inside as one line', () => {
    expect(clipLine(across, BOX, 'inside')).toEqual([
      [
        [0, 5],
        [5, 5],
        [10, 5],
      ],
    ]);
  });

  it('keeps the parts outside as separate lines', () => {
    expect(clipLine(across, BOX, 'outside')).toEqual([
      [
        [-5, 5],
        [0, 5],
      ],
      [
        [10, 5],
        [15, 5],
      ],
    ]);
  });

  it('handles lines that never enter', () => {
    const away = [
      [20, 0],
      [30, 0],
    ];
    expect(clipLine(away, BOX, 'outside')).toEqual([away]);
    expect(clipLine(away, BOX, 'inside')).toEqual([]);
  });
});

describe('simplifyLine', () => {
  it('drops points closer to the line than the tolerance and keeps the corners', () => {
    expect(simplifyLine([[0, 0], [1, 0.001], [2, 0], [3, 1]], 0.01)).toEqual([[0, 0], [2, 0], [3, 1]]);
    expect(simplifyLine([[0, 0], [1, 1]], 10)).toEqual([[0, 0], [1, 1]]);
  });
});

describe('labels', () => {
  it('strips invisible marks and extra spaces', () => {
    expect(cleanLabel('‎Abidjan  ')).toBe('Abidjan');
    expect(cleanLabel('Cape   Coast')).toBe('Cape Coast');
    expect(cleanLabel(undefined)).toBe('');
  });

  it('asks for the base glyph ranges plus those the names need, in order', () => {
    expect(glyphRanges(['Accra', 'Kumasi'])).toEqual(['0-255', '256-511', '8192-8447']);
    expect(glyphRanges(['Łódź', 'Hồ Chí Minh', 'Constanța'])).toEqual([
      '0-255',
      '256-511',
      '512-767',
      '7680-7935',
      '8192-8447',
    ]);
  });
});

describe('layer builders', () => {
  it('land: 1:50m everywhere, then the mask, then 1:10m clipped to the box', () => {
    const land = buildLand(
      collection(feature({}, polygon(square(-30, -30, 30, 30)))),
      collection(
        feature({}, { type: 'MultiPolygon', coordinates: [[square(-5, -5, 5, 5)], [square(50, 50, 51, 51)]] }),
      ),
      BOX,
    );
    expect(land.features.map((f) => f.properties.kind)).toEqual(['land', 'mask', 'detail']);
    expect(land.features[1].geometry.coordinates[0]).toEqual(square(0, 0, 10, 10));
    expect(bboxOf(land.features[2].geometry.coordinates)).toEqual([0, 0, 5, 5]);
  });

  it('water: lakes whole from the scale of their side, rivers cut at the box', () => {
    const water = buildWater(
      {
        lakes50: collection(feature({}, polygon(square(1, 1, 2, 2))), feature({}, polygon(square(20, 20, 21, 21)))),
        lakes10: collection(feature({}, polygon(square(1, 1, 2, 2.5))), feature({}, polygon(square(30, 30, 31, 31)))),
        rivers50: collection(
          feature({ featurecla: 'River', min_zoom: 3 }, line([[-5, 5], [15, 5]])),
          feature({ featurecla: 'Lake Centerline', min_zoom: 3 }, line([[20, 20], [21, 21]])),
        ),
        rivers10: collection(feature({ featurecla: 'River', min_zoom: 6 }, line([[-5, 5], [15, 5]]))),
      },
      BOX,
    );
    const lakes = water.features.filter((f) => f.properties.kind === 'lake').map((f) => bboxOf(f.geometry.coordinates));
    expect(lakes).toEqual([
      [20, 20, 21, 21],
      [1, 1, 2, 2.5],
    ]);
    const rivers = water.features.filter((f) => f.properties.kind === 'river');
    expect(rivers.map((f) => [f.geometry.type, f.properties.minzoom])).toEqual([
      ['MultiLineString', 3],
      ['LineString', 5], // one zoom level earlier inside the box
    ]);
    expect(rivers[1].geometry.coordinates).toEqual([
      [0, 5],
      [10, 5],
    ]);
  });

  it('borders: 1:50m outside the box, 1:10m inside, no lease limits', () => {
    const borders = buildBorders(
      collection(feature({ FEATURECLA: 'International boundary (verify)' }, line([[-5, 5], [15, 5]]))),
      collection(
        feature({ FEATURECLA: 'International boundary (verify)' }, line([[-5, 6], [15, 6]])),
        feature({ FEATURECLA: 'Lease limit' }, line([[1, 1], [2, 2]])),
      ),
      BOX,
    );
    expect(borders.features.map((f) => bboxOf(f.geometry.coordinates))).toEqual([
      [-5, 5, 15, 5],
      [0, 6, 10, 6],
    ]);
  });

  it('roads: all of them in the box, main African ones outside, no ferries', () => {
    const inside = line([[1, 1], [2, 2]]);
    const outside = line([[20, 20], [21, 21], [22, 20]]);
    const roads = buildRoads(
      collection(
        feature({ type: 'Road', scalerank: 9, continent: 'Africa', min_zoom: 7.6 }, inside),
        feature({ type: 'Major Highway', scalerank: 3, continent: 'Africa', min_zoom: 3 }, outside),
        feature({ type: 'Road', scalerank: 6, continent: 'Africa', min_zoom: 6 }, outside),
        feature({ type: 'Major Highway', scalerank: 3, continent: 'Europe', min_zoom: 3 }, outside),
        feature({ type: 'Ferry Route', scalerank: 3, continent: 'Africa', min_zoom: 3 }, inside),
      ),
      BOX,
    );
    expect(roads.features.map((f) => f.properties)).toEqual([
      { rank: 9, minzoom: 6.6 },
      { rank: 3, minzoom: 3 },
    ]);
  });

  it('places: towns in the box, larger places elsewhere, capitals flagged, country names', () => {
    const places = buildPlaces(
      collection(
        feature({ featurecla: 'Admin-0 capital', name: 'Accra', scalerank: 2, min_zoom: 4 }, point(5, 5)),
        feature({ featurecla: 'Populated place', name: 'Tema', scalerank: 7, min_zoom: 6.7 }, point(5.1, 5)),
        feature({ featurecla: 'Populated place', name: 'Kumasi', scalerank: 6, min_zoom: 5.5 }, point(4, 6)),
        feature({ featurecla: 'Populated place', name: 'Far town', scalerank: 7, min_zoom: 6.7 }, point(50, 50)),
        feature({ featurecla: 'Admin-1 capital', name: 'Big city', scalerank: 3, min_zoom: 5 }, point(50, 51)),
        feature({ featurecla: 'Scientific station', name: 'Base', scalerank: 7, min_zoom: 3 }, point(5, 6)),
      ),
      collection(
        feature(
          { NAME: 'Ghana', LABELRANK: 3, MIN_LABEL: 2.7, MAX_LABEL: 8, LABEL_X: -1.036941, LABEL_Y: 7.717639 },
          null,
        ),
      ),
      BOX,
    );
    expect(places.features.map((f) => f.properties)).toEqual([
      // Earlier inside the box, but never below zoom 5: the world view keeps its balance.
      { kind: 'city', name: 'Accra', rank: 2, minzoom: 4, capital: true },
      { kind: 'city', name: 'Tema', rank: 7, minzoom: 5.7 },
      { kind: 'city', name: 'Kumasi', rank: 6, minzoom: 5 },
      { kind: 'city', name: 'Big city', rank: 3, minzoom: 5 },
      { kind: 'country', name: 'Ghana', rank: 3, minzoom: 2.7, maxzoom: 8 },
    ]);
    expect(places.features[4].geometry.coordinates).toEqual([-1.037, 7.718]);
  });
});

describe('contract with src/lib/map-style.ts', () => {
  const style = basemapStyle(PALETTES.light);
  const layerById = (id) => style.layers.find((layer) => layer.id === id);

  // A tiny Natural Earth: one of everything, inside the box.
  const ne = Object.fromEntries(NATURAL_EARTH_FILES.map((name) => [name, collection()]));
  ne.ne_50m_land = collection(feature({}, polygon(square(-30, -30, 30, 30))));
  ne.ne_10m_land = collection(feature({}, polygon(square(-5, -5, 5, 5))));
  ne.ne_10m_lakes = collection(feature({}, polygon(square(1, 1, 2, 2))));
  ne.ne_10m_rivers_lake_centerlines = collection(feature({ featurecla: 'River', min_zoom: 5 }, line([[1, 1], [3, 3]])));
  ne.ne_10m_admin_0_boundary_lines_land = collection(feature({ FEATURECLA: 'International boundary (verify)' }, line([[4, 0], [4, 9]])));
  ne.ne_10m_roads = collection(feature({ type: 'Road', scalerank: 5, continent: 'Africa', min_zoom: 6 }, line([[1, 2], [3, 2]])));
  ne.ne_10m_populated_places_simple = collection(
    feature({ featurecla: 'Admin-0 capital', name: 'Accra', scalerank: 2, min_zoom: 4 }, point(5, 5)),
  );
  ne.ne_50m_admin_0_countries = collection(
    feature({ NAME: 'Ghana', LABELRANK: 3, MIN_LABEL: 2.7, MAX_LABEL: 8, LABEL_X: 5, LABEL_Y: 6 }, null),
  );
  const layers = buildLayers(ne, BOX);

  it('names the glyph folder as the style names the font', () => {
    expect(FONT_STACK).toBe(BASEMAP_FONT);
  });

  it('writes one file per GeoJSON source of the style', () => {
    const files = Object.values(style.sources)
      .filter((source) => source.type === 'geojson')
      .map((source) => source.data.split('/').pop());
    expect(files.sort()).toEqual(Object.keys(layers).map((name) => `${name}.geojson`).sort());
  });

  it('gives every offline layer features that its filter accepts', () => {
    const fileOf = (layer) => style.sources[layer.source].data.split('/').pop().replace('.geojson', '');
    for (const id of Object.values(BASEMAP_OFFLINE)) {
      const layer = layerById(id);
      const accepts = featureFilter(layer.filter);
      // Zoom 6: towns, roads and rivers are visible there inside the box, and so is the country.
      const matching = layers[fileOf(layer)].features.filter((f) =>
        accepts.filter({ zoom: 6 }, { type: 1, properties: f.properties }),
      );
      expect(matching.length, id).toBeGreaterThan(0);
    }
  });
});
