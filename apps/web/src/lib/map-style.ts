'use client';

import type maplibregl from 'maplibre-gl';
import { useEffect } from 'react';
import type { Palette } from './theme';

/**
 * One basemap for every map in SCIP (charte §03): OSM raster, fully desaturated, quiet enough
 * that data sits in front of it. Light and dark are the same tiles with a different raster
 * paint — no second tile provider, no key.
 *
 * The layer ids are fixed so `useBasemapTheme` can repaint an existing map when the theme
 * changes, without rebuilding the style and losing the sources and layers added on top.
 */
export const BASEMAP_BACKGROUND_ID = 'basemap-bg';
export const BASEMAP_RASTER_ID = 'basemap-osm';

export function basemapStyle(palette: Palette, options: { ocean?: boolean } = {}): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [
      {
        id: BASEMAP_BACKGROUND_ID,
        type: 'background',
        paint: { 'background-color': options.ocean ? oceanColour(palette) : palette.map },
      },
      { id: BASEMAP_RASTER_ID, type: 'raster', source: 'osm', paint: { ...palette.raster } },
    ],
  };
}

function oceanColour(palette: Palette): string {
  return palette.bg === '#121314' ? '#15181c' : '#d3d7dc';
}

/** Repaints the basemap of an already-built map when the palette changes (theme switch). */
export function useBasemapTheme(
  map: maplibregl.Map | null | undefined,
  palette: Palette,
  options: { ocean?: boolean } = {},
) {
  const ocean = options.ocean ?? false;
  useEffect(() => {
    if (!map) return;
    const apply = () => {
      if (map.getLayer(BASEMAP_BACKGROUND_ID)) {
        map.setPaintProperty(BASEMAP_BACKGROUND_ID, 'background-color', ocean ? oceanColour(palette) : palette.map);
      }
      if (map.getLayer(BASEMAP_RASTER_ID)) {
        for (const [key, value] of Object.entries(palette.raster)) {
          map.setPaintProperty(BASEMAP_RASTER_ID, key, value);
        }
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [map, palette, ocean]);
}
