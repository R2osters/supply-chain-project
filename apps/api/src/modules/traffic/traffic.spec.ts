import { BadGatewayException, BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { DailyTileBudget, isValidTile, parseTileSegment, rollBudget, tryConsume, utcDayKey } from './tile-budget';
import { TrafficService } from './traffic.service';

const KEY = 'tt-secret-key-123';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (): Response => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });

describe('tile coordinates', () => {
  it('accepts tiles inside the 2^z grid', () => {
    expect(isValidTile(0, 0, 0)).toBe(true);
    expect(isValidTile(12, 4095, 4095)).toBe(true);
    expect(isValidTile(22, 2 ** 22 - 1, 0)).toBe(true);
  });

  it('rejects out-of-range zooms and positions', () => {
    expect(isValidTile(23, 0, 0)).toBe(false);
    expect(isValidTile(-1, 0, 0)).toBe(false);
    expect(isValidTile(3, 8, 0)).toBe(false);
    expect(isValidTile(3, 0, -1)).toBe(false);
    expect(isValidTile(3, 1.5, 0)).toBe(false);
  });

  it('parses path segments strictly', () => {
    expect(parseTileSegment('12')).toBe(12);
    expect(parseTileSegment('1e1')).toBeNull();
    expect(parseTileSegment('0x0c')).toBeNull();
    expect(parseTileSegment('12.0')).toBeNull();
    expect(parseTileSegment('')).toBeNull();
  });
});

describe('daily budget', () => {
  it('keys the day in UTC', () => {
    expect(utcDayKey(new Date('2026-09-28T23:59:59-05:00'))).toBe('2026-09-29');
  });

  it('resets the counter on a new day', () => {
    expect(rollBudget({ day: '2026-09-27', used: 99 }, '2026-09-28')).toEqual({ day: '2026-09-28', used: 0 });
    expect(rollBudget({ day: '2026-09-28', used: 5 }, '2026-09-28')).toEqual({ day: '2026-09-28', used: 5 });
    expect(rollBudget(null, '2026-09-28')).toEqual({ day: '2026-09-28', used: 0 });
  });

  it('allows requests up to the limit and refuses the next', () => {
    let state = { day: 'd', used: 0 };
    for (let i = 0; i < 3; i += 1) {
      const result = tryConsume(state, 3);
      expect(result.allowed).toBe(true);
      state = result.state;
    }
    expect(tryConsume(state, 3)).toEqual({ state: { day: 'd', used: 3 }, allowed: false });
  });

  it('refills at midnight UTC', () => {
    let clock = new Date('2026-09-28T23:59:00Z');
    const budget = new DailyTileBudget(1, () => clock);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(false);
    expect(budget.exhausted()).toBe(true);
    clock = new Date('2026-09-29T00:00:01Z');
    expect(budget.usedToday()).toBe(0);
    expect(budget.consume()).toBe(true);
  });
});

describe('TrafficService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is disabled without a key: status says so and tiles are 404', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const service = new TrafficService(undefined, { apiKey: null, dailyBudget: 100 });
    expect(service.status()).toMatchObject({ enabled: false, provider: null, tilesUsedToday: 0, attribution: null });
    await expect(service.getTile(1, 0, 0)).rejects.toBeInstanceOf(NotFoundException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches from TomTom once, then serves the cached tile without spending budget', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => png());
    const service = new TrafficService(undefined, { apiKey: KEY, dailyBudget: 100 });

    expect((await service.getTile(12, 2047, 2040)).equals(PNG)).toBe(true);
    await service.getTile(12, 2047, 2040);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(
      /^https:\/\/api\.tomtom\.com\/traffic\/map\/4\/tile\/flow\/relative0\/12\/2047\/2040\.png\?key=tt-secret-key-123&tileSize=256$/,
    );
    expect(service.status()).toMatchObject({ enabled: true, provider: 'TomTom', tilesUsedToday: 1, dailyBudget: 100 });
  });

  it('answers 429 once the budget is spent and a tile is not cached', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => png());
    const service = new TrafficService(undefined, { apiKey: KEY, dailyBudget: 1 });
    await service.getTile(5, 1, 1);
    const error = await service.getTile(5, 2, 2).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect(service.status().note).toContain('budget');
  });

  it('rejects invalid coordinates before touching the network', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const service = new TrafficService(undefined, { apiKey: KEY, dailyBudget: 10 });
    await expect(service.getTile(3, 9, 0)).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never puts the key in errors or logs when TomTom fails', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('Developer Inactive', { status: 403 }));
    const logs: string[] = [];
    const service = new TrafficService(undefined, { apiKey: KEY, dailyBudget: 10 });
    jest.spyOn((service as any).logger, 'warn').mockImplementation((message: unknown) => {
      logs.push(String(message));
    });

    const error = await service.getTile(4, 3, 3).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadGatewayException);
    expect(JSON.stringify((error as HttpException).getResponse())).not.toContain(KEY);
    expect(logs.join('\n')).toContain('403');
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('refuses a 200 that is not a PNG instead of caching it', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response('{"error":"x"}', { headers: { 'content-type': 'application/json' } }));
    const service = new TrafficService(undefined, { apiKey: KEY, dailyBudget: 10 });
    await expect(service.getTile(4, 3, 3)).rejects.toBeInstanceOf(BadGatewayException);
    await expect(service.getTile(4, 3, 3)).rejects.toBeInstanceOf(BadGatewayException);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
