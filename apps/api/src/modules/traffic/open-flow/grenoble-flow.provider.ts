import { TtlCache, fetchJsonCapped } from '../../../common/http';
import type { Bbox } from './bbox';
import { grenobleLevel } from './levels';
import { lineCoordinates, type FlowSegment, type OpenFlowProvider, type ProviderSnapshot } from './types';

/**
 * Métromobilité (SMMAG, Grenoble area), road traffic ("trr"): about 250 public road lines with a
 * live service level. Keyless, ODbL. Geometry and levels are two endpoints joined on the line code:
 * the lines barely change (fetched daily), the levels every minute.
 */
const LINES_URL = 'https://data.mobilites-m.fr/api/lines/json?types=trr';
const LEVELS_URL = 'https://data.mobilites-m.fr/api/dyn/trr/json';

export const GRENOBLE_ATTRIBUTION = 'Trafic Grenoble © Métromobilité / SMMAG (ODbL)';

/** Grenoble metropolitan area with a margin. */
const GRENOBLE_COVERAGE: Bbox = { minLon: 5.5, minLat: 45.0, maxLon: 6.0, maxLat: 45.35 };

type Lines = Map<string, [number, number][]>;
type Levels = Map<string, unknown>;

export class GrenobleFlowProvider implements OpenFlowProvider {
  readonly id = 'grenoble' as const;
  readonly attribution = GRENOBLE_ATTRIBUTION;
  readonly coverage = GRENOBLE_COVERAGE;
  private readonly lines: TtlCache<Lines>;
  private readonly levels: TtlCache<Levels>;

  constructor(now: () => number = Date.now) {
    this.lines = new TtlCache({ ttlMs: 24 * 3_600_000, staleMs: 7 * 24 * 3_600_000, maxEntries: 1, now });
    this.levels = new TtlCache({ ttlMs: 60_000, staleMs: 600_000, maxEntries: 1, now });
  }

  async snapshot(): Promise<ProviderSnapshot> {
    const [lines, levels] = await Promise.all([
      this.lines.getOrLoad('all', () => loadLines()),
      this.levels.getOrLoad('all', () => loadLevels()),
    ]);
    const segments: FlowSegment[] = [];
    for (const [code, value] of levels.value) {
      const coordinates = lines.value.get(code);
      if (!coordinates) continue; // a level for a line that is not public, or not published yet
      const { level, closed } = grenobleLevel(value);
      segments.push({
        id: `grenoble:${code}`,
        source: 'grenoble',
        coordinates,
        level,
        closed,
        speedKmh: null,
        limitKmh: null,
        // The drawing direction of these lines does not follow traffic (paired _S1/_S2 lines are
        // drawn either way): the level holds for both directions.
        bothDirections: true,
      });
    }
    return { segments, fetchedAt: levels.fetchedAt, stale: lines.stale || levels.stale };
  }
}

/** Public lines only (`visible_internet = 1`), by code. */
async function loadLines(): Promise<Lines> {
  const body = await fetchJsonCapped<{ features?: unknown }>(LINES_URL, { maxBytes: 4 * 1024 * 1024, timeoutMs: 20_000 });
  const lines: Lines = new Map();
  if (!Array.isArray(body.features)) return lines;
  for (const feature of body.features as { geometry?: { type?: unknown; coordinates?: unknown }; properties?: Record<string, unknown> }[]) {
    const code = feature?.properties?.code;
    if (typeof code !== 'string' || feature.properties?.visible_internet !== 1) continue;
    if (feature.geometry?.type !== 'LineString') continue;
    const coordinates = lineCoordinates(feature.geometry.coordinates);
    if (coordinates) lines.set(code, coordinates);
  }
  return lines;
}

/** `{ code: [{ time, nsv_id }] }` to the latest `nsv_id` per code (undefined when the list is empty). */
async function loadLevels(): Promise<Levels> {
  const body = await fetchJsonCapped<Record<string, unknown>>(LEVELS_URL, { maxBytes: 1024 * 1024, timeoutMs: 15_000 });
  const levels: Levels = new Map();
  for (const [code, entries] of Object.entries(body ?? {})) {
    const latest = Array.isArray(entries) ? (entries[0] as { nsv_id?: unknown } | undefined) : undefined;
    levels.set(code, latest?.nsv_id);
  }
  return levels;
}
