// scripts/geo.mjs — Natural Earth v5.1.2 → generated/geo.json (projected SVG paths for the map scenes).
//
// Same pinned version the SCIP product embeds (public domain). Downloads are cached in .geo-cache/,
// so a second run needs no network. The output is deterministic: no clock, no randomness.
// The v5.1.2 polygons are already wound the way d3-geo reads them (geo.test.ts checks the fill).
//
//   world   Equal Earth, sphere fitted to 1920×1080 with 96 px margins (S10, S16)
//   baltic  Mercator on [9°E, 53°N]–[31°E, 66°N], clipped to the frame (S10)
//   ghana   Mercator on [-3.5°E, 4.5°N]–[1.5°E, 8.5°N], clipped to the frame (S09)
import {existsSync} from 'node:fs';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {geoEqualEarth, geoMercator, geoPath} from 'd3-geo';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CACHE_DIR = join(ROOT, '.geo-cache');
const OUT_FILE = join(ROOT, 'generated', 'geo.json');
const BASE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson';

const W = 1920;
const H = 1080;
const WORLD_MARGIN = 96;
const CITY_RADIUS = 3;
// v5.1.2 has 68 places with scalerank <= 1 and 186 with <= 2; the plan wants about 60 (30 to 120 accepted), so 1.
const CITY_MAX_SCALERANK = 1;
const CORRIDOR_AMPLITUDE = 6; // px, along the normal
const CORRIDOR_MIDPOINTS = 5;

// Ferry lanes drawn in S10, from the port towns' coordinates ([lon, lat]).
const LANES = [
  {from: [24.9384, 60.1699], to: [24.7536, 59.437]}, // Helsinki → Tallinn
  {from: [18.0686, 59.3293], to: [22.2666, 60.4518]}, // Stockholm → Turku
  {from: [18.6466, 54.352], to: [15.5869, 56.1612]}, // Gdańsk → Karlskrona
];
const ACCRA = [-0.187, 5.6037];
const KUMASI = [-1.6244, 6.6885];

async function loadGeoJson(name) {
  const file = join(CACHE_DIR, `${name}.geojson`);
  if (!existsSync(file)) {
    const res = await fetch(`${BASE_URL}/${name}.geojson`);
    if (!res.ok) throw new Error(`GET ${name}.geojson: HTTP ${res.status}`);
    const text = await res.text();
    JSON.parse(text); // refuse a truncated or non-JSON body before it reaches the cache
    await mkdir(CACHE_DIR, {recursive: true});
    await writeFile(`${file}.part`, text);
    await rename(`${file}.part`, file);
    console.log(`downloaded ${name}.geojson (${Math.round(text.length / 1024)} KiB)`);
  }
  return JSON.parse(await readFile(file, 'utf8'));
}

// Path numbers at 0.1 px; "-0.0" is folded into "0.0".
const roundPath = (d) => d.replace(/-?\d+\.\d+/g, (n) => {
  const s = (+n).toFixed(1);
  return s === '-0.0' ? '0.0' : s;
});
const roundNumber = (n) => +n.toFixed(1) + 0;
const roundPoint = ([x, y]) => [roundNumber(x), roundNumber(y)];
const pathOf = (projection, object) => roundPath(geoPath(projection)(object) ?? '');

// A MultiPoint of the box corners: unlike a Polygon, its bounds are not bulged by great-circle edges.
const cornersOf = ([west, south], [east, north]) => ({
  type: 'MultiPoint',
  coordinates: [[west, south], [east, south], [east, north], [west, north]],
});

function croppedMercator(southWest, northEast) {
  return geoMercator()
    .fitExtent([[0, 0], [W, H]], cornersOf(southWest, northEast))
    .clipExtent([[0, 0], [W, H]]);
}

// A straight Accra → Kumasi polyline whose intermediate points swing along the normal on one sine period.
function corridorBetween(from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  const nx = -dy / length;
  const ny = dx / length;
  const points = [from];
  for (let i = 1; i <= CORRIDOR_MIDPOINTS; i++) {
    const t = i / (CORRIDOR_MIDPOINTS + 1);
    const offset = CORRIDOR_AMPLITUDE * Math.sin(2 * Math.PI * t);
    points.push([from[0] + dx * t + nx * offset, from[1] + dy * t + ny * offset]);
  }
  points.push(to);
  return points.map(roundPoint);
}

async function main() {
  const [land110, land50, borders, lakes, rivers, places] = await Promise.all(
    ['ne_110m_land', 'ne_50m_land', 'ne_50m_admin_0_boundary_lines_land', 'ne_50m_lakes', 'ne_50m_rivers_lake_centerlines', 'ne_10m_populated_places_simple'].map(loadGeoJson),
  );

  const worldProjection = geoEqualEarth().fitExtent([[WORLD_MARGIN, WORLD_MARGIN], [W - WORLD_MARGIN, H - WORLD_MARGIN]], {type: 'Sphere'});
  const cities = places.features
    .filter((f) => f.properties.scalerank <= CITY_MAX_SCALERANK)
    .map((f) => worldProjection(f.geometry.coordinates))
    .filter((point) => point !== null)
    .map(([x, y]) => ({x: roundNumber(x), y: roundNumber(y), r: CITY_RADIUS}));

  const balticProjection = croppedMercator([9, 53], [31, 66]);
  const ghanaProjection = croppedMercator([-3.5, 4.5], [1.5, 8.5]);
  const accra = roundPoint(ghanaProjection(ACCRA));
  const kumasi = roundPoint(ghanaProjection(KUMASI));

  const geo = {
    world: {
      land: pathOf(worldProjection, land110),
      borders: pathOf(worldProjection, borders),
      rivers: pathOf(worldProjection, rivers),
      lakes: pathOf(worldProjection, lakes),
      cities,
    },
    baltic: {
      land: pathOf(balticProjection, land50),
      lanes: LANES.map(({from, to}) => ({from: roundPoint(balticProjection(from)), to: roundPoint(balticProjection(to))})),
    },
    ghana: {
      land: pathOf(ghanaProjection, land50),
      corridor: corridorBetween(accra, kumasi),
      accra,
      kumasi,
    },
  };

  await mkdir(join(ROOT, 'generated'), {recursive: true});
  const json = JSON.stringify(geo);
  await writeFile(OUT_FILE, `${json}\n`);
  console.log(`wrote generated/geo.json: ${(json.length / 1024).toFixed(0)} KiB, ${cities.length} cities`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
