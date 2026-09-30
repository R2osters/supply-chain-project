import { TtlCache, fetchJsonCapped } from '../../../common/http';
import type { Bbox } from './bbox';
import { rennesLevel } from './levels';
import { lineCoordinates, type FlowSegment, type OpenFlowProvider, type ProviderSnapshot } from './types';

/**
 * Rennes Métropole, "Etat du trafic en temps réel": about 2 900 road lines of the metropolitan
 * area with their measured average speed, speed limit and status, refreshed every three minutes.
 * Keyless, ODbL. The whole export (~2.4 MB) is fetched in one call rather than page by page.
 */
const EXPORT_URL =
  'https://data.rennesmetropole.fr/api/explore/v2.1/catalog/datasets/etat-du-trafic-en-temps-reel/exports/geojson';

export const RENNES_ATTRIBUTION = 'Trafic Rennes © Rennes Métropole (ODbL)';

/** Rennes Métropole with a margin; the published lines all fall inside it. */
const RENNES_COVERAGE: Bbox = { minLon: -2.0, minLat: 47.9, maxLon: -1.4, maxLat: 48.3 };

export class RennesFlowProvider implements OpenFlowProvider {
  readonly id = 'rennes' as const;
  readonly attribution = RENNES_ATTRIBUTION;
  readonly coverage = RENNES_COVERAGE;
  private readonly cache: TtlCache<FlowSegment[]>;

  constructor(now: () => number = Date.now) {
    // Rennes publishes every three minutes; ten more minutes of the last export beats an empty
    // city, and past that the map says the source is down rather than show old jams as live.
    this.cache = new TtlCache({ ttlMs: 180_000, staleMs: 600_000, maxEntries: 1, now });
  }

  async snapshot(): Promise<ProviderSnapshot> {
    const cached = await this.cache.getOrLoad('all', () => this.load());
    return { segments: cached.value, fetchedAt: cached.fetchedAt, stale: cached.stale };
  }

  private async load(): Promise<FlowSegment[]> {
    const body = await fetchJsonCapped<{ features?: unknown }>(EXPORT_URL, {
      maxBytes: 12 * 1024 * 1024,
      timeoutMs: 30_000,
      noRedirects: true,
    });
    return Array.isArray(body.features) ? body.features.flatMap(toSegment) : [];
  }
}

interface RennesFeature {
  geometry?: { type?: unknown; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

function toSegment(feature: unknown): FlowSegment[] {
  const { geometry, properties } = (feature ?? {}) as RennesFeature;
  if (geometry?.type !== 'LineString' || !properties) return [];
  const reference = properties.predefinedlocationreference;
  if (typeof reference !== 'string' || reference === '') return [];
  const coordinates = lineCoordinates(geometry.coordinates);
  if (!coordinates) return [];
  const speed = properties.averagevehiclespeed;
  const limit = properties.vitesse_maxi;
  return [
    {
      id: `rennes:${reference}`,
      source: 'rennes',
      coordinates,
      level: rennesLevel(speed, limit, properties.trafficstatus, properties.vehicleprobemeasurement),
      closed: false,
      speedKmh: typeof speed === 'number' && Number.isFinite(speed) ? speed : null,
      limitKmh: typeof limit === 'number' && Number.isFinite(limit) ? limit : null,
      // Each line is drawn in its direction of travel (two-way roads come as a _D/_G pair).
      bothDirections: false,
    },
  ];
}
