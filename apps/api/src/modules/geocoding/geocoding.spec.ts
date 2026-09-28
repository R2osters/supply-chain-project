import { RequestGate } from '../../common/http';
import { GeocodersUnavailableError, runGeocodeCascade, type GeocodeFetchers } from './geocoding-cascade';
import {
  normalizeNominatimReverse,
  normalizeNominatimSearch,
  normalizePhotonResponse,
  parseCoordinateQuery,
  type GeocodeResult,
} from './geocoding-normalizers';
import { GeocodingService } from './geocoding.service';

// Hand-written fixtures in the shape each service returns.
const PHOTON_TEMA = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0.0167, 5.6352] },
      properties: { name: 'Tema Port', osm_value: 'harbour', type: 'other', city: 'Tema', state: 'Greater Accra Region', country: 'Ghana' },
    },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [200, 95] }, properties: { name: 'Nowhere' } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { name: 'A road' } },
  ],
};

const NOMINATIM_SEARCH = [
  {
    lat: '5.6400',
    lon: '0.0100',
    display_name: 'Tema, Tema Metropolitan, Greater Accra Region, Ghana',
    category: 'place',
    type: 'city',
    addresstype: 'city',
    address: { city: 'Tema', country: 'Ghana', country_code: 'gh' },
  },
  { lat: 'x', lon: '0', display_name: 'broken' },
];

const NOMINATIM_REVERSE = {
  display_name: 'Osu, Accra, Accra Metropolitan, Greater Accra Region, Ghana',
  address: { suburb: 'Osu', city: 'Accra', state: 'Greater Accra Region', country: 'Ghana', country_code: 'gh' },
};

const result = (label: string): GeocodeResult => ({ label, latitude: 1, longitude: 2, kind: null, country: null });

describe('parseCoordinateQuery', () => {
  it.each([
    ['5.6, -0.18', 5.6, -0.18],
    ['5.6 -0.18', 5.6, -0.18],
    ['5.6;-0.18', 5.6, -0.18],
    ['  -33.8688 , 151.2093 ', -33.8688, 151.2093],
    ['5.6N 0.18W', 5.6, -0.18],
    ['33.87° S, 151.21° E', -33.87, 151.21],
  ])('reads %p', (text, latitude, longitude) => {
    expect(parseCoordinateQuery(text)).toEqual({ latitude, longitude });
  });

  it.each(['Tema port', '5.6', '95.0, 10.0', '10, 200.5', '10 20', '-5.6N 0.18W', '5.6, -0.18, 3'])(
    'does not treat %p as coordinates',
    (text) => {
      expect(parseCoordinateQuery(text)).toBeNull();
    },
  );
});

describe('normalizePhotonResponse', () => {
  it('keeps valid points with a composed label and drops the rest', () => {
    expect(normalizePhotonResponse(PHOTON_TEMA)).toEqual([
      {
        label: 'Tema Port, Tema, Greater Accra Region, Ghana',
        latitude: 5.6352,
        longitude: 0.0167,
        kind: 'harbour',
        country: 'Ghana',
      },
    ]);
  });

  it('throws on a body that is not a feature collection', () => {
    expect(() => normalizePhotonResponse({ message: 'rate limited' })).toThrow();
  });
});

describe('normalizeNominatimSearch', () => {
  it('parses string coordinates and skips invalid rows', () => {
    expect(normalizeNominatimSearch(NOMINATIM_SEARCH)).toEqual([
      {
        label: 'Tema, Tema Metropolitan, Greater Accra Region, Ghana',
        latitude: 5.64,
        longitude: 0.01,
        kind: 'city',
        country: 'Ghana',
      },
    ]);
  });
});

describe('normalizeNominatimReverse', () => {
  it('picks the most specific settlement and upper-cases the country code', () => {
    expect(normalizeNominatimReverse(NOMINATIM_REVERSE)).toEqual({
      label: 'Osu, Accra, Accra Metropolitan, Greater Accra Region, Ghana',
      locality: 'Accra',
      region: 'Greater Accra Region',
      country: 'Ghana',
      countryCode: 'GH',
    });
  });

  it('returns null for an explicit no-result answer', () => {
    expect(normalizeNominatimReverse({ error: 'Unable to geocode' })).toBeNull();
  });
});

describe('runGeocodeCascade', () => {
  const fetchers = (overrides: Partial<GeocodeFetchers>): GeocodeFetchers => ({
    photon: jest.fn(async () => [result('photon')]),
    nominatim: jest.fn(async () => [result('nominatim')]),
    ...overrides,
  });

  it('answers coordinates without calling any provider', async () => {
    const f = fetchers({});
    const response = await runGeocodeCascade('5.6, -0.18', 5, f);
    expect(response.source).toBe('coordinates');
    expect(response.results[0]).toMatchObject({ latitude: 5.6, longitude: -0.18, kind: 'coordinates' });
    expect(f.photon).not.toHaveBeenCalled();
    expect(f.nominatim).not.toHaveBeenCalled();
  });

  it('uses Photon and leaves Nominatim alone when Photon has results', async () => {
    const f = fetchers({});
    await expect(runGeocodeCascade('Tema', 5, f)).resolves.toEqual({ source: 'photon', results: [result('photon')] });
    expect(f.nominatim).not.toHaveBeenCalled();
  });

  it('falls back to Nominatim when Photon fails', async () => {
    const f = fetchers({ photon: jest.fn(async () => Promise.reject(new Error('down'))) });
    await expect(runGeocodeCascade('Tema', 5, f)).resolves.toMatchObject({ source: 'nominatim' });
  });

  it('falls back to Nominatim when Photon finds nothing', async () => {
    const f = fetchers({ photon: jest.fn(async () => []) });
    await expect(runGeocodeCascade('Tema', 5, f)).resolves.toMatchObject({ source: 'nominatim' });
  });

  it('reports none when both answered empty, and throws when both failed', async () => {
    const empty = fetchers({ photon: jest.fn(async () => []), nominatim: jest.fn(async () => []) });
    await expect(runGeocodeCascade('Atlantis', 5, empty)).resolves.toEqual({ source: 'none', results: [] });

    const down = fetchers({
      photon: jest.fn(async () => Promise.reject(new Error('a'))),
      nominatim: jest.fn(async () => Promise.reject(new Error('b'))),
    });
    await expect(runGeocodeCascade('Tema', 5, down)).rejects.toBeInstanceOf(GeocodersUnavailableError);
  });

  it('trims results to the limit', async () => {
    const many = fetchers({ photon: jest.fn(async () => [result('a'), result('b'), result('c')]) });
    await expect(runGeocodeCascade('Tema', 2, many)).resolves.toMatchObject({ results: [result('a'), result('b')] });
  });
});

describe('GeocodingService', () => {
  afterEach(() => jest.restoreAllMocks());

  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
  const openGate = () => new RequestGate({ minIntervalMs: 0 });

  it('makes one upstream request for concurrent identical searches and caches the answer', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => json(PHOTON_TEMA));
    const service = new GeocodingService(undefined, openGate());

    const [a, b] = await Promise.all([service.search('Tema port', 5), service.search('  tema   PORT ', 5)]);
    await service.search('Tema port', 5);
    expect(a.source).toBe('photon');
    expect(b).toEqual(a);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends an identifying User-Agent to Nominatim through the shared gate', async () => {
    const urls: string[] = [];
    const headers: Array<Record<string, string>> = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      urls.push(String(input));
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return String(input).includes('photon') ? new Response('busy', { status: 503 }) : json(NOMINATIM_SEARCH);
    });
    const gate = openGate();
    const runSpy = jest.spyOn(gate, 'run');
    const response = await new GeocodingService(undefined, gate).search('Tema', 5);

    expect(response.source).toBe('nominatim');
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(urls[1]).toContain('nominatim.openstreetmap.org/search?format=jsonv2');
    expect(headers[1]['User-Agent']).toMatch(/SCIP/);
  });

  it('does not cache a total failure', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('down', { status: 503 }));
    const service = new GeocodingService(undefined, openGate());
    await expect(service.search('Tema', 5)).resolves.toEqual({ source: 'none', results: [] });
    await service.search('Tema', 5);
    expect(fetchSpy).toHaveBeenCalledTimes(4); // photon + nominatim, twice
  });

  it('reverse-geocodes by 0.01 degree cell', async () => {
    const urls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      urls.push(String(input));
      return json(NOMINATIM_REVERSE);
    });
    const service = new GeocodingService(undefined, openGate());
    const first = await service.reverse(5.5561, -0.1731);
    const second = await service.reverse(5.5558, -0.1729);
    expect(first).toMatchObject({ source: 'nominatim', locality: 'Accra', countryCode: 'GH' });
    expect(second).toEqual(first);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('lat=5.5600');
    expect(urls[0]).toContain('lon=-0.1700');
  });

  it('reports none for reverse when Nominatim is unreachable', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('down', { status: 503 }));
    await expect(new GeocodingService(undefined, openGate()).reverse(5.6, -0.2)).resolves.toMatchObject({
      source: 'none',
      label: null,
    });
  });
});
