import { BadRequestException } from '@nestjs/common';
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
    expect(result.sources.map((s) => s.id)).toEqual(['nhc', 'usgs', 'firms', 'open-meteo']);
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
