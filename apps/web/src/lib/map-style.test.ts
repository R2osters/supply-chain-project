import { featureFilter, validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { FilterSpecification, LayerSpecification } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BASEMAP_BACKGROUND_ID,
  BASEMAP_FONT,
  BASEMAP_OFFLINE,
  BASEMAP_RASTER_ID,
  basemapStyle,
  opaqueRaster,
  rasterColour,
  repaintBasemap,
} from './map-style';
import { PALETTES } from './theme';

const light = PALETTES.light;
const dark = PALETTES.dark;

const layer = (style: ReturnType<typeof basemapStyle>, id: string) => {
  const found = style.layers.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no layer ${id}`);
  return found as LayerSpecification & {
    paint: Record<string, unknown>;
    layout?: Record<string, unknown>;
    filter?: FilterSpecification;
  };
};

const luminance = (hex: string) => {
  const value = hex.replace('#', '');
  return [0, 2, 4].reduce((sum, start) => sum + parseInt(value.slice(start, start + 2), 16), 0) / 3;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('basemapStyle', () => {
  it('stacks background, then the offline layers in a fixed order, then the OSM raster', () => {
    const ids = basemapStyle(light).layers.map((candidate) => candidate.id);
    expect(ids).toEqual([BASEMAP_BACKGROUND_ID, ...Object.values(BASEMAP_OFFLINE), BASEMAP_RASTER_ID]);
    expect(ids).toEqual(basemapStyle(dark, { ocean: true }).layers.map((candidate) => candidate.id));
  });

  it('is a valid MapLibre style in both themes, with and without the ocean', () => {
    for (const palette of [light, dark]) {
      for (const ocean of [false, true]) {
        expect(validateStyleMin(basemapStyle(palette, { ocean }))).toEqual([]);
      }
    }
  });

  it('points glyphs and data at the page origin, as absolute URLs', () => {
    vi.stubGlobal('window', { location: { origin: 'http://tauri.localhost' } });
    const style = basemapStyle(light);
    expect(style.glyphs).toBe('http://tauri.localhost/basemap/fonts/{fontstack}/{range}.pbf');
    const data = Object.values(style.sources)
      .filter((source) => source.type === 'geojson')
      .map((source) => ('data' in source ? source.data : null));
    expect(data).toEqual([
      'http://tauri.localhost/basemap/land.geojson',
      'http://tauri.localhost/basemap/water.geojson',
      'http://tauri.localhost/basemap/borders.geojson',
      'http://tauri.localhost/basemap/roads.geojson',
      'http://tauri.localhost/basemap/places.geojson',
    ]);
  });

  it('stays buildable without a window (static prerender)', () => {
    expect(basemapStyle(light).glyphs).toBe('/basemap/fonts/{fontstack}/{range}.pbf');
  });

  it('labels with the bundled font only', () => {
    const symbols = basemapStyle(light).layers.filter((candidate) => candidate.type === 'symbol');
    expect(symbols.length).toBeGreaterThan(0);
    for (const symbol of symbols) expect(symbol.layout?.['text-font']).toEqual([BASEMAP_FONT]);
  });

  it('credits Natural Earth once and keeps the OSM credit', () => {
    const credits = Object.values(basemapStyle(light).sources).map((source) =>
      'attribution' in source ? source.attribution : undefined,
    );
    expect(credits.filter((credit) => credit === 'Made with Natural Earth')).toHaveLength(1);
    expect(credits).toContain('© OpenStreetMap contributors');
  });

  it('shows towns from their own minzoom, and countries between minzoom and maxzoom', () => {
    const style = basemapStyle(light);
    const accepts = (id: string, zoom: number, properties: Record<string, unknown>) =>
      featureFilter(layer(style, id).filter).filter({ zoom }, { type: 1, properties } as never);
    const tema = { kind: 'city', name: 'Tema', rank: 7, minzoom: 5.7 };
    expect(accepts(BASEMAP_OFFLINE.townLabels, 5, tema)).toBe(false);
    expect(accepts(BASEMAP_OFFLINE.townLabels, 6, tema)).toBe(true);
    expect(accepts(BASEMAP_OFFLINE.townLabels, 6, { ...tema, kind: 'country' })).toBe(false);
    const ghana = { kind: 'country', name: 'Ghana', rank: 3, minzoom: 2.7, maxzoom: 8 };
    expect(accepts(BASEMAP_OFFLINE.countryLabels, 2, ghana)).toBe(false);
    expect(accepts(BASEMAP_OFFLINE.countryLabels, 5, ghana)).toBe(true);
    expect(accepts(BASEMAP_OFFLINE.countryLabels, 9, ghana)).toBe(false);
  });
});

describe('offline paint', () => {
  it('matches the online tiles: land lighter than water in light, darker in dark', () => {
    for (const [palette, landIsLighter] of [
      [light, true],
      [dark, false],
    ] as const) {
      const style = basemapStyle(palette);
      const water = layer(style, BASEMAP_BACKGROUND_ID).paint['background-color'] as string;
      const land = layer(style, BASEMAP_OFFLINE.land).paint['fill-color'] as string;
      expect(luminance(land) > luminance(water)).toBe(landIsLighter);
      // Mask and lakes are sea; the 1:10m land is the same land.
      expect(layer(style, BASEMAP_OFFLINE.detailMask).paint['fill-color']).toBe(water);
      expect(layer(style, BASEMAP_OFFLINE.lakes).paint['fill-color']).toBe(water);
      expect(layer(style, BASEMAP_OFFLINE.detailLand).paint['fill-color']).toBe(land);
    }
  });

  it('keeps names readable: dark text on a light halo in light, the reverse in dark', () => {
    for (const [palette, textIsDarker] of [
      [light, true],
      [dark, false],
    ] as const) {
      const labels = layer(basemapStyle(palette), BASEMAP_OFFLINE.townLabels).paint;
      const text = luminance(labels['text-color'] as string);
      const halo = luminance(labels['text-halo-color'] as string);
      expect(text < halo).toBe(textIsDarker);
      expect(Math.abs(text - halo)).toBeGreaterThan(60);
    }
  });

  it('never draws the mask outline, which would show the detail box as a line', () => {
    expect(layer(basemapStyle(light), BASEMAP_OFFLINE.detailMask).paint['fill-antialias']).toBe(false);
  });

  it('changes every colour between themes', () => {
    const lightStyle = basemapStyle(light);
    const darkStyle = basemapStyle(dark);
    for (const id of [BASEMAP_BACKGROUND_ID, BASEMAP_OFFLINE.land, BASEMAP_OFFLINE.borders, BASEMAP_OFFLINE.townLabels]) {
      expect(layer(lightStyle, id).paint).not.toEqual(layer(darkStyle, id).paint);
    }
  });

  it('keeps the maritime sea: the ocean option changes the sea and what the tiles are folded over', () => {
    for (const palette of [light, dark]) {
      const plain = basemapStyle(palette);
      const ocean = basemapStyle(palette, { ocean: true });
      expect(layer(ocean, BASEMAP_BACKGROUND_ID).paint['background-color']).not.toBe(
        layer(plain, BASEMAP_BACKGROUND_ID).paint['background-color'],
      );
      expect(layer(ocean, BASEMAP_RASTER_ID).paint).not.toEqual(layer(plain, BASEMAP_RASTER_ID).paint);
    }
  });
});

describe('raster paint', () => {
  const identity = {
    'raster-opacity': 1,
    'raster-saturation': 0,
    'raster-contrast': 0,
    'raster-brightness-min': 0,
    'raster-brightness-max': 1,
  };

  it('reproduces the shader: identity, greyscale, opacity', () => {
    expect(rasterColour('#aad3df', identity, '#000000')).toBe('#aad3df');
    expect(rasterColour('#ff0000', { ...identity, 'raster-saturation': -1 }, '#000000')).toBe('#555555');
    expect(rasterColour('#ff0000', { ...identity, 'raster-opacity': 0 }, '#123456')).toBe('#123456');
    // Inverted brightness range, as the dark theme uses it.
    expect(rasterColour('#ffffff', { ...identity, 'raster-brightness-min': 1, 'raster-brightness-max': 0 }, '#000000')).toBe(
      '#000000',
    );
  });

  it('is opaque and looks the same as the charte paint over the plain background', () => {
    const samples = ['#f2efe9', '#aad3df', '#e892a2', '#222222', '#ffffff', '#000000', '#8d618b', '#cdebb0'];
    for (const palette of [light, dark]) {
      for (const behind of [palette.map, palette.bg === '#121314' ? '#15181c' : '#d3d7dc']) {
        const opaque = opaqueRaster(palette.raster, behind);
        expect(opaque['raster-opacity']).toBe(1);
        for (const sample of samples) {
          const before = rasterColour(sample, palette.raster, behind);
          // With an opaque raster nothing behind it shows: black stands in for "anything".
          const after = rasterColour(sample, opaque, '#000000');
          expect(Math.abs(luminance(before) - luminance(after))).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('is what the style ships', () => {
    expect(layer(basemapStyle(light), BASEMAP_RASTER_ID).paint).toEqual(opaqueRaster(light.raster, light.map));
  });
});

describe('repaintBasemap', () => {
  const fakeMap = (ids: string[]) => {
    const calls: Array<[string, string, unknown]> = [];
    return {
      calls,
      getLayer: (id: string) => (ids.includes(id) ? ({ id } as never) : undefined),
      setPaintProperty: ((id: string, property: string, value: unknown) => {
        calls.push([id, property, value]);
      }) as never,
    };
  };

  it('repaints every basemap layer to the new theme', () => {
    const target = basemapStyle(dark);
    const map = fakeMap(target.layers.map((candidate) => candidate.id));
    repaintBasemap(map, dark);
    const repainted = new Set(map.calls.map(([id]) => id));
    expect(repainted).toEqual(new Set(target.layers.map((candidate) => candidate.id)));
    for (const [id, property, value] of map.calls) expect(layer(target, id).paint[property]).toEqual(value);
  });

  it('leaves a custom style alone', () => {
    const map = fakeMap(['someone-elses-layer']);
    repaintBasemap(map, dark);
    expect(map.calls).toEqual([]);
  });
});

describe('watchBasemapTiles', () => {
  it('repaints when a basemap tile fails, and only then', async () => {
    const { watchBasemapTiles } = await import('./map-style');
    let listener: ((event: { sourceId?: string }) => void) | null = null;
    let repaints = 0;
    const map = {
      on: (_type: string, handler: (event: { sourceId?: string }) => void) => {
        listener = handler;
      },
      triggerRepaint: () => {
        repaints += 1;
      },
    };
    watchBasemapTiles(map as never);
    listener!({ sourceId: 'osm' });
    listener!({ sourceId: 'live-aircraft' });
    listener!({});
    expect(repaints).toBe(1);
  });
});
