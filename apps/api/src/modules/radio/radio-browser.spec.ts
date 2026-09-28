import {
  buildSearchPath,
  mirrorOrigin,
  normalizeStation,
  normalizeStations,
  parseMirrorList,
  publicHttpsUrl,
  selectNearbyStations,
} from './radio-browser';
import { RadioService, cellFor, radiusBucket } from './radio.service';

const ACCRA = { latitude: 5.6037, longitude: -0.187 };

// Hand-written in the shape Radio Browser returns; only the fields we read.
const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  stationuuid: '96062a7b-0601-11e8-ae97-52543be04c81',
  name: '  Joy\u0007 FM  ',
  url: 'https://example-stream.test/joy',
  url_resolved: 'https://stream.joyonline.example/live.mp3',
  homepage: 'https://www.myjoyonline.example/',
  tags: 'News,Talk,news_talk,Traffic',
  country: 'Ghana',
  countrycode: 'GH',
  state: 'Greater Accra',
  language: 'english',
  codec: 'MP3',
  bitrate: 128,
  hls: 0,
  lastcheckok: 1,
  geo_lat: 5.56,
  geo_long: -0.2,
  ...overrides,
});

describe('normalizeStation', () => {
  it('keeps a healthy HTTPS MP3 station and cleans its text', () => {
    const station = normalizeStation(row());
    expect(station).toMatchObject({
      id: '96062a7b-0601-11e8-ae97-52543be04c81',
      name: 'Joy FM',
      streamUrl: 'https://stream.joyonline.example/live.mp3',
      countryCode: 'GH',
      codec: 'MP3',
      bitrate: 128,
      latitude: 5.56,
      longitude: -0.2,
    });
    // "news_talk" becomes "news talk"; duplicates are dropped.
    expect(station?.tags).toEqual(['news', 'talk', 'news talk', 'traffic']);
  });

  it.each([
    ['plain HTTP', { url_resolved: 'http://stream.example/live.mp3' }],
    ['a private address', { url_resolved: 'https://192.168.1.10/live.mp3' }],
    ['localhost', { url_resolved: 'https://localhost/live.mp3' }],
    ['an HLS flag', { hls: 1 }],
    ['an HLS playlist URL', { url_resolved: 'https://cdn.example/live.m3u8' }],
    ['an unplayable codec', { codec: 'OGG' }],
    ['a failed health check', { lastcheckok: 0 }],
    ['no position', { geo_lat: null, geo_long: null }],
    ['the 0,0 filler position', { geo_lat: 0, geo_long: 0 }],
    ['a malformed id', { stationuuid: 'not-a-uuid' }],
  ])('rejects a station with %s', (_label, overrides) => {
    expect(normalizeStation(row(overrides))).toBeNull();
  });

  it('accepts AAC variants', () => {
    expect(normalizeStation(row({ codec: 'aac+' }))?.codec).toBe('AAC+');
    expect(normalizeStation(row({ codec: 'HE-AAC' }))).not.toBeNull();
  });

  it('drops an unsafe homepage without dropping the station', () => {
    expect(normalizeStation(row({ homepage: 'javascript:alert(1)' }))?.homepage).toBeNull();
  });

  it('ignores non-object rows', () => {
    expect(normalizeStations([null, 'x', row()])).toHaveLength(1);
    expect(normalizeStations({ not: 'a list' })).toEqual([]);
  });
});

describe('publicHttpsUrl', () => {
  it('refuses credentials and CGNAT space', () => {
    expect(publicHttpsUrl('https://user:pw@radio.example/')).toBeNull();
    expect(publicHttpsUrl('https://100.64.0.1/')).toBeNull();
    expect(publicHttpsUrl('https://radio.example/a#frag')).toBe('https://radio.example/a');
  });
});

describe('mirrors', () => {
  it('accepts only real radio-browser mirror hostnames', () => {
    expect(mirrorOrigin('de1.api.radio-browser.info')).toBe('https://de1.api.radio-browser.info');
    expect(mirrorOrigin('evil.example')).toBeNull();
    expect(mirrorOrigin('de1.api.radio-browser.info.evil.example')).toBeNull();
    expect(mirrorOrigin('all.api.radio-browser.info')).toBeNull();
  });

  it('parses and de-duplicates the server list', () => {
    const rows = [{ name: 'de1.api.radio-browser.info' }, { name: 'DE1.api.radio-browser.info.' }, { name: 'x.test' }];
    expect(parseMirrorList(rows)).toEqual(['https://de1.api.radio-browser.info']);
  });
});

describe('selectNearbyStations', () => {
  const near = normalizeStation(row())!;
  const far = normalizeStation(
    row({ stationuuid: '11111111-2222-3333-4444-555555555555', name: 'Kumasi Music', tags: 'music', geo_lat: 6.69, geo_long: -1.62 }),
  )!;

  it('sorts by distance and applies the radius', () => {
    const all = selectNearbyStations([far, near], { origin: ACCRA, radiusKm: 1000, limit: 10 });
    expect(all.map((s) => s.name)).toEqual(['Joy FM', 'Kumasi Music']);
    expect(all[0].distanceKm).toBeLessThan(10);
    expect(all[1].distanceKm).toBeGreaterThan(190);

    expect(selectNearbyStations([far, near], { origin: ACCRA, radiusKm: 50, limit: 10 })).toHaveLength(1);
  });

  it('filters tags case-insensitively by substring', () => {
    const traffic = selectNearbyStations([far, near], { origin: ACCRA, radiusKm: 1000, tag: 'TRAF', limit: 10 });
    expect(traffic.map((s) => s.name)).toEqual(['Joy FM']);
  });

  it('applies the limit after sorting', () => {
    expect(selectNearbyStations([far, near], { origin: ACCRA, radiusKm: 1000, limit: 1 })[0].name).toBe('Joy FM');
  });
});

describe('query shaping', () => {
  it('asks Radio Browser for a radius in metres', () => {
    const path = buildSearchPath({ latitude: 5.5, longitude: -0.25, radiusKm: 170, limit: 500 });
    expect(path).toContain('geo_distance=170000');
    expect(path).toContain('is_https=true');
    expect(path).toContain('has_geo_info=true');
  });

  it('snaps positions to 0.25° cells and radii to buckets', () => {
    expect(cellFor(5.6037, -0.187)).toEqual({ latitude: 5.5, longitude: -0.25 });
    expect(radiusBucket(120)).toBe(150);
    expect(radiusBucket(1000)).toBe(1000);
  });
});

describe('RadioService', () => {
  afterEach(() => jest.restoreAllMocks());

  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

  it('falls back to the next mirror and only relays clicks for stations it listed', async () => {
    const calls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/json/servers')) {
        return json([{ name: 'aa1.api.radio-browser.info' }, { name: 'bb1.api.radio-browser.info' }]);
      }
      if (url.startsWith('https://aa1.')) return new Response('down', { status: 503 });
      if (url.includes('/json/stations/search')) return json([row()]);
      return json({ ok: true });
    });

    const service = new RadioService();
    const result = await service.findStations({ ...ACCRA, radiusKm: 150, limit: 40 });
    expect(result.status).toBe('OK');
    expect(result.stations).toHaveLength(1);
    expect(calls.some((url) => url.startsWith('https://bb1.api.radio-browser.info/json/stations/search'))).toBe(true);

    await expect(service.registerClick('00000000-0000-0000-0000-000000000000')).resolves.toEqual({ ok: false });
    await expect(service.registerClick('not-a-uuid')).resolves.toEqual({ ok: false });
    await expect(service.registerClick(result.stations[0].id)).resolves.toEqual({ ok: true });
    expect(calls.some((url) => url.endsWith(`/json/url/${result.stations[0].id}`))).toBe(true);
  });

  it('reports UNAVAILABLE rather than throwing when every mirror fails', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('down', { status: 503 }));
    const result = await new RadioService().findStations({ ...ACCRA, radiusKm: 150, limit: 40 });
    expect(result).toMatchObject({ status: 'UNAVAILABLE', fetchedAt: null, stations: [] });
  });
});
