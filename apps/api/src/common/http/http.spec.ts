import { GateFullError, RequestGate } from './request-gate';
import { TtlCache } from './ttl-cache';
import { UpstreamError, readBodyCapped } from './fetch-capped';
import { haversineKm, isValidLatLon } from './geo';

describe('TtlCache', () => {
  it('shares one load between concurrent misses', async () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    let calls = 0;
    const load = async () => {
      calls += 1;
      return 42;
    };
    const [a, b] = await Promise.all([cache.getOrLoad('k', load), cache.getOrLoad('k', load)]);
    expect(calls).toBe(1);
    expect(a.value).toBe(42);
    expect(b.value).toBe(42);
  });

  it('serves the last good value, marked stale, when a refresh fails inside the stale window', async () => {
    let clock = 0;
    const cache = new TtlCache<string>({ ttlMs: 100, staleMs: 1000, now: () => clock });
    await cache.getOrLoad('k', async () => 'fresh');
    clock = 500;
    const result = await cache.getOrLoad('k', async () => {
      throw new Error('down');
    });
    expect(result).toMatchObject({ value: 'fresh', stale: true });
  });

  it('rethrows once the stale window has passed', async () => {
    let clock = 0;
    const cache = new TtlCache<string>({ ttlMs: 100, staleMs: 100, now: () => clock });
    await cache.getOrLoad('k', async () => 'fresh');
    clock = 5000;
    await expect(
      cache.getOrLoad('k', async () => {
        throw new Error('down');
      }),
    ).rejects.toThrow('down');
  });

  it('evicts the least recently stored key beyond maxEntries', async () => {
    const cache = new TtlCache<number>({ ttlMs: 1000, maxEntries: 2 });
    await cache.getOrLoad('a', async () => 1);
    await cache.getOrLoad('b', async () => 2);
    await cache.getOrLoad('c', async () => 3);
    expect(cache.peek('a')).toBeUndefined();
    expect(cache.size).toBe(2);
  });
});

describe('RequestGate', () => {
  it('spaces task starts by the minimum interval', async () => {
    let clock = 0;
    const starts: number[] = [];
    const gate = new RequestGate({
      minIntervalMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    await Promise.all([1, 2, 3].map(() => gate.run(async () => starts.push(clock))));
    expect(starts).toEqual([0, 1000, 2000]);
  });

  it('refuses callers beyond the queue bound instead of holding them', async () => {
    const gate = new RequestGate({ minIntervalMs: 0, maxQueue: 1 });
    let release!: () => void;
    const first = gate.run(() => new Promise<void>((resolve) => (release = resolve)));
    await expect(gate.run(async () => undefined)).rejects.toBeInstanceOf(GateFullError);
    await Promise.resolve();
    release();
    await first;
  });

  it('keeps going after a task fails', async () => {
    const gate = new RequestGate({ minIntervalMs: 0 });
    await expect(gate.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('readBodyCapped', () => {
  it('refuses a declared length over the cap without reading', async () => {
    const response = new Response('x'.repeat(10), { headers: { 'content-length': '10' } });
    await expect(readBodyCapped(response, 5, 'example.test')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('cancels a streamed body once it crosses the cap', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4));
      },
    });
    await expect(readBodyCapped(new Response(stream), 10, 'example.test')).rejects.toThrow(
      'exceeds 10 bytes',
    );
  });

  it('returns a body under the cap intact', async () => {
    const bytes = await readBodyCapped(new Response('hello'), 100, 'example.test');
    expect(bytes.toString('utf8')).toBe('hello');
  });
});

describe('geo', () => {
  it('measures Accra to Kumasi at about 200 km', () => {
    const km = haversineKm({ latitude: 5.6037, longitude: -0.187 }, { latitude: 6.6885, longitude: -1.6244 });
    expect(km).toBeGreaterThan(195);
    expect(km).toBeLessThan(205);
  });

  it('rejects AIS-style unavailable coordinates', () => {
    expect(isValidLatLon(91, 181)).toBe(false);
    expect(isValidLatLon(5.6, -0.2)).toBe(true);
  });
});
