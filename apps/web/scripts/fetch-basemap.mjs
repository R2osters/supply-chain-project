// Builds the offline basemap that every map draws under the OpenStreetMap tiles
// (src/lib/map-style.ts). When the tiles cannot load, in a classroom with no internet for
// example, the maps still show land and water, borders, roads and place names.
//
//   npm run basemap --workspace @scip/web        (or: node apps/web/scripts/fetch-basemap.mjs)
//
// Data: Natural Earth (public domain), 1:50m for the world and 1:10m inside DETAIL_BBOX, the part
// of West Africa where the demo network is. Labels: Noto Sans glyphs as packaged by OpenMapTiles
// (SIL Open Font License 1.1, copied next to them). Sources are pinned and cached in
// .basemap-cache/, so a second run needs no network; public/basemap/ is rebuilt from the cache on
// every run. Neither folder is committed.
//
// Output, one GeoJSON file per source of the style (property names are the style's contract):
//   land.geojson     kind: 'land' (1:50m) | 'mask' (the detail box) | 'detail' (1:10m, clipped)
//   water.geojson    kind: 'lake' | 'river'; rivers carry minzoom
//   borders.geojson  country borders on land, no properties
//   roads.geojson    rank (Natural Earth scalerank, 3 = most important), minzoom
//   places.geojson   kind: 'city' | 'country', name, rank, minzoom; maxzoom on countries,
//                    capital: true on national capitals
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NATURAL_EARTH_VERSION = 'v5.1.2';
const NATURAL_EARTH_URL = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NATURAL_EARTH_VERSION}/geojson`;
// OpenMapTiles' prebuilt glyphs (gh-pages branch) and the font's licence (master), both pinned.
const GLYPHS_COMMIT = '025ff2b2f84cc0fdf11f7b1d74b3a784595fe7a4';
const GLYPHS_URL = `https://raw.githubusercontent.com/openmaptiles/fonts/${GLYPHS_COMMIT}/Klokantech%20Noto%20Sans%20Regular`;
const FONT_LICENCE_URL =
  'https://raw.githubusercontent.com/openmaptiles/fonts/d48c5fce2fc58b55c98d353558d807cac45e7262/noto-sans/LICENSE';

/** The style's `text-font` and the glyph folder's name: keep in step with src/lib/map-style.ts. */
export const FONT_STACK = 'Noto Sans Regular';

/**
 * [west, south, east, north] drawn from 1:10m data; the rest of the world uses 1:50m. It covers
 * Ghana and its neighbours with margin, and its edges run through open sea or inland, so the
 * continent crosses them only twice and the clipped coastline stays a single clean ring.
 */
export const DETAIL_BBOX = [-20, 2, 16, 25];

/** Rounding: ~110 m for the world, ~11 m for the detail box, far below a pixel at their zooms. */
const WORLD_DECIMALS = 3;
const DETAIL_DECIMALS = 4;

/**
 * Inside the detail box, small towns, roads and rivers show one zoom level earlier than
 * elsewhere, so the maps that open on Ghana (zoom 6-6.5) are not bare; nothing moves below zoom
 * 5, so the world and continent views keep Natural Earth's own balance.
 */
const DETAIL_ZOOM_BONUS = 1;
const DETAIL_BONUS_FLOOR = 5;
/**
 * Roads are the heaviest layer (the world's main roads alone would weigh 3 MB). The maps that
 * show roads open on the demo network, so: every road in the detail box, the main ones in the
 * rest of Africa (simplified to ~500 m), none elsewhere.
 */
const OUTER_ROADS = { continent: 'Africa', maxRank: 4, tolerance: 0.005 };
/** Outside the detail box only the places Natural Earth shows before zoom 6 are kept. */
const WORLD_PLACE_MAX_MINZOOM = 5.9;
/** Ranges every build ships, whatever the names need: Latin-1, Latin Extended-A, punctuation. */
const BASE_GLYPH_RANGES = [0, 256, 8192];

export const NATURAL_EARTH_FILES = [
  'ne_50m_land',
  'ne_10m_land',
  'ne_50m_lakes',
  'ne_10m_lakes',
  'ne_50m_rivers_lake_centerlines',
  'ne_10m_rivers_lake_centerlines',
  'ne_50m_admin_0_boundary_lines_land',
  'ne_10m_admin_0_boundary_lines_land',
  'ne_10m_roads',
  'ne_10m_populated_places_simple',
  'ne_50m_admin_0_countries',
];

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(WEB_DIR, '.basemap-cache');
const OUT_DIR = join(WEB_DIR, 'public', 'basemap');
/** Written last: its presence means a complete build (the desktop staging script checks it). */
export const MANIFEST_NAME = 'basemap.json';

/* ------------------------------------------------------------------ geometry helpers */

export function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Rounds a line and drops the points that rounding made identical to the one before. */
export function roundLine(points, decimals) {
  const out = [];
  for (const [x, y] of points) {
    const point = [roundTo(x, decimals), roundTo(y, decimals)];
    const last = out[out.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) out.push(point);
  }
  return out.length >= 2 ? out : null;
}

/** Rounds a closed ring; null when too few distinct points are left to enclose anything. */
export function roundRing(ring, decimals) {
  const out = roundLine(ring, decimals) ?? [];
  const first = out[0];
  const last = out[out.length - 1];
  if (first && (first[0] !== last[0] || first[1] !== last[1])) out.push([first[0], first[1]]);
  return out.length >= 4 ? out : null;
}

/** A polygon is [outer, ...holes]; a hole that collapses is dropped, a collapsed outer drops all. */
export function roundPolygon(polygon, decimals) {
  const [outer, ...holes] = polygon.map((ring) => roundRing(ring, decimals));
  if (!outer) return null;
  return [outer, ...holes.filter(Boolean)];
}

export function polygonsOf(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

export function linesOf(geometry) {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

/** [west, south, east, north] of any nesting of positions. */
export function bboxOf(coordinates) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (value) => {
    if (typeof value[0] === 'number') {
      if (value[0] < box[0]) box[0] = value[0];
      if (value[1] < box[1]) box[1] = value[1];
      if (value[0] > box[2]) box[2] = value[0];
      if (value[1] > box[3]) box[3] = value[1];
    } else {
      for (const child of value) visit(child);
    }
  };
  visit(coordinates);
  return box;
}

export function bboxesIntersect(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function bboxRing([west, south, east, north]) {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

/**
 * Sutherland–Hodgman clip of a closed ring to a box. A ring that leaves and re-enters the box
 * several times would come back joined by slivers along the edge; DETAIL_BBOX is chosen so the
 * rings clipped here cross it at most twice.
 */
export function clipRing(ring, [west, south, east, north]) {
  const atX = (a, b, x) => [x, a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1])];
  const atY = (a, b, y) => [a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), y];
  const edges = [
    [(p) => p[0] >= west, (a, b) => atX(a, b, west)],
    [(p) => p[0] <= east, (a, b) => atX(a, b, east)],
    [(p) => p[1] >= south, (a, b) => atY(a, b, south)],
    [(p) => p[1] <= north, (a, b) => atY(a, b, north)],
  ];
  let points = ring.slice(0, -1);
  for (const [inside, cut] of edges) {
    const input = points;
    points = [];
    for (let i = 0; i < input.length; i += 1) {
      const current = input[i];
      const previous = input[(i + input.length - 1) % input.length];
      if (inside(current)) {
        if (!inside(previous)) points.push(cut(previous, current));
        points.push(current);
      } else if (inside(previous)) {
        points.push(cut(previous, current));
      }
    }
    if (points.length === 0) return null;
  }
  return points.length >= 3 ? [...points, points[0]] : null;
}

export function clipPolygon(polygon, box) {
  const [outer, ...holes] = polygon.map((ring) => clipRing(ring, box));
  if (!outer) return null;
  return [outer, ...holes.filter(Boolean)];
}

/** Liang–Barsky: the [t0, t1] part of segment a→b inside the box, or null. */
function segmentInside(a, b, [west, south, east, north]) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, a[0] - west],
    [dx, east - a[0]],
    [-dy, a[1] - south],
    [dy, north - a[1]],
  ]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return [t0, t1];
}

/** The parts of a line inside (or outside) a box, as separate lines. */
export function clipLine(line, box, keep = 'inside') {
  const parts = [];
  let current = null;
  const at = (a, b, t) => (t === 0 ? a : t === 1 ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1];
    const b = line[i];
    const span = segmentInside(a, b, box);
    let pieces;
    if (keep === 'inside') pieces = span && span[1] > span[0] ? [span] : [];
    else pieces = span ? [[0, span[0]], [span[1], 1]].filter(([t0, t1]) => t1 > t0) : [[0, 1]];
    for (const [t0, t1] of pieces) {
      const start = at(a, b, t0);
      const end = at(a, b, t1);
      const tail = current?.[current.length - 1];
      if (tail && tail[0] === start[0] && tail[1] === start[1]) current.push(end);
      else parts.push((current = [start, end]));
    }
  }
  return parts;
}

/** Douglas–Peucker, iterative; `tolerance` is in degrees. */
export function simplifyLine(points, tolerance) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const limit = tolerance * tolerance;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let furthest = -1;
    let furthestDistance = limit;
    for (let i = first + 1; i < last; i += 1) {
      const distance = segmentDistanceSquared(points[i], points[first], points[last]);
      if (distance > furthestDistance) {
        furthest = i;
        furthestDistance = distance;
      }
    }
    if (furthest !== -1) {
      keep[furthest] = 1;
      stack.push([first, furthest], [furthest, last]);
    }
  }
  return points.filter((_, index) => keep[index] === 1);
}

function segmentDistanceSquared(p, a, b) {
  let [x, y] = a;
  const dx = b[0] - x;
  const dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) [x, y] = b;
    else if (t > 0) [x, y] = [x + dx * t, y + dy * t];
  }
  return (p[0] - x) ** 2 + (p[1] - y) ** 2;
}

/* --------------------------------------------------------------------- label helpers */

/** Trims and drops invisible format characters (a stray left-to-right mark in the data). */
export function cleanLabel(text) {
  return String(text ?? '')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The 256-code-point glyph ranges that the labels need, as "start-end" file names. */
export function glyphRanges(texts, base = BASE_GLYPH_RANGES) {
  const starts = new Set(base);
  for (const text of texts) {
    for (const character of text) starts.add(Math.floor(character.codePointAt(0) / 256) * 256);
  }
  return [...starts].sort((a, b) => a - b).map((start) => `${start}-${start + 255}`);
}

/* ---------------------------------------------------------------------- layer builders */

const feature = (properties, geometry) => ({ type: 'Feature', properties, geometry });
const collection = (features) => ({ type: 'FeatureCollection', features });
const polygonGeometry = (polygon) => ({ type: 'Polygon', coordinates: polygon });
const lineGeometry = (lines) =>
  lines.length === 1 ? { type: 'LineString', coordinates: lines[0] } : { type: 'MultiLineString', coordinates: lines };
/** Natural Earth's min_zoom, pulled `bonus` levels earlier but not below DETAIL_BONUS_FLOOR. */
const zoom = (value, bonus = 0) => {
  const natural = Math.max(0, Number(value ?? 0));
  return roundTo(Math.max(Math.min(natural, DETAIL_BONUS_FLOOR), natural - bonus), 1);
};

/**
 * Land: 1:50m everywhere, then a water-coloured mask over the detail box and 1:10m land clipped
 * to it on top. The style draws them in that order, so inside the box only the 1:10m coast
 * shows, without subtracting one polygon set from the other.
 */
export function buildLand(world, detail, box = DETAIL_BBOX) {
  const features = [];
  for (const source of world.features) {
    for (const polygon of polygonsOf(source.geometry)) {
      const rounded = roundPolygon(polygon, WORLD_DECIMALS);
      if (rounded) features.push(feature({ kind: 'land' }, polygonGeometry(rounded)));
    }
  }
  features.push(feature({ kind: 'mask' }, polygonGeometry([bboxRing(box)])));
  for (const source of detail.features) {
    for (const polygon of polygonsOf(source.geometry)) {
      if (!bboxesIntersect(bboxOf(polygon[0]), box)) continue;
      const clipped = clipPolygon(polygon, box);
      const rounded = clipped && roundPolygon(clipped, DETAIL_DECIMALS);
      if (rounded) features.push(feature({ kind: 'detail' }, polygonGeometry(rounded)));
    }
  }
  return collection(features);
}

/**
 * Lakes stay whole (one that touches the box comes from 1:10m, in full); rivers are cut at the
 * box's edge, 1:50m outside and 1:10m inside. Lake centerlines are left out: the lake is filled.
 */
export function buildWater({ lakes50, lakes10, rivers50, rivers10 }, box = DETAIL_BBOX) {
  const features = [];
  const addLakes = (source, inside, decimals) => {
    for (const lake of source.features) {
      if (bboxesIntersect(bboxOf(lake.geometry.coordinates), box) !== inside) continue;
      for (const polygon of polygonsOf(lake.geometry)) {
        const rounded = roundPolygon(polygon, decimals);
        if (rounded) features.push(feature({ kind: 'lake' }, polygonGeometry(rounded)));
      }
    }
  };
  const addRivers = (source, keep, decimals, bonus) => {
    for (const river of source.features) {
      if (river.properties.featurecla !== 'River') continue;
      const lines = linesOf(river.geometry)
        .flatMap((line) => clipLine(line, box, keep))
        .map((line) => roundLine(line, decimals))
        .filter(Boolean);
      if (lines.length > 0) {
        features.push(feature({ kind: 'river', minzoom: zoom(river.properties.min_zoom, bonus) }, lineGeometry(lines)));
      }
    }
  };
  addLakes(lakes50, false, WORLD_DECIMALS);
  addLakes(lakes10, true, DETAIL_DECIMALS);
  addRivers(rivers50, 'outside', WORLD_DECIMALS, 0);
  addRivers(rivers10, 'inside', DETAIL_DECIMALS, DETAIL_ZOOM_BONUS);
  return collection(features);
}

/** Lease and overlay limits (Guantánamo, Baikonur...) are not borders a reader expects. */
const NOT_A_BORDER = new Set(['Lease limit', 'Overlay limit']);

export function buildBorders(world, detail, box = DETAIL_BBOX) {
  const features = [];
  const add = (source, keep, decimals) => {
    for (const border of source.features) {
      if (NOT_A_BORDER.has(border.properties.FEATURECLA)) continue;
      const lines = linesOf(border.geometry)
        .flatMap((line) => clipLine(line, box, keep))
        .map((line) => roundLine(line, decimals))
        .filter(Boolean);
      if (lines.length > 0) features.push(feature({}, lineGeometry(lines)));
    }
  };
  add(world, 'outside', WORLD_DECIMALS);
  add(detail, 'inside', DETAIL_DECIMALS);
  return collection(features);
}

const NOT_A_ROAD = new Set(['Ferry Route', 'Ferry, seasonal', 'Track']);

/** Every road in the detail box; elsewhere see OUTER_ROADS. */
export function buildRoads(roads, box = DETAIL_BBOX) {
  const features = [];
  for (const road of roads.features) {
    const { type, scalerank, continent, min_zoom: minZoom } = road.properties;
    if (NOT_A_ROAD.has(type)) continue;
    const inside = bboxesIntersect(bboxOf(road.geometry.coordinates), box);
    if (!inside && (continent !== OUTER_ROADS.continent || scalerank > OUTER_ROADS.maxRank)) continue;
    const lines = linesOf(road.geometry)
      .map((line) => (inside ? line : simplifyLine(line, OUTER_ROADS.tolerance)))
      .map((line) => roundLine(line, inside ? DETAIL_DECIMALS : WORLD_DECIMALS))
      .filter(Boolean);
    if (lines.length === 0) continue;
    features.push(
      feature({ rank: scalerank, minzoom: zoom(minZoom, inside ? DETAIL_ZOOM_BONUS : 0) }, lineGeometry(lines)),
    );
  }
  return collection(features);
}

const NOT_A_TOWN = new Set(['Scientific station', 'Meteorological Station', 'Historic place']);

/** Towns (all of them in the detail box, the larger ones elsewhere) and country names. */
export function buildPlaces(places, countries, box = DETAIL_BBOX) {
  const features = [];
  for (const place of places.features) {
    const { featurecla, name, scalerank, min_zoom: minZoom } = place.properties;
    const label = cleanLabel(name);
    if (!label || NOT_A_TOWN.has(featurecla)) continue;
    const [x, y] = place.geometry.coordinates;
    const inside = bboxesIntersect([x, y, x, y], box);
    if (!inside && minZoom > WORLD_PLACE_MAX_MINZOOM) continue;
    const properties = { kind: 'city', name: label, rank: scalerank, minzoom: zoom(minZoom, inside ? DETAIL_ZOOM_BONUS : 0) };
    if (featurecla === 'Admin-0 capital') properties.capital = true;
    features.push(feature(properties, { type: 'Point', coordinates: [roundTo(x, WORLD_DECIMALS), roundTo(y, WORLD_DECIMALS)] }));
  }
  for (const country of countries.features) {
    const { NAME, LABELRANK, MIN_LABEL, MAX_LABEL, LABEL_X, LABEL_Y } = country.properties;
    const label = cleanLabel(NAME);
    if (!label || typeof LABEL_X !== 'number' || typeof LABEL_Y !== 'number') continue;
    features.push(
      feature(
        { kind: 'country', name: label, rank: LABELRANK, minzoom: zoom(MIN_LABEL), maxzoom: zoom(MAX_LABEL) },
        { type: 'Point', coordinates: [roundTo(LABEL_X, WORLD_DECIMALS), roundTo(LABEL_Y, WORLD_DECIMALS)] },
      ),
    );
  }
  return collection(features);
}

/* ---------------------------------------------------------------------------- build */

/** Downloads `url` into the cache once; later runs reuse the cached copy, offline. */
async function download(url, cachePath) {
  const target = join(CACHE_DIR, cachePath);
  if (existsSync(target)) return target;
  mkdirSync(dirname(target), { recursive: true });
  console.log(`  downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`);
  // A temp name first, so an interrupted download is never mistaken for a cached one.
  const partial = `${target}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  renameSync(partial, target);
  return target;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value));
  return statSync(path).size;
}

const NOTICE = `SCIP offline basemap, drawn when the OpenStreetMap tiles cannot load.

Map data: Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com
(public domain), release ${NATURAL_EARTH_VERSION}.

Glyphs (fonts/${FONT_STACK}/): Noto Sans, as packaged by OpenMapTiles
(github.com/openmaptiles/fonts), under the SIL Open Font License 1.1, in fonts/${FONT_STACK}/OFL.txt.

Generated by apps/web/scripts/fetch-basemap.mjs; do not edit by hand.
`;

/** Every output file (name without .geojson) from the Natural Earth collections, by file name. */
export function buildLayers(ne, box = DETAIL_BBOX) {
  return {
    land: buildLand(ne.ne_50m_land, ne.ne_10m_land, box),
    water: buildWater(
      {
        lakes50: ne.ne_50m_lakes,
        lakes10: ne.ne_10m_lakes,
        rivers50: ne.ne_50m_rivers_lake_centerlines,
        rivers10: ne.ne_10m_rivers_lake_centerlines,
      },
      box,
    ),
    borders: buildBorders(ne.ne_50m_admin_0_boundary_lines_land, ne.ne_10m_admin_0_boundary_lines_land, box),
    roads: buildRoads(ne.ne_10m_roads, box),
    places: buildPlaces(ne.ne_10m_populated_places_simple, ne.ne_50m_admin_0_countries, box),
  };
}

export async function buildBasemap() {
  const started = Date.now();
  const ne = {};
  for (const name of NATURAL_EARTH_FILES) {
    const path = await download(`${NATURAL_EARTH_URL}/${name}.geojson`, join(`natural-earth-${NATURAL_EARTH_VERSION}`, `${name}.geojson`));
    ne[name] = readJson(path);
  }
  const layers = buildLayers(ne);

  rmSync(OUT_DIR, { recursive: true, force: true });
  const fontDir = join(OUT_DIR, 'fonts', FONT_STACK);
  mkdirSync(fontDir, { recursive: true });

  const files = {};
  for (const [name, data] of Object.entries(layers)) {
    files[`${name}.geojson`] = writeJson(join(OUT_DIR, `${name}.geojson`), data);
  }

  const ranges = glyphRanges(layers.places.features.map((place) => place.properties.name));
  for (const range of ranges) {
    const cached = await download(`${GLYPHS_URL}/${range}.pbf`, join(`glyphs-${GLYPHS_COMMIT.slice(0, 7)}`, `${range}.pbf`));
    copyFileSync(cached, join(fontDir, `${range}.pbf`));
    files[`fonts/${FONT_STACK}/${range}.pbf`] = statSync(cached).size;
  }
  copyFileSync(await download(FONT_LICENCE_URL, join(`glyphs-${GLYPHS_COMMIT.slice(0, 7)}`, 'OFL.txt')), join(fontDir, 'OFL.txt'));
  writeFileSync(join(OUT_DIR, 'NOTICE.txt'), NOTICE);

  const total = Object.values(files).reduce((sum, size) => sum + size, 0);
  writeJson(join(OUT_DIR, MANIFEST_NAME), {
    naturalEarth: NATURAL_EARTH_VERSION,
    glyphs: `openmaptiles/fonts@${GLYPHS_COMMIT}`,
    fontStack: FONT_STACK,
    detailBbox: DETAIL_BBOX,
    bytes: total,
    files,
  });

  for (const [name, size] of Object.entries(files)) console.log(`  ${name.padEnd(40)} ${(size / 1024).toFixed(0).padStart(6)} KB`);
  console.log(`  basemap -> ${OUT_DIR}: ${(total / 1024 / 1024).toFixed(2)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await buildBasemap();
  } catch (error) {
    console.error(`basemap: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
