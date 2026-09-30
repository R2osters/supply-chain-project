import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { intersects, parseBbox } from './bbox';
import { GrenobleFlowProvider } from './grenoble-flow.provider';
import { grenobleLevel, rennesLevel } from './levels';
import { MAX_OPEN_FLOW_FEATURES, OpenFlowService } from './open-flow.service';
import { RennesFlowProvider } from './rennes-flow.provider';
import type { FlowSegment, OpenFlowProvider } from './types';

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

describe('Grenoble levels', () => {
  it('maps Métromobilité service levels', () => {
    expect(grenobleLevel(1)).toEqual({ level: 0.9, closed: false });
    expect(grenobleLevel(2)).toEqual({ level: 0.6, closed: false });
    expect(grenobleLevel(3)).toEqual({ level: 0.3, closed: false });
    expect(grenobleLevel(4)).toEqual({ level: 0, closed: true });
    expect(grenobleLevel(0)).toEqual({ level: null, closed: false });
    expect(grenobleLevel('3')).toEqual({ level: null, closed: false });
    expect(grenobleLevel(undefined)).toEqual({ level: null, closed: false });
  });
});

describe('GrenobleFlowProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  const serve = (lines: string, levels: string) =>
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => json(String(url).includes('/lines/') ? lines : levels));

  it('joins the public lines with their live level', async () => {
    serve(fixture('grenoble-lines.json'), fixture('grenoble-dyn.json'));
    const { segments } = await new GrenobleFlowProvider().snapshot();
    const byId = new Map(segments.map((segment) => [segment.id, segment]));

    // N1_501 is not public (visible_internet = 0); N1_ABSENT_FROM_LINES has no geometry.
    expect([...byId.keys()].sort()).toEqual([
      'grenoble:N1_ARTE041101',
      'grenoble:N1_ARTE041102',
      'grenoble:N1_ARTE041103',
      'grenoble:N1_ARTE041104',
      'grenoble:N1_CLE_02',
    ]);
    expect(byId.get('grenoble:N1_ARTE041101')).toMatchObject({ level: 0.9, closed: false });
    expect(byId.get('grenoble:N1_CLE_02')).toMatchObject({ level: 0.6, closed: false });
    expect(byId.get('grenoble:N1_ARTE041102')).toMatchObject({ level: 0.3, closed: false });
    expect(byId.get('grenoble:N1_ARTE041103')).toMatchObject({ level: 0, closed: true });
    expect(byId.get('grenoble:N1_ARTE041104')).toMatchObject({ level: null, closed: false });
    for (const segment of segments) {
      expect(segment).toMatchObject({ source: 'grenoble', bothDirections: true, speedKmh: null, limitKmh: null });
    }
  });

  it('tolerates an empty level list', async () => {
    serve(fixture('grenoble-lines.json'), JSON.stringify({ N1_ARTE041101: [] }));
    const { segments } = await new GrenobleFlowProvider().snapshot();
    expect(segments).toEqual([expect.objectContaining({ id: 'grenoble:N1_ARTE041101', level: null, closed: false })]);
  });

  it('fetches the lines once a day and the levels every minute', async () => {
    let now = 0;
    const spy = serve(fixture('grenoble-lines.json'), fixture('grenoble-dyn.json'));
    const provider = new GrenobleFlowProvider(() => now);
    await provider.snapshot();
    now = 61_000;
    await provider.snapshot();
    const urls = spy.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.includes('/lines/'))).toHaveLength(1);
    expect(urls.filter((url) => url.includes('/dyn/'))).toHaveLength(2);
  });

  it('reports stale data when the levels fail after a good answer', async () => {
    let now = 0;
    const spy = serve(fixture('grenoble-lines.json'), fixture('grenoble-dyn.json'));
    const provider = new GrenobleFlowProvider(() => now);
    await provider.snapshot();
    spy.mockRejectedValue(new Error('down'));
    now = 120_000;
    const snapshot = await provider.snapshot();
    expect(snapshot.stale).toBe(true);
    expect(snapshot.segments).toHaveLength(5);
  });
});

describe('OpenFlowService', () => {
  const RENNES_BOX = { minLon: -1.8, minLat: 48, maxLon: -1.5, maxLat: 48.2 };
  const segment = (id: string, coordinates: [number, number][]): FlowSegment => ({
    id,
    source: 'rennes',
    coordinates,
    level: 0.5,
    closed: false,
    speedKmh: 35,
    limitKmh: 70,
    bothDirections: false,
  });
  const provider = (id: 'rennes' | 'grenoble', snapshot: OpenFlowProvider['snapshot'], coverage = RENNES_BOX): OpenFlowProvider => ({
    id,
    attribution: id.toUpperCase(),
    coverage,
    snapshot,
  });

  it('merges providers, keeps what touches the box and survives a failing source', async () => {
    const ok = provider('rennes', async () => ({
      fetchedAt: new Date('2026-09-30T12:00:00Z'),
      stale: false,
      segments: [segment('rennes:a', [[-1.65, 48.1], [-1.64, 48.1]]), segment('rennes:far', [[-1.9, 48.25], [-1.85, 48.25]])],
    }));
    const broken = provider('grenoble', async () => {
      throw new Error('down');
    });
    const service = new OpenFlowService([ok, broken]);

    const collection = await service.inBbox(RENNES_BOX);
    expect(collection.type).toBe('FeatureCollection');
    expect(collection.features).toEqual([
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[-1.65, 48.1], [-1.64, 48.1]] },
        properties: { id: 'rennes:a', source: 'rennes', level: 0.5, closed: false, speedKmh: 35, limitKmh: 70, bothDirections: false },
      },
    ]);
    expect(service.sources()).toEqual([
      { id: 'rennes', active: true, stale: false, updatedAt: '2026-09-30T12:00:00.000Z', attribution: 'RENNES' },
      { id: 'grenoble', active: false, stale: false, updatedAt: null, attribution: 'GRENOBLE' },
    ]);
  });

  it('never asks a source whose area is out of view', async () => {
    const snapshot = jest.fn();
    const service = new OpenFlowService([provider('grenoble', snapshot, { minLon: 5.5, minLat: 45, maxLon: 6, maxLat: 45.35 })]);
    expect((await service.inBbox({ minLon: -0.4, minLat: 5.4, maxLon: 0.1, maxLat: 5.8 })).features).toEqual([]);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('caps the answer', async () => {
    const many = Array.from({ length: MAX_OPEN_FLOW_FEATURES + 50 }, (_, i) =>
      segment(`rennes:${i}`, [[-1.65, 48.1], [-1.64, 48.1]]),
    );
    const service = new OpenFlowService([
      provider('rennes', async () => ({ fetchedAt: new Date(), stale: false, segments: many })),
    ]);
    expect((await service.inBbox(RENNES_BOX)).features).toHaveLength(MAX_OPEN_FLOW_FEATURES);
  });

  it('keeps the last outcome of a source that goes stale', async () => {
    const service = new OpenFlowService([
      provider('rennes', async () => ({ fetchedAt: new Date('2026-09-30T11:55:00Z'), stale: true, segments: [] })),
    ]);
    await service.inBbox(RENNES_BOX);
    expect(service.sources()[0]).toMatchObject({ active: true, stale: true, updatedAt: '2026-09-30T11:55:00.000Z' });
  });
});
