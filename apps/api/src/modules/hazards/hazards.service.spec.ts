import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedSettingsService } from '../settings/feed-settings.service';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import type { PrismaService } from '../../prisma/prisma.service';
import { HazardsService, parseBoundingBox } from './hazards.service';

/**
 * Service wiring with `fetch` stubbed per host. No network: each upstream is a small in-memory
 * answer, and the point of these tests is the isolation between them.
 */

const USGS_BODY = {
  features: [
    {
      id: 'us1',
      geometry: { coordinates: [-0.2, 5.6, 10] },
      properties: { mag: 5.5, place: '5 km N of Accra, Ghana', time: Date.now(), tsunami: 0 },
    },
    {
      id: 'us2',
      geometry: { coordinates: [140, 35, 10] },
      properties: { mag: 4.5, place: 'Japan', time: Date.now(), tsunami: 0 },
    },
  ],
};

const WEATHER_BODY = {
  current: {
    time: '2026-09-28T12:00',
    temperature_2m: 25,
    precipitation: 0,
    weather_code: 95,
    wind_speed_10m: 30,
    wind_gusts_10m: 90,
    visibility: 10_000,
    cloud_cover: 100,
  },
};

type Route = (url: string) => Response | Promise<Response>;

function stubFetch(routes: Record<string, Route>): jest.Mock {
  const mock = jest.fn(async (input: string | URL) => {
    const url = String(input);
    const host = new URL(url).host;
    const route = routes[host];
    if (!route) throw new TypeError(`unexpected host ${host}`);
    return route(url);
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });
const down = () => new Response('oops', { status: 503 });

// Real GDACS and EONET answers of 2026-09-28/29, trimmed (see sources/__fixtures__).
const fixture = (name: string): { features?: Array<{ properties?: Record<string, unknown> }> } =>
  JSON.parse(readFileSync(join(__dirname, 'sources', '__fixtures__', name), 'utf8'));
const GDACS = fixture('gdacs-search.json');
const EONET = fixture('eonet-wildfires.json');
/** The fixtures' "now": GDACS liveness and the EONET window are judged against it. */
const FIXTURE_NOW = Date.UTC(2026, 8, 29, 14, 0);

/** Answers each GDACS query with the fixture events of its types; 204 when there are none. */
function gdacs(overrides: Record<string, Route> = {}): Route {
  return (url) => {
    const types = new URL(url).searchParams.get('eventlist') ?? '';
    const override = overrides[types];
    if (override) return override(url);
    const wanted = types.split(';');
    const features = (GDACS.features ?? []).filter((f) => wanted.includes(String(f.properties?.eventtype)));
    return features.length > 0
      ? new Response(JSON.stringify({ type: 'FeatureCollection', features }), { status: 200 })
      : new Response(null, { status: 204 });
  };
}

function makeService(firmsMapKey: string | null = null, prisma: Partial<Record<string, unknown>> = {}) {
  const config = {
    get: () => ({ firmsMapKey, hazardExposureRadiusKm: 100 }),
  } as unknown as ConfigService<AppConfig, true>;
  const feeds = { get: () => firmsMapKey } as unknown as FeedSettingsService;
  return new HazardsService(prisma as unknown as PrismaService, config, feeds);
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe('HazardsService.listHazards', () => {
  it('returns quakes when NHC is down, and reports NHC as unavailable', async () => {
    stubFetch({
      'www.nhc.noaa.gov': down,
      'earthquake.usgs.gov': json(USGS_BODY),
    });
    const result = await makeService().listHazards({});

    expect(result.hazards.map((h) => h.id)).toEqual(['usgs:us1', 'usgs:us2']);
    const byId = Object.fromEntries(result.sources.map((s) => [s.id, s]));
    expect(byId.nhc.status).toBe('UNAVAILABLE');
    expect(byId.nhc.note).toContain('503');
    expect(byId.usgs).toMatchObject({ status: 'OK', count: 2 });
    expect(byId.firms.status).toBe('DISABLED');
  });

  it('filters global feeds to the bounding box', async () => {
    stubFetch({
      'www.nhc.noaa.gov': json({ activeStorms: [] }),
      'earthquake.usgs.gov': json(USGS_BODY),
    });
    const result = await makeService().listHazards({ minLat: 0, minLon: -5, maxLat: 10, maxLon: 5 });
    expect(result.hazards.map((h) => h.id)).toEqual(['usgs:us1']);
  });

  it('never calls FIRMS without a key, and never without a bounding box', async () => {
    const fetchMock = stubFetch({
      'www.nhc.noaa.gov': json({ activeStorms: [] }),
      'earthquake.usgs.gov': json(USGS_BODY),
      'firms.modaps.eosdis.nasa.gov': () => new Response('latitude,longitude,acq_date,acq_time,confidence,frp\n'),
    });
    await makeService(null).listHazards({ minLat: 0, minLon: -5, maxLat: 10, maxLon: 5 });
    await makeService('KEY').listHazards({});
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('firms'))).toBe(false);
  });
});

describe('HazardsService.weatherSeverityAt', () => {
  it('returns the severity when Open-Meteo answers', async () => {
    stubFetch({ 'api.open-meteo.com': json(WEATHER_BODY) });
    expect(await makeService().weatherSeverityAt(5.6, -0.2)).toBeGreaterThanOrEqual(0.7);
  });

  it('returns null instead of throwing when Open-Meteo is down', async () => {
    stubFetch({ 'api.open-meteo.com': down });
    expect(await makeService().weatherSeverityAt(5.6, -0.2)).toBeNull();
  });
});

describe('HazardsService.companyExposure', () => {
  it('matches warehouses against quakes and local severe weather', async () => {
    stubFetch({
      'www.nhc.noaa.gov': json({ activeStorms: [] }),
      'earthquake.usgs.gov': json(USGS_BODY),
      'api.open-meteo.com': json(WEATHER_BODY),
    });
    const prisma = {
      warehouse: {
        findMany: jest.fn(async () => [{ id: 'w1', code: 'ACC', name: 'Accra DC', latitude: 5.6, longitude: -0.2 }]),
      },
      supplier: { findMany: jest.fn(async () => []) },
      shipment: { findMany: jest.fn(async () => []) },
      gpsPosition: { findFirst: jest.fn(async () => null) },
    };
    const result = await makeService(null, prisma).companyExposure('c1');

    expect(prisma.warehouse.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'c1', isActive: true } }),
    );
    expect(result.radiusKm).toBe(100);
    expect(result.exposures.map((e) => e.hazardKind).sort()).toEqual(['EARTHQUAKE', 'SEVERE_WEATHER']);
    expect(result.sources.map((s) => s.id)).toEqual(['nhc', 'usgs', 'gdacs', 'firms', 'eonet', 'open-meteo']);
  });
});

describe('HazardsService keyless feeds (GDACS, EONET)', () => {
  // The fixtures are dated; liveness and the EONET window are judged against their own "now".
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 28, 12, 0));
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const routes = (overrides: Record<string, Route> = {}): Record<string, Route> => ({
    'www.nhc.noaa.gov': json({ activeStorms: [] }),
    'earthquake.usgs.gov': json({ features: [] }),
    'www.gdacs.org': gdacs(),
    'eonet.gsfc.nasa.gov': json(EONET),
    ...overrides,
  });

  it('shows floods, droughts, eruptions, cyclones and fires with no key at all', async () => {
    stubFetch(routes());
    const result = await makeService(null).listHazards({});

    const kinds = new Set(result.hazards.map((h) => h.kind));
    expect(kinds).toEqual(new Set(['FLOOD', 'DROUGHT', 'VOLCANO', 'CYCLONE', 'FIRE']));
    const byId = Object.fromEntries(result.sources.map((s) => [s.id, s]));
    expect(result.sources.map((s) => s.id)).toEqual(['nhc', 'usgs', 'gdacs', 'firms', 'eonet']);
    expect(byId.gdacs).toMatchObject({ status: 'OK', count: 8, attribution: expect.stringContaining('JRC / UN OCHA') });
    expect(byId.eonet).toMatchObject({ status: 'OK', count: 1 });
    expect(byId.firms.status).toBe('DISABLED');
    expect(byId.firms.note).toContain('GDACS');
  });

  it('shows a fire reported by both GDACS and EONET once', async () => {
    stubFetch(routes());
    const result = await makeService(null).listHazards({});
    const usFire = result.hazards.find((h) => h.id === 'gdacs:WF:1032460');
    expect(usFire?.details.sameFireAs).toBe('eonet:EONET_24484');
    expect(result.hazards.some((h) => h.id === 'eonet:EONET_24484')).toBe(false);
    expect(result.hazards.some((h) => h.id === 'eonet:EONET_24904')).toBe(true);
  });

  it('leaves fires to FIRMS when a key is set: no GDACS fire query, no EONET call', async () => {
    const fetchMock = stubFetch(routes());
    const result = await makeService('KEY').listHazards({});

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes('eonet.gsfc.nasa.gov'))).toBe(false);
    expect(urls.some((url) => new URL(url).searchParams.get('eventlist') === 'WF')).toBe(false);
    expect(result.hazards.some((h) => h.kind === 'FIRE')).toBe(false);
    expect(result.sources.find((s) => s.id === 'eonet')?.status).toBe('DISABLED');
  });

  it('drops GDACS cyclones in NHC basins while NHC answers, and keeps them when it is down', async () => {
    stubFetch(routes());
    const withNhc = await makeService(null).listHazards({});
    expect(withNhc.hazards.map((h) => h.id)).not.toContain('gdacs:TC:1001325'); // POLO, eastern Pacific
    expect(withNhc.hazards.map((h) => h.id)).toContain('gdacs:TC:1001327'); // SURIGAE, West Pacific
    expect(withNhc.sources[0].note).toContain('les cyclones des autres bassins viennent de GDACS');

    stubFetch(routes({ 'www.nhc.noaa.gov': down }));
    const withoutNhc = await makeService(null).listHazards({});
    expect(withoutNhc.hazards.map((h) => h.id)).toEqual(
      expect.arrayContaining(['gdacs:TC:1001325', 'gdacs:TC:1001327']),
    );
  });

  it('keeps the other GDACS queries when one fails, and says which part is missing', async () => {
    stubFetch(routes({ 'www.gdacs.org': gdacs({ DR: down }) }));
    const result = await makeService(null).listHazards({});

    const status = result.sources.find((s) => s.id === 'gdacs');
    expect(status).toMatchObject({ status: 'STALE' });
    expect(status?.note).toContain('sécheresses');
    expect(result.hazards.some((h) => h.kind === 'FLOOD')).toBe(true);
    expect(result.hazards.some((h) => h.kind === 'DROUGHT')).toBe(false);
  });

  it('keeps the NHC coverage caveat when GDACS is down', async () => {
    stubFetch(routes({ 'www.gdacs.org': down }));
    const result = await makeService(null).listHazards({});
    expect(result.sources.find((s) => s.id === 'gdacs')?.status).toBe('UNAVAILABLE');
    expect(result.sources[0].note).toContain('les typhons du Pacifique Ouest et les cyclones de l’océan Indien n’y figurent pas');
  });

  it('matches a warehouse against a GDACS flood', async () => {
    const calm = { current: { ...WEATHER_BODY.current, weather_code: 0, wind_gusts_10m: 10 } };
    stubFetch(routes({ 'api.open-meteo.com': json(calm) }));
    const prisma = {
      warehouse: {
        findMany: jest.fn(async () => [{ id: 'w1', code: 'CKY', name: 'Kankan DC', latitude: 8.5, longitude: -8.9 }]),
      },
      supplier: { findMany: jest.fn(async () => []) },
      shipment: { findMany: jest.fn(async () => []) },
      gpsPosition: { findFirst: jest.fn(async () => null) },
    };
    const result = await makeService(null, prisma).companyExposure('c1');
    expect(result.exposures).toEqual([
      expect.objectContaining({ hazardId: 'gdacs:FL:1104178', hazardKind: 'FLOOD', subjectId: 'w1' }),
    ]);
  });
});

describe('HazardsService.news', () => {
  it('reports UNAVAILABLE rather than throwing when GDELT scolds us in plain text', async () => {
    stubFetch({ 'api.gdeltproject.org': () => new Response('Please limit requests to one every 5 seconds') });
    const result = await makeService().news({ q: 'Tema port' });
    expect(result).toEqual({ status: 'UNAVAILABLE', query: 'Tema port', articles: [], attribution: 'GDELT Project' });
  });

  it('requires either words or a point', async () => {
    await expect(makeService().news({})).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('parseBoundingBox', () => {
  it('accepts all four edges or none, and rejects half a box', () => {
    expect(parseBoundingBox({})).toBeNull();
    expect(() => parseBoundingBox({ minLat: 1, maxLat: 2 })).toThrow(BadRequestException);
    expect(() => parseBoundingBox({ minLat: 5, minLon: 0, maxLat: 1, maxLon: 1 })).toThrow('minLat');
  });
});
