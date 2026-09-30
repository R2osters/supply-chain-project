import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { intersects, parseBbox } from './bbox';
import { rennesLevel } from './levels';
import { RennesFlowProvider } from './rennes-flow.provider';

const fixture = (name: string): string => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
const json = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

describe('Rennes levels', () => {
  it('uses the measured speed over the limit, capped at 1', () => {
    expect(rennesLevel(35, 70, 'heavy', 3)).toBeCloseTo(0.5);
    expect(rennesLevel(90, 70, 'freeFlow', 3)).toBe(1);
  });

  it('falls back to the status when a speed is unusable', () => {
    expect(rennesLevel(null, 70, 'freeFlow', 3)).toBe(0.9);
    expect(rennesLevel(40, null, 'heavy', 3)).toBe(0.6);
    expect(rennesLevel(40, 0, 'congested', 3)).toBe(0.3);
  });

  it('treats a line without probes as unmeasured, whatever its speed says', () => {
    // Rennes fills speed and limit on 'unknown' lines (80/80) although no vehicle was measured:
    // read as a ratio, they would show as free-flowing measured roads.
    expect(rennesLevel(80, 80, 'unknown', 0)).toBeNull();
    expect(rennesLevel(80, 80, 'freeFlow', 0)).toBeNull();
    expect(rennesLevel(null, null, 'unknown', 2)).toBeNull();
  });
});

describe('bbox', () => {
  it('parses a sane box and refuses the rest', () => {
    expect(parseBbox('-1.8,48.0,-1.5,48.2')).toEqual({ minLon: -1.8, minLat: 48, maxLon: -1.5, maxLat: 48.2 });
    for (const bad of [undefined, '', '1,2,3', 'a,b,c,d', '-1.5,48,-1.8,48.2', '0,0,10,10', '0,89,1,91', ['1', '2']]) {
      expect(parseBbox(bad)).toBeNull();
    }
  });

  it('keeps a line crossing the box even with no vertex inside', () => {
    const box = { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 };
    expect(intersects([[0.5, 0.5], [3, 3]], box)).toBe(true);
    expect(intersects([[-1, 0.5], [2, 0.5]], box)).toBe(true);
    expect(intersects([[2, 2], [3, 3]], box)).toBe(false);
    expect(intersects([[-1, 2], [2, 1.5]], box)).toBe(false);
  });
});

describe('RennesFlowProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  it('turns the export into directional segments', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(json(fixture('rennes-export.json')));
    const { segments, stale } = await new RennesFlowProvider().snapshot();
    const byId = new Map(segments.map((segment) => [segment.id, segment]));

    expect(stale).toBe(false);
    expect(segments).toHaveLength(6);
    expect(byId.get('rennes:11652')).toMatchObject({ level: expect.closeTo(0.611, 3), speedKmh: 55, limitKmh: 90 });
    expect(byId.get('rennes:1601810')?.level).toBeCloseTo(0.28);
    expect(byId.get('rennes:11579_G')?.level).toBeNull();
    expect(byId.get('rennes:11654')?.level).toBe(1);
    expect(byId.get('rennes:10273_D')?.level).toBe(0.9);
    for (const segment of segments) {
      expect(segment).toMatchObject({ source: 'rennes', closed: false, bothDirections: false });
      expect(segment.coordinates.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('skips features that are not usable lines', async () => {
    const body = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-1.6, 48.1] }, properties: { predefinedlocationreference: 'p' } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-1.6, 48.1]] }, properties: { predefinedlocationreference: 'one' } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-1.6, 48.1], ['x', 48]] }, properties: { predefinedlocationreference: 'nan' } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-1.6, 48.1], [-1.5, 48.1]] }, properties: {} },
      ],
    });
    jest.spyOn(global, 'fetch').mockResolvedValue(json(body));
    expect((await new RennesFlowProvider().snapshot()).segments).toEqual([]);
  });

  it('fetches once for concurrent callers and keeps the last export when Rennes fails', async () => {
    let now = 0;
    const spy = jest.spyOn(global, 'fetch').mockImplementation(async () => json(fixture('rennes-export.json')));
    const provider = new RennesFlowProvider(() => now);
    await Promise.all([provider.snapshot(), provider.snapshot()]);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRejectedValue(new Error('down'));
    now = 200_000; // past the 3-minute freshness, inside the 10-minute grace
    const stale = await provider.snapshot();
    expect(stale.stale).toBe(true);
    expect(stale.segments).toHaveLength(6);

    now = 1_000_000; // past the grace: no data is better than old data presented as live
    await expect(provider.snapshot()).rejects.toThrow();
  });
});
