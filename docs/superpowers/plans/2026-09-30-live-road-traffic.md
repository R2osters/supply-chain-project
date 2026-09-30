# Live Road Traffic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simulated vehicles on real roads everywhere on the live map, coloured and slowed by measured speeds (Rennes, Grenoble keyless; TomTom with the user's key), with the fleet drawn above and clearly distinct.

**Architecture:** The API proxies TomTom vector flow tiles (budgeted, key server-side) and serves keyless measured segments (`/traffic/open-flow`). The browser reads road geometry from OpenFreeMap vector tiles, matches measurements onto roads, runs a pure-TypeScript simulation and draws the dots in a MapLibre WebGL custom layer below aircraft, vessels and the fleet's HTML markers.

**Tech Stack:** NestJS 11 + jest (API), Next.js 15 static export + MapLibre GL 5.24 + vitest (web), Tauri 2 desktop build for the end-to-end check.

**Spec:** `docs/superpowers/specs/2026-09-30-live-road-traffic-design.md`

## Global Constraints

- Level = current speed / free-flow speed, 0–1; colour thresholds: `>= 0.85` free (green), `>= 0.55` slow (orange), else jam (red); unmeasured roads are neutral (`muted`), never a jam.
- Dots from zoom 12; measured lines from zoom 10; at most 6 000 dots.
- TomTom key never appears in a response, log or error; budget `0` means unlimited.
- Permission `gps:read` for every traffic route; tile routes throttled at 1 200 / min.
- No new dependency. Coordinates are `[lon, lat]`. Code comments and commits in English; UI strings in FR + EN (`apps/web/src/lib/i18n.tsx`).
- Do not restyle `apps/web` beyond the new layer, its toggle/status/legend and the settings field (design session owns the rest). Static export constraints stay.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests never touch the user's real SCIP (`%LOCALAPPDATA%\Programs\SCIP`, `%LOCALAPPDATA%\com.scip.desktop`); installer checks use `SCIP_SETUP_TEST=1`.

## Work split

Tasks 1–5 and 7–10: this session. Task 6 (web pure units) and the Grenoble verification in Task 4 Step 1: peer session "Aide agent codage", on a branch from `claude/desktop-exe-evolution-e612fc`, merged here by cherry-pick. The contracts of Task 6 are fixed below; Tasks 7–8 code against them.

---

### Task 1: TomTom budget, `0` = unlimited, editable at runtime

**Files:**
- Modify: `apps/api/src/modules/traffic/tile-budget.ts`
- Modify: `apps/api/src/modules/traffic/traffic.service.ts`, `traffic.module.ts`
- Modify: `apps/api/src/modules/settings/feed-settings.service.ts`, `settings.controller.ts`
- Test: `apps/api/src/modules/traffic/traffic.spec.ts`, `apps/api/src/modules/settings/feed-settings.service.spec.ts`

**Interfaces:**
- Produces: `DailyTileBudget(limit: number | (() => number), now?)`, `dailyLimit` getter (0 = unlimited); `FeedSettingsService.getTileBudget(): number | null`, `setTileBudget(value: number | null)`; `GET/PUT /settings/traffic` → `{ dailyTileBudget: number, from: 'settings' | 'default' }`; `TrafficService(config, settings, keySource, budgetSource?: () => number)`.

- [ ] **Step 1: Failing tests** — in `traffic.spec.ts` (`describe('daily budget')`):

```ts
it('treats 0 as unlimited', () => {
  const budget = new DailyTileBudget(0);
  for (let i = 0; i < 10_000; i += 1) expect(budget.consume()).toBe(true);
  expect(budget.exhausted()).toBe(false);
});

it('reads a changing limit on every use', () => {
  let limit = 1;
  const budget = new DailyTileBudget(() => limit);
  expect(budget.consume()).toBe(true);
  expect(budget.consume()).toBe(false);
  limit = 3;
  expect(budget.consume()).toBe(true);
  expect(budget.dailyLimit).toBe(3);
});
```

In `feed-settings.service.spec.ts`:

```ts
it('stores the TomTom tile budget next to the keys without losing either', () => {
  const service = make(); // existing helper building the service on a temp settings file
  service.update({ tomtomApiKey: 'abcd1234' });
  service.setTileBudget(0);
  expect(service.getTileBudget()).toBe(0);
  service.update({ aisStreamApiKey: 'x-1' });
  const reloaded = make(); // same file
  expect(reloaded.getTileBudget()).toBe(0);
  expect(reloaded.get('tomtomApiKey')).toBe('abcd1234');
  reloaded.setTileBudget(null);
  expect(reloaded.getTileBudget()).toBeNull();
});
```

- [ ] **Step 2:** `npx jest src/modules/traffic src/modules/settings` → FAIL.

- [ ] **Step 3: Implement.** `tile-budget.ts`:

```ts
/** `0` (or less) means no ceiling: the user's plan pays for what the free allowance does not. */
export function tryConsume(state: BudgetState, limit: number): { state: BudgetState; allowed: boolean } {
  if (limit > 0 && state.used >= limit) return { state, allowed: false };
  return { state: { day: state.day, used: state.used + 1 }, allowed: true };
}

export class DailyTileBudget {
  private state: BudgetState | null = null;
  private readonly limitSource: () => number;
  constructor(limit: number | (() => number), private readonly now: () => Date = () => new Date()) {
    this.limitSource = typeof limit === 'function' ? limit : () => limit;
  }
  get dailyLimit(): number { return this.limitSource(); }
  usedToday(): number { this.state = rollBudget(this.state, utcDayKey(this.now())); return this.state.used; }
  exhausted(): boolean { const limit = this.dailyLimit; return limit > 0 && this.usedToday() >= limit; }
  consume(): boolean {
    const result = tryConsume(rollBudget(this.state, utcDayKey(this.now())), this.dailyLimit);
    this.state = result.state;
    return result.allowed;
  }
}
```

`feed-settings.service.ts`: keep a `storedBudget: number | undefined` read from the same JSON (`tomtomDailyTileBudget`, integer >= 0); `save()` writes `{ ...values, ...(budget !== undefined ? { tomtomDailyTileBudget: budget } : {}) }` so saving keys keeps the budget and vice versa; `getTileBudget()` returns the stored value or `null`; `setTileBudget(value)` validates `Number.isInteger(value) && value >= 0 && value <= 10_000_000` (else throws `BadRequestException`), persists, logs `Traffic tile budget changed`.

`settings.controller.ts`: `UpdateTrafficSettingsDto { @IsOptional() @ValidateIf(v !== null) @IsInt() @Min(0) @Max(10_000_000) dailyTileBudget?: number | null }`; `GET settings/traffic` and `PUT settings/traffic` (`company:update`, `@Audit('settings.traffic.update', 'settings')`) returning `{ dailyTileBudget: effective, from }`, effective = `feeds.getTileBudget() ?? config intel.tomtomDailyTileBudget ?? 6000`.

`traffic.service.ts`: constructor gains `budgetSource?: () => number`; `this.budget = new DailyTileBudget(budgetSource ?? (settings?.dailyBudget ?? intel?.tomtomDailyTileBudget ?? 6000))`. `traffic.module.ts` passes `() => feeds.getTileBudget() ?? config.get('intel', { infer: true }).tomtomDailyTileBudget ?? 6000`. Status note when unlimited: `null`.

- [ ] **Step 4:** tests PASS; `npx tsc --noEmit -p tsconfig.json` clean.
- [ ] **Step 5: Commit** `feat(api): TomTom tile budget editable at runtime, 0 = unlimited`.

---

### Task 2: TomTom vector flow tile proxy

**Files:** Modify `traffic.service.ts`, `traffic.controller.ts`; Test `traffic.spec.ts`.

**Interfaces:** Produces `TrafficService.getFlowTile(z, x, y): Promise<Buffer>`; route `GET /traffic/flow-tiles/:z/:x/:y` (`.pbf` suffix accepted), content type `application/vnd.mapbox-vector-tile`.

- [ ] **Step 1: Failing tests:**

```ts
const MVT = Buffer.from([0x1a, 0x02, 0x08, 0x02]);
const mvt = (type = 'application/vnd.mapbox-vector-tile'): Response =>
  new Response(MVT, { status: 200, headers: { 'content-type': type } });

it('proxies vector flow tiles with the key only upstream', async () => {
  const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(mvt());
  const service = new TrafficService(undefined, { apiKey: KEY, dailyBudget: 10 });
  await expect(service.getFlowTile(12, 2048, 1361)).resolves.toEqual(MVT);
  const url = String(fetchSpy.mock.calls[0][0]);
  expect(url).toContain('/traffic/map/4/tile/flow/relative/12/2048/1361.pbf');
  expect(url).toContain(`key=${KEY}`);
});

it('caches flow tiles apart from raster tiles and counts only upstream attempts', async () => {
  jest.spyOn(global, 'fetch').mockImplementation(async () => mvt());
  const service = new TrafficService(undefined, { apiKey: KEY, dailyBudget: 10 });
  await service.getFlowTile(12, 1, 1);
  await service.getFlowTile(12, 1, 1);
  expect(service.status().tilesUsedToday).toBe(1);
});

it('refuses a flow body that is not a vector tile', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  const service = new TrafficService(undefined, { apiKey: KEY, dailyBudget: 10 });
  await expect(service.getFlowTile(12, 1, 1)).rejects.toBeInstanceOf(BadGatewayException);
});

it('is 404 without a key and 429 once the budget is spent', async () => {
  await expect(new TrafficService(undefined, { apiKey: null, dailyBudget: 10 }).getFlowTile(1, 0, 0)).rejects.toBeInstanceOf(NotFoundException);
  jest.spyOn(global, 'fetch').mockImplementation(async () => mvt());
  const service = new TrafficService(undefined, { apiKey: KEY, dailyBudget: 1 });
  await service.getFlowTile(3, 0, 0);
  await expect(service.getFlowTile(3, 1, 0)).rejects.toMatchObject({ status: 429 });
});
```

- [ ] **Step 2:** FAIL. **Step 3: Implement** — generalise `getTile` into a private `serveTile(kind: 'raster' | 'flow', z, x, y)`: cache key `${kind}/${z}/${x}/${y}`; flow URL `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.pbf?key=…`; accepted types for flow: `application/vnd.mapbox-vector-tile`, `application/x-protobuf`, `application/octet-stream`. Controller:

```ts
@Get('flow-tiles/:z/:x/:y')
@RequirePermissions('gps:read')
@Throttle({ default: { limit: 1200, ttl: 60_000 } })
@Header('Cache-Control', 'private, max-age=120')
@ApiProduces('application/vnd.mapbox-vector-tile')
@ApiOperation({ summary: 'TomTom traffic-flow vector tile (relative speeds)', description: '404 without a key, 429 once the daily budget is spent, 502 when TomTom fails.' })
async flowTile(@Param('z') z: string, @Param('x') x: string, @Param('y') y: string): Promise<StreamableFile> {
  const [zoom, column, row] = [z, x, y.replace(/\.pbf$/i, '')].map(parseTileSegment);
  if (zoom === null || column === null || row === null) throw new BadRequestException('Invalid tile coordinates');
  const tile = await this.traffic.getFlowTile(zoom, column, row);
  return new StreamableFile(tile, { type: 'application/vnd.mapbox-vector-tile', length: tile.length });
}
```

- [ ] **Step 4:** PASS (existing raster tests unchanged). **Step 5: Commit** `feat(api): proxy TomTom vector flow tiles under the same budget`.

---

### Task 3: Measured segments — common model and Rennes

**Files:**
- Create: `apps/api/src/modules/traffic/open-flow/types.ts`, `levels.ts`, `bbox.ts`, `rennes-flow.provider.ts`
- Test: `apps/api/src/modules/traffic/open-flow/open-flow.spec.ts`

**Interfaces:**

```ts
// types.ts
export type OpenFlowSourceId = 'rennes' | 'grenoble';
export interface FlowSegment {
  id: string;                              // `${source}:${upstreamId}`
  source: OpenFlowSourceId;
  coordinates: [number, number][];         // [lon, lat], >= 2 points
  level: number | null;                    // speed / free-flow, 0..1; null = no measure
  closed: boolean;
  speedKmh: number | null;
  limitKmh: number | null;
}
export interface ProviderSnapshot { segments: FlowSegment[]; fetchedAt: Date; stale: boolean }
export interface OpenFlowProvider { readonly id: OpenFlowSourceId; readonly attribution: string; snapshot(): Promise<ProviderSnapshot> }
// levels.ts
export function rennesLevel(speed: unknown, limit: unknown, status: unknown): number | null;
export function grenobleLevel(code: unknown): { level: number | null; closed: boolean };
// bbox.ts
export interface Bbox { minLon: number; minLat: number; maxLon: number; maxLat: number }
export function parseBbox(raw: unknown): Bbox | null;            // "minLon,minLat,maxLon,maxLat", span <= 5°
export function intersects(coordinates: [number, number][], box: Bbox): boolean;
```

- [ ] **Step 1: Failing tests:**

```ts
describe('levels', () => {
  it('uses measured speed over the limit, capped at 1', () => {
    expect(rennesLevel(35, 70, 'heavy')).toBeCloseTo(0.5);
    expect(rennesLevel(90, 70, 'freeFlow')).toBe(1);
  });
  it('falls back to the status when a speed is unusable', () => {
    expect(rennesLevel(null, 70, 'freeFlow')).toBe(0.9);
    expect(rennesLevel(40, null, 'heavy')).toBe(0.6);
    expect(rennesLevel(40, 0, 'congested')).toBe(0.3);
    expect(rennesLevel(null, null, 'unknown')).toBeNull();
  });
});

describe('bbox', () => {
  it('parses a sane box and refuses the rest', () => {
    expect(parseBbox('-1.8,48.0,-1.5,48.2')).toEqual({ minLon: -1.8, minLat: 48, maxLon: -1.5, maxLat: 48.2 });
    for (const bad of [undefined, '', '1,2,3', 'a,b,c,d', '-1.5,48,-1.8,48.2', '0,0,10,10', '0,89,1,91']) expect(parseBbox(bad)).toBeNull();
  });
  it('keeps a line crossing the box even with no vertex inside', () => {
    const box = { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 };
    expect(intersects([[-1, 0.5], [2, 0.5]], box)).toBe(true);
    expect(intersects([[2, 2], [3, 3]], box)).toBe(false);
  });
});

describe('Rennes provider', () => {
  afterEach(() => jest.restoreAllMocks());
  const exportBody = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-1.65, 48.04], [-1.64, 48.04]] },
        properties: { predefinedlocationreference: '10273_D', averagevehiclespeed: 35, vitesse_maxi: 70, trafficstatus: 'heavy' } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-1.66, 48.05], [-1.65, 48.05]] },
        properties: { predefinedlocationreference: '10274_G', averagevehiclespeed: null, vitesse_maxi: null, trafficstatus: 'unknown' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-1.6, 48.1] }, properties: { predefinedlocationreference: 'x' } },
    ],
  };
  it('turns the export into segments and skips non-lines', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(exportBody), { status: 200, headers: { 'content-type': 'application/json' } }));
    const snapshot = await new RennesFlowProvider().snapshot();
    expect(snapshot.segments).toHaveLength(2);
    expect(snapshot.segments[0]).toMatchObject({ id: 'rennes:10273_D', level: 0.5, speedKmh: 35, limitKmh: 70, closed: false });
    expect(snapshot.segments[1].level).toBeNull();
  });
  it('keeps the last good export when Rennes fails, and fetches once for concurrent callers', async () => {
    let now = 0;
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(exportBody), { status: 200 }));
    const provider = new RennesFlowProvider(() => now);
    await Promise.all([provider.snapshot(), provider.snapshot()]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRejectedValue(new Error('down'));
    now = 200_000;
    const stale = await provider.snapshot();
    expect(stale.stale).toBe(true);
    expect(stale.segments).toHaveLength(2);
  });
});
```

- [ ] **Step 2:** FAIL. **Step 3: Implement.** `levels.ts`:

```ts
const RENNES_STATUS: Record<string, number> = { freeFlow: 0.9, heavy: 0.6, congested: 0.3 };
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

export function rennesLevel(speed: unknown, limit: unknown, status: unknown): number | null {
  if (positive(speed) && positive(limit)) return Math.min(1, speed / limit);
  return typeof status === 'string' && status in RENNES_STATUS ? RENNES_STATUS[status] : null;
}
```

`bbox.ts`: split on `,`, 4 finite numbers, `-180 <= lon <= 180`, `-90 <= lat <= 90`, `min < max`, spans `<= 5`; `intersects` = any vertex inside, or any segment's bounding box overlapping the box and crossing it (Liang–Barsky clip). `rennes-flow.provider.ts`:

```ts
const URL = 'https://data.rennesmetropole.fr/api/explore/v2.1/catalog/datasets/etat-du-trafic-en-temps-reel/exports/geojson';
export const RENNES_ATTRIBUTION = 'Trafic : Rennes Métropole (ODbL)';

export class RennesFlowProvider implements OpenFlowProvider {
  readonly id = 'rennes' as const;
  readonly attribution = RENNES_ATTRIBUTION;
  private readonly cache: TtlCache<FlowSegment[]>;
  constructor(now: () => number = Date.now) {
    // Rennes publishes every three minutes; ten more minutes of stale data beats an empty city.
    this.cache = new TtlCache({ ttlMs: 180_000, staleMs: 600_000, maxEntries: 1, now });
  }
  async snapshot(): Promise<ProviderSnapshot> {
    const cached = await this.cache.getOrLoad('all', () => this.load());
    return { segments: cached.value, fetchedAt: cached.fetchedAt, stale: cached.stale };
  }
  private async load(): Promise<FlowSegment[]> {
    const body = await fetchJsonCapped<{ features?: unknown[] }>(URL, { maxBytes: 12 * 1024 * 1024, timeoutMs: 30_000, noRedirects: true });
    return (body.features ?? []).flatMap(toSegment);
  }
}
```

`toSegment` keeps `LineString` features with >= 2 finite `[lon, lat]` pairs; `id = 'rennes:' + predefinedlocationreference`; `closed: false`.

- [ ] **Step 4:** PASS. **Step 5: Commit** `feat(api): measured road speeds from Rennes Métropole (keyless)`.

---

### Task 4: Grenoble provider

**Files:** Create `apps/api/src/modules/traffic/open-flow/grenoble-flow.provider.ts`; Modify `levels.ts`; Test `open-flow.spec.ts`.

- [ ] **Step 1: Verify** (peer "Aide agent codage" reports): licence of Métromobilité data, meaning of `nsv_id` 0–4, any required request header. If reuse is not allowed, skip this task and remove Grenoble from the spec's tables, the attributions and the status. Otherwise record the licence text in the attribution constant.
- [ ] **Step 2: Failing tests** (inline data; codes as confirmed in Step 1, default table below):

```ts
it('maps service levels', () => {
  expect(grenobleLevel(1)).toEqual({ level: 0.9, closed: false });
  expect(grenobleLevel(2)).toEqual({ level: 0.6, closed: false });
  expect(grenobleLevel(3)).toEqual({ level: 0.3, closed: false });
  expect(grenobleLevel(4)).toEqual({ level: 0, closed: true });
  expect(grenobleLevel(0)).toEqual({ level: null, closed: false });
  expect(grenobleLevel('x')).toEqual({ level: null, closed: false });
});

it('joins public lines with live levels', async () => {
  const lines = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { code: 'N1_1', visible_internet: 1 }, geometry: { type: 'LineString', coordinates: [[5.7, 45.18], [5.71, 45.18]] } },
    { type: 'Feature', properties: { code: 'N1_2', visible_internet: 0 }, geometry: { type: 'LineString', coordinates: [[5.7, 45.19], [5.71, 45.19]] } },
  ] };
  const dyn = { N1_1: [{ time: 1, nsv_id: 3 }], N1_2: [{ time: 1, nsv_id: 1 }], N9_9: [{ time: 1, nsv_id: 2 }] };
  jest.spyOn(global, 'fetch').mockImplementation(async (url) =>
    new Response(JSON.stringify(String(url).includes('/lines/') ? lines : dyn), { status: 200 }));
  const { segments } = await new GrenobleFlowProvider().snapshot();
  expect(segments).toEqual([expect.objectContaining({ id: 'grenoble:N1_1', level: 0.3, closed: false })]);
});
```

- [ ] **Step 3: Implement** `grenobleLevel` (table `{1: 0.9, 2: 0.6, 3: 0.3}`, `4` → `{ level: 0, closed: true }`, else `{ level: null, closed: false }`) and `GrenobleFlowProvider` with two `TtlCache`s: lines `https://data.mobilites-m.fr/api/lines/json?types=trr` (ttl 24 h, stale 7 days), levels `https://data.mobilites-m.fr/api/dyn/trr/json` (ttl 60 s, stale 10 min); keep `visible_internet === 1` lines that have a level entry; `speedKmh`/`limitKmh` null.
- [ ] **Step 4:** PASS. **Step 5: Commit** `feat(api): measured road levels from Grenoble Métromobilité (keyless)`.

---

### Task 5: `/traffic/open-flow` and source status

**Files:** Create `apps/api/src/modules/traffic/open-flow/open-flow.service.ts`; Modify `traffic.controller.ts`, `traffic.module.ts`, `traffic.service.ts` (status type); Test `open-flow.spec.ts`, `traffic.spec.ts`.

**Interfaces:**
- `OpenFlowService(providers: OpenFlowProvider[])`, `inBbox(box: Bbox): Promise<GeoJSON.FeatureCollection<GeoJSON.LineString>>` (properties `{ id, source, level, closed, speedKmh, limitKmh }`, at most 5 000 features), `sources(): SourceStatus[]`.
- `SourceStatus = { id: 'tomtom' | 'rennes' | 'grenoble'; active: boolean; updatedAt: string | null; stale: boolean; attribution: string }`.
- `GET /traffic/open-flow?bbox=` (`gps:read`, `Cache-Control: private, max-age=60`); `GET /traffic/status` adds `sources`.

- [ ] **Step 1: Failing tests:**

```ts
it('merges providers, filters by box and survives a failing one', async () => {
  const ok: OpenFlowProvider = { id: 'rennes', attribution: 'R', snapshot: async () => ({ fetchedAt: new Date(0), stale: false, segments: [
    { id: 'rennes:a', source: 'rennes', coordinates: [[-1.65, 48.1], [-1.64, 48.1]], level: 0.5, closed: false, speedKmh: 35, limitKmh: 70 },
    { id: 'rennes:far', source: 'rennes', coordinates: [[3, 45], [3.1, 45]], level: 0.5, closed: false, speedKmh: 35, limitKmh: 70 },
  ] }) };
  const broken: OpenFlowProvider = { id: 'grenoble', attribution: 'G', snapshot: async () => { throw new Error('down'); } };
  const service = new OpenFlowService([ok, broken]);
  const collection = await service.inBbox({ minLon: -1.8, minLat: 48, maxLon: -1.5, maxLat: 48.2 });
  expect(collection.features.map((f) => f.properties?.id)).toEqual(['rennes:a']);
  expect(service.sources()).toEqual([
    expect.objectContaining({ id: 'rennes', active: true }),
    expect.objectContaining({ id: 'grenoble', active: false }),
  ]);
});
```

and in `traffic.spec.ts`: the controller's `openFlow('nope')` throws `BadRequestException`.

- [ ] **Step 2:** FAIL. **Step 3: Implement** with `Promise.allSettled`; each provider's last outcome recorded (`active = fulfilled`, `updatedAt = fetchedAt.toISOString()`, `stale`). Only providers whose coverage box intersects the request are asked (Rennes `[-2.0, 47.9, -1.4, 48.3]`, Grenoble `[5.5, 45.0, 6.0, 45.35]`, stored on each provider as `readonly coverage: Bbox`), so a view over Ghana costs no upstream call. Controller:

```ts
@Get('open-flow')
@RequirePermissions('gps:read')
@Header('Cache-Control', 'private, max-age=60')
@ApiOperation({ summary: 'Measured road speeds from keyless open data (Rennes, Grenoble) inside a box' })
openFlow(@Query('bbox') bbox?: string) {
  const box = parseBbox(bbox);
  if (!box) throw new BadRequestException('bbox must be minLon,minLat,maxLon,maxLat, at most 5° wide');
  return this.openFlowService.inBbox(box);
}
```

`status()` returns `{ ...this.traffic.status(), sources: [tomtomSource, ...this.openFlowService.sources()] }` where `tomtomSource = { id: 'tomtom', active: enabled && !exhausted, updatedAt: null, stale: false, attribution: 'Traffic © TomTom' }`.

- [ ] **Step 4:** PASS; full `npx jest` green. **Step 5: Commit** `feat(api): /traffic/open-flow and per-source traffic status`.

---

### Task 6 (peer "Aide agent codage"): web pure units

**Files:** Create `apps/web/src/lib/traffic/{flow-level,roads,flow-match,simulation}.ts` + `*.test.ts`.

**Interfaces (fixed, Tasks 7–8 depend on them):**

```ts
// flow-level.ts
export type FlowBucket = 'free' | 'slow' | 'jam';
export function flowBucket(level: number | null | undefined): FlowBucket | null;
export function flowSpeedScale(level: number | null | undefined): number;   // [0.15, 1]
export function flowDensityMult(level: number | null | undefined): number;  // [1, 2.5]
// roads.ts
export type RoadClass = 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'minor' | 'service';
export interface Road { id: string; roadClass: RoadClass; coordinates: [number, number][]; oneway: 0 | 1 | -1; freeSpeedKmh: number; densityWeight: number; lengthM: number }
export interface TransportationFeature { id?: string | number; properties: Record<string, unknown> | null; geometry: { type: string; coordinates: unknown } }
export function roadsFromFeatures(features: TransportationFeature[], zoom: number): Road[];
// flow-match.ts
export type FlowSource = 'rennes' | 'grenoble' | 'tomtom';
export interface FlowLine { coordinates: [number, number][]; level: number | null; closed: boolean; bothDirections: boolean; source: FlowSource }
export interface RoadFlow { level: number | null; closed: boolean; source: FlowSource }
export interface DirectionalFlow { forward: RoadFlow | null; backward: RoadFlow | null }
export function matchFlow(roads: Road[], lines: FlowLine[], options?: { sampleM?: number; radiusM?: number; maxBearingDeg?: number }): Map<string, DirectionalFlow>;
// simulation.ts
export class TrafficSimulation {
  constructor(options?: { maxDots?: number; random?: () => number });
  setRoads(roads: Road[], flows: Map<string, DirectionalFlow>, zoom: number): void;
  step(dtSeconds: number): void;
  forEachDot(visit: (lon: number, lat: number, bucket: FlowBucket | null) => void): void;
  get dotCount(): number;
}
```

Behaviour: as in the spec §4 and the contract message (dedupe, `service` only at zoom >= 15, 40 % match rule, median level, allocation by weight under 6 000, real-time speeds with ±15 %, wrap-around). Merged here by cherry-pick; `npx vitest run src/lib/traffic` green before merge.

---

### Task 7: WebGL dot layer

**Files:** Create `apps/web/src/app/(app)/map/_components/road-traffic-layer.ts`; Test `apps/web/src/app/(app)/map/_components/road-traffic-layer.test.ts` (pure packing only).

**Interfaces:**
- Consumes: `TrafficSimulation.forEachDot`, `FlowBucket`.
- Produces: `packDots(simulation, colours: Record<'none' | FlowBucket, [number, number, number, number]>, out?: Float32Array): { data: Float32Array; count: number }` (6 floats per dot: mercator x, y, r, g, b, a); `createRoadTrafficLayer(id: string, simulation: TrafficSimulation, colours: () => Record<…>): CustomLayerInterface & { setActive(active: boolean): void }`.

- [ ] **Step 1: Failing test** — `packDots` with a fake simulation (`forEachDot` visiting `(0, 0, null)` and `(180, 0, 'jam')`) returns `count 2`, first x/y `0.5, 0.5`, second x `1`, colours from the table.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** Mercator: `x = (lon + 180) / 360`, `y = (1 - ln(tan(π/4 + φ/2)) / π) / 2`. Custom layer: `onAdd` compiles a vertex shader `gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0); gl_PointSize = u_size;` and a fragment shader drawing a round point (`discard` outside the unit circle, premultiplied colour); `render(gl, options)` steps the simulation with the real elapsed time (clamped to 0.25 s), packs, uploads with `bufferData(DYNAMIC_DRAW)`, draws `gl.POINTS` with `options.modelViewProjectionMatrix`, point size `clamp(1.5 + (zoom - 12) * 0.9, 1.5, 6) * devicePixelRatio`, blending `ONE, ONE_MINUS_SRC_ALPHA`, then `map.triggerRepaint()` while active and `document.visibilityState === 'visible'`. `onRemove` deletes buffer and program.
- [ ] **Step 4:** PASS. **Step 5: Commit** `feat(web): WebGL layer drawing simulated road traffic`.

---

### Task 8: Live map integration

**Files:**
- Create: `apps/web/src/app/(app)/map/_components/use-road-traffic.ts`
- Modify: `apps/web/src/app/(app)/map/page.tsx`, `apps/web/src/lib/intel.ts` (`TrafficStatus.sources`), `apps/web/src/lib/i18n.tsx`

**Interfaces:**
- Consumes: Task 6 units, Task 7 layer, `/traffic/open-flow`, `/traffic/flow-tiles`, `/traffic/status`.
- Produces: `useRoadTraffic(map: MapLibreMap | null, ready: boolean, palette: Palette, options: { enabled: boolean; tomtom: boolean; beforeLayerId?: string }): { zoomTooLow: boolean; roadsLoaded: boolean; measuredSources: FlowSource[]; dots: number }`.

- [ ] **Step 1: Hook.** On `ready`:
  - add vector source `road-traffic-roads` (`url: 'https://tiles.openfreemap.org/planet'`) and an invisible line layer `road-traffic-roads-probe` (`source-layer: 'transportation'`, `minzoom: 12`, `line-opacity: 0`) so MapLibre loads the tiles;
  - add GeoJSON source `road-traffic-open` + line layer `road-traffic-open-lines` (`minzoom: 10`, width 2, opacity 0.55, colour by `level` with the thresholds, dashed red when `closed`);
  - when `tomtom`: vector source `road-traffic-tomtom` (`tiles: [apiUrl('/traffic/flow-tiles/{z}/{x}/{y}')]`, `maxzoom: 12`) + line layer `road-traffic-tomtom-lines` (`source-layer: 'Traffic flow'`, `minzoom: 10`, filter `traffic_level < 0.85 || road_closure == true`, same colours);
  - add the custom layer `road-traffic-dots` before `beforeLayerId` (first aircraft/vessel layer).
  - On `moveend` (500 ms debounce) at zoom >= 12: `roadsFromFeatures(map.querySourceFeatures('road-traffic-roads', { sourceLayer: 'transportation' }), zoom)`; flow lines = open features in view (`bothDirections: false`) + TomTom features (`querySourceFeatures('road-traffic-tomtom', { sourceLayer: 'Traffic flow' })`, `level = traffic_level`, `closed = road_closure === true`, `bothDirections = traffic_road_coverage === 'full'`); `simulation.setRoads(roads, matchFlow(roads, lines), zoom)`.
  - Fetch `/traffic/open-flow?bbox=` for the view (rounded to 0.05°, zoom >= 10) every 60 s with React Query; `setData` on the source.
  - Layer visibility follows `enabled`; the dot layer is inactive below zoom 12.
- [ ] **Step 2: Page.** Remove the raster `TRAFFIC_LAYER` source/layer and its effect. `showTraffic` defaults to `true`, persisted under `localStorage['scip.map.traffic']` (try/catch). The toggle is always enabled. Under the toggles, a one-line status built from the hook: `map.traffic.status.zoomIn` (below 12), `map.traffic.status.offline` (roads did not load), else `map.traffic.status.simulated` + (`measuredSources.length` ? `map.traffic.status.measured` with names : `map.traffic.status.estimated`), + TomTom budget (`tilesUsedToday / dailyBudget` or `illimité`). Legend chips: fleet (accent dot, "Ma flotte · balises GPS (réel)"), traffic (muted dot, "Trafic · simulé"), jams (red line, "Bouchons · mesurés").
- [ ] **Step 3: i18n (FR / EN):** `map.traffic.status.zoomIn` "Zoomez pour voir le trafic" / "Zoom in to see traffic"; `.offline` "Trafic indisponible hors connexion" / "Traffic unavailable offline"; `.simulated` "Trafic simulé sur routes réelles" / "Simulated traffic on real roads"; `.measured` "vitesses mesurées : {sources}" / "measured speeds: {sources}"; `.estimated` "vitesses estimées" / "estimated speeds"; `.budget` "TomTom {used}/{budget} tuiles aujourd'hui" / "TomTom {used}/{budget} tiles today"; `.unlimited` "illimité" / "unlimited"; `map.legend.fleet`, `map.legend.traffic`, `map.legend.jams` as above.
- [ ] **Step 4: Check:** `npx tsc --noEmit -p .`, `npx vitest run`, `npx next build` (static export) green; in the browser pane against the test stack: Ghana at zoom 13 shows grey dots moving, Rennes at zoom 13 shows coloured lines and coloured dots, fleet markers stay on top.
- [ ] **Step 5: Commit** `feat(web): live road traffic on the live map, fleet on top`.

---

### Task 9: Settings field, sources, docs

**Files:** Modify `apps/web/src/app/(app)/settings/page.tsx` (+ i18n), `apps/web/src/app/(app)/situation/_components/sources-panel.tsx`, `docs/intel/traffic.md`, `docs/INTEL.md`, `docs/ROADMAP-presentation.md`.

- [ ] **Step 1:** In the "map" panel under the TomTom key: numeric field "Budget TomTom par jour (0 = illimité)" bound to `GET/PUT /settings/traffic`, hint "Au-delà du quota gratuit de TomTom, TomTom facture ou refuse les tuiles." Save with its own button; invalidate `['traffic']`.
- [ ] **Step 2:** Sources panel: OpenFreeMap (© OpenMapTiles, © OpenStreetMap contributors, ODbL), Rennes Métropole (ODbL), Métromobilité (licence from Task 4), TomTom.
- [ ] **Step 3:** Rewrite `docs/intel/traffic.md` (sources, level, budget, honest simulation, endpoints), update the module table in `docs/INTEL.md`, add the feature to `ROADMAP-presentation.md` ("Ce qui est déjà solide").
- [ ] **Step 4:** `npx tsc`, `npx vitest run` green. **Step 5: Commit** `feat(web): TomTom budget setting and traffic sources; docs`.

---

### Task 10: End-to-end verification

- [ ] **Step 1:** `npx jest` (API), `npx tsc` (API + web), `npx vitest run`, `cargo test` (desktop + installer) green.
- [ ] **Step 2:** `node apps/desktop/scripts/stage-all.mjs api web defaults`, then `node apps/installer/scripts/build-setup.mjs`.
- [ ] **Step 3:** Test install (`SCIP_SETUP_TEST=1 SCIP_SETUP_TEST_ROOT=<scratch>/setup-traffic`, demo plan), start the stack like `p0-stack.sh`, check: `GET /traffic/open-flow?bbox=-1.8,48.0,-1.5,48.2` returns Rennes lines; `/traffic/status` lists `tomtom`, `rennes`, `grenoble`; `PUT /settings/traffic {dailyTileBudget:0}` then status shows `dailyBudget: 0`; browser: Ghana zoom 13 dots, Rennes zoom 13 colours, fleet on top.
- [ ] **Step 4:** Uninstall (`--uninstall --silent --remove-data`), clean the scratch root, report to the user with the installer path and how to paste the TomTom key.
