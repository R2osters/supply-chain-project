'use client';

import type {
  FilterSpecification,
  GeoJSONSourceSpecification,
  LayerSpecification,
  Map as MapLibreMap,
  StyleSpecification,
} from 'maplibre-gl';
import { useEffect } from 'react';
import type { Palette } from './theme';

/**
 * One basemap for every map in SCIP (charte §03): OSM raster, fully desaturated, quiet enough
 * that data sits in front of it. Light and dark are the same tiles with a different raster
 * paint — no second tile provider, no key.
 *
 * Under the tiles lies an offline fallback shipped with the app (public/basemap/, built by
 * scripts/fetch-basemap.mjs from Natural Earth): land and water, borders, roads and place names.
 * Online the tiles hide it. Without internet the tile requests fail, MapLibre draws no tile and
 * the fallback shows through — no page has anything to detect or switch.
 *
 * The layer ids are fixed so `useBasemapTheme` can repaint an existing map when the theme
 * changes, without rebuilding the style and losing the sources and layers added on top.
 */
export const BASEMAP_BACKGROUND_ID = 'basemap-bg';
export const BASEMAP_RASTER_ID = 'basemap-osm';

/** The offline layers, bottom to top; all of them sit between the background and the raster. */
export const BASEMAP_OFFLINE = {
  land: 'basemap-offline-land',
  detailMask: 'basemap-offline-detail-mask',
  detailLand: 'basemap-offline-detail-land',
  lakes: 'basemap-offline-lakes',
  rivers: 'basemap-offline-rivers',
  roads: 'basemap-offline-roads',
  borders: 'basemap-offline-borders',
  towns: 'basemap-offline-towns',
  townLabels: 'basemap-offline-town-labels',
  countryLabels: 'basemap-offline-country-labels',
} as const;

/** The glyphs in public/basemap/fonts/, a folder of that name (scripts/fetch-basemap.mjs). */
export const BASEMAP_FONT = 'Noto Sans Regular';

export interface BasemapOptions {
  /** The maritime screen: a darker, cooler sea behind the tiles. */
  ocean?: boolean;
}

/**
 * OpenStreetMap Carto's own colours for what the fallback draws: land, water, the country
 * border purple, motorway and primary road fills, place names and their halo. They go through
 * the tiles' raster paint (`rasterColour`), so offline the map reads as the online one with the
 * detail stripped, in either theme.
 */
const OSM = {
  land: '#f2efe9',
  water: '#aad3df',
  border: '#8d618b',
  mainRoad: '#e892a2',
  road: '#fcd6a4',
  town: '#222222',
  country: '#604260',
  halo: '#ffffff',
} as const;

const SOURCE = {
  land: 'ne-land',
  water: 'ne-water',
  borders: 'ne-borders',
  roads: 'ne-roads',
  places: 'ne-places',
} as const;

/** Natural Earth is public domain; the credit is courtesy, shown once for all its sources. */
const NATURAL_EARTH_CREDIT = 'Made with Natural Earth';

/** Natural Earth scalerank at or under which a road is drawn as a main road. */
const MAIN_ROAD_RANK = 4;

export function basemapStyle(palette: Palette, options: BasemapOptions = {}): StyleSpecification {
  const behind = options.ocean ? oceanColour(palette) : palette.map;
  const colour = (osm: string) => rasterColour(osm, palette.raster, behind);
  const water = colour(OSM.water);
  const land = colour(OSM.land);
  const halo = colour(OSM.halo);
  const town = colour(OSM.town);
  const base = basemapUrl();

  return {
    version: 8,
    glyphs: `${base}/fonts/{fontstack}/{range}.pbf`,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© OpenStreetMap contributors',
      },
      [SOURCE.land]: offlineSource(base, 'land', NATURAL_EARTH_CREDIT),
      [SOURCE.water]: offlineSource(base, 'water'),
      [SOURCE.borders]: offlineSource(base, 'borders'),
      [SOURCE.roads]: offlineSource(base, 'roads'),
      [SOURCE.places]: offlineSource(base, 'places'),
    },
    layers: [
      // The sea, offline; online it is only seen until the first tiles arrive.
      { id: BASEMAP_BACKGROUND_ID, type: 'background', paint: { 'background-color': water } },
      ...offlineLayers({ water, land, halo, town, colour }),
      { id: BASEMAP_RASTER_ID, type: 'raster', source: 'osm', paint: opaqueRaster(palette.raster, behind) },
    ],
  };
}

function offlineLayers({
  water,
  land,
  halo,
  town,
  colour,
}: {
  water: string;
  land: string;
  halo: string;
  town: string;
  colour: (osm: string) => string;
}): LayerSpecification[] {
  // `minzoom` and `maxzoom` are per feature (Natural Earth's own, see the fetch script).
  const towns: FilterSpecification = ['all', ['==', ['get', 'kind'], 'city'], ['>=', ['zoom'], ['get', 'minzoom']]];
  const kind = (value: string): FilterSpecification => ['==', ['get', 'kind'], value];

  return [
    { id: BASEMAP_OFFLINE.land, type: 'fill', source: SOURCE.land, filter: kind('land'), paint: { 'fill-color': land } },
    // Over West Africa the 1:50m coast is masked with sea and the 1:10m land drawn on top. No
    // antialiasing on the mask: its outline would draw a sea-coloured hairline along the box.
    {
      id: BASEMAP_OFFLINE.detailMask,
      type: 'fill',
      source: SOURCE.land,
      filter: kind('mask'),
      paint: { 'fill-color': water, 'fill-antialias': false },
    },
    {
      id: BASEMAP_OFFLINE.detailLand,
      type: 'fill',
      source: SOURCE.land,
      filter: kind('detail'),
      paint: { 'fill-color': land },
    },
    { id: BASEMAP_OFFLINE.lakes, type: 'fill', source: SOURCE.water, filter: kind('lake'), paint: { 'fill-color': water } },
    {
      id: BASEMAP_OFFLINE.rivers,
      type: 'line',
      source: SOURCE.water,
      filter: ['all', ['==', ['get', 'kind'], 'river'], ['>=', ['zoom'], ['get', 'minzoom']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': water,
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 7, 1, 12, 2.4],
      },
    },
    {
      id: BASEMAP_OFFLINE.roads,
      type: 'line',
      source: SOURCE.roads,
      filter: ['>=', ['zoom'], ['get', 'minzoom']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['<=', ['get', 'rank'], MAIN_ROAD_RANK], colour(OSM.mainRoad), colour(OSM.road)],
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          4,
          ['case', ['<=', ['get', 'rank'], MAIN_ROAD_RANK], 0.6, 0.3],
          8,
          ['case', ['<=', ['get', 'rank'], MAIN_ROAD_RANK], 1.4, 0.8],
          12,
          ['case', ['<=', ['get', 'rank'], MAIN_ROAD_RANK], 3, 1.8],
        ],
      },
    },
    {
      id: BASEMAP_OFFLINE.borders,
      type: 'line',
      source: SOURCE.borders,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': colour(OSM.border),
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 1, 10, 1.6],
      },
    },
    {
      id: BASEMAP_OFFLINE.towns,
      type: 'circle',
      source: SOURCE.places,
      filter: towns,
      paint: {
        'circle-color': town,
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          2,
          ['case', ['has', 'capital'], 2.2, 1.6],
          8,
          ['case', ['has', 'capital'], 3.2, 2.4],
        ],
        'circle-stroke-color': halo,
        'circle-stroke-width': 0.8,
      },
    },
    {
      id: BASEMAP_OFFLINE.townLabels,
      type: 'symbol',
      source: SOURCE.places,
      filter: towns,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': [BASEMAP_FONT],
        'text-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          2,
          ['case', ['has', 'capital'], 11, 10],
          8,
          ['case', ['has', 'capital'], 13, 12],
        ],
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
        'text-radial-offset': 0.5,
        'text-justify': 'auto',
        'text-max-width': 8,
        'text-padding': 3,
        // Larger places are placed first and win collisions.
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: { 'text-color': town, 'text-halo-color': halo, 'text-halo-width': 1.2 },
    },
    {
      id: BASEMAP_OFFLINE.countryLabels,
      type: 'symbol',
      source: SOURCE.places,
      filter: [
        'all',
        ['==', ['get', 'kind'], 'country'],
        ['>=', ['zoom'], ['get', 'minzoom']],
        ['<=', ['zoom'], ['get', 'maxzoom']],
      ],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': [BASEMAP_FONT],
        'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 5, 12, 8, 14],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.12,
        'text-max-width': 7,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: { 'text-color': colour(OSM.country), 'text-halo-color': halo, 'text-halo-width': 1.2 },
    },
  ];
}

function offlineSource(base: string, name: string, attribution?: string): GeoJSONSourceSpecification {
  // maxzoom 12: the data is no finer than ~10 m, and deeper tiles would only cost worker time.
  return { type: 'geojson', data: `${base}/${name}.geojson`, maxzoom: 12, ...(attribution ? { attribution } : {}) };
}

/**
 * Where the bundled basemap is served: the page's own origin — http://tauri.localhost in the
 * desktop app, the API's address for a phone on the LAN, the dev server otherwise. Absolute,
 * because MapLibre loads some resources from its workers. Styles are only built in the browser;
 * the relative fallback just keeps a static prerender from crashing.
 */
function basemapUrl(): string {
  return typeof window === 'undefined' ? '/basemap' : `${window.location.origin}/basemap`;
}

function oceanColour(palette: Palette): string {
  return palette.bg === '#121314' ? '#15181c' : '#d3d7dc';
}

/* ------------------------------------------------------------------------ raster paint */

type RasterPaint = Palette['raster'];

function channels(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((start) => parseInt(value.slice(start, start + 2), 16) / 255) as [number, number, number];
}

function hex(rgb: number[]): string {
  const byte = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0');
  return `#${rgb.map(byte).join('')}`;
}

/**
 * The colour a tile pixel of `osm` ends up on screen: MapLibre's raster shader (saturation,
 * contrast, brightness range) then the layer's opacity over what is behind it.
 */
export function rasterColour(osm: string, raster: RasterPaint, behind: string): string {
  const saturation = raster['raster-saturation'];
  const saturationFactor = saturation > 0 ? 1 - 1 / (1.001 - saturation) : -saturation;
  const contrast = raster['raster-contrast'];
  const contrastFactor = contrast > 0 ? 1 / (1 - contrast) : 1 + contrast;
  const low = raster['raster-brightness-min'];
  const high = raster['raster-brightness-max'];
  const opacity = raster['raster-opacity'];
  const rgb = channels(osm);
  const average = (rgb[0] + rgb[1] + rgb[2]) / 3;
  const back = channels(behind);
  return hex(
    rgb.map((value, index) => {
      const grey = value + (average - value) * saturationFactor;
      const contrasted = (grey - 0.5) * contrastFactor + 0.5;
      const bright = low + (high - low) * contrasted;
      return Math.min(1, Math.max(0, bright * opacity)) + back[index] * (1 - opacity);
    }),
  );
}

/**
 * The charte's raster paint made opaque without changing its look: the see-through part is
 * folded into the brightness range, as if blended over `behind`. A translucent raster would let
 * the offline layers underneath show through the tiles online.
 */
export function opaqueRaster(raster: RasterPaint, behind: string): RasterPaint {
  const opacity = raster['raster-opacity'];
  const [r, g, b] = channels(behind);
  const seen = ((r + g + b) / 3) * (1 - opacity);
  const fold = (value: number) => Math.round((value * opacity + seen) * 10_000) / 10_000;
  return {
    ...raster,
    'raster-opacity': 1,
    'raster-brightness-min': fold(raster['raster-brightness-min']),
    'raster-brightness-max': fold(raster['raster-brightness-max']),
  };
}

/* --------------------------------------------------------------------------- theme hook */

/**
 * Sets every paint property of the basemap layers to the palette's values, read back from
 * `basemapStyle` so building and repainting never drift apart. Layers the map does not have
 * are skipped: a custom style (NEXT_PUBLIC_MAP_STYLE_URL) is left alone.
 */
export function repaintBasemap(
  map: Pick<MapLibreMap, 'getLayer' | 'setPaintProperty'>,
  palette: Palette,
  options: BasemapOptions = {},
): void {
  for (const layer of basemapStyle(palette, options).layers) {
    if (!map.getLayer(layer.id)) continue;
    for (const [property, value] of Object.entries(layer.paint ?? {})) {
      map.setPaintProperty(layer.id, property, value);
    }
  }
}

/** Repaints the basemap of an already-built map when the palette changes (theme switch). */
export function useBasemapTheme(
  map: MapLibreMap | null | undefined,
  palette: Palette,
  options: BasemapOptions = {},
) {
  const ocean = options.ocean ?? false;
  useEffect(() => {
    if (!map) return;
    const apply = () => repaintBasemap(map, palette, { ocean });
    // Paint can be set as soon as the style is parsed. isStyleLoaded() would also wait for tiles
    // and GeoJSON, and 'load' fires only once, so a theme switch mid-load would be lost.
    if (map.getLayer(BASEMAP_BACKGROUND_ID)) {
      apply();
      return;
    }
    map.once('load', apply);
    return () => {
      map.off('load', apply);
    };
  }, [map, palette, ocean]);
}

/**
 * Keeps pages from waiting on a network that hangs. On a Wi-Fi with no internet access, OSM tile
 * requests fail late, after the map has gone quiet; MapLibre then completes its load (the `load`
 * event pages wait for before adding their data) only on the next frame, which nothing schedules
 * until someone pans. Repainting when a basemap tile fails releases it at once; the offline
 * fallback below the raster is already visible. The listener goes away with `map.remove()`.
 */
export function watchBasemapTiles(map: Pick<MapLibreMap, 'on' | 'triggerRepaint'>): void {
  map.on('error', (event: { sourceId?: string }) => {
    if (event.sourceId === 'osm') map.triggerRepaint();
  });
}

