/**
 * The order in which free geocoders are asked.
 *
 * Photon goes first: it is built for search-as-you-type, has no published per-second limit and
 * tolerates partial names. Nominatim goes second because its policy allows one request per
 * second for the whole deployment, so it is the scarce resource and is only spent when Photon
 * has failed or found nothing. Pasted coordinates never leave the process.
 */

import { coordinateResult, parseCoordinateQuery, type GeocodeResult } from './geocoding-normalizers';

export type GeocodeSource = 'coordinates' | 'photon' | 'nominatim' | 'none';

export interface GeocodeResponse {
  source: GeocodeSource;
  results: GeocodeResult[];
}

export interface GeocodeFetchers {
  photon: (query: string, limit: number) => Promise<GeocodeResult[]>;
  nominatim: (query: string, limit: number) => Promise<GeocodeResult[]>;
}

/** Thrown only when every provider errored, so the caller can decide not to cache the outcome. */
export class GeocodersUnavailableError extends Error {
  constructor(readonly causes: unknown[]) {
    super('No geocoding provider answered');
    this.name = 'GeocodersUnavailableError';
  }
}

export async function runGeocodeCascade(
  query: string,
  limit: number,
  fetchers: GeocodeFetchers,
): Promise<GeocodeResponse> {
  const point = parseCoordinateQuery(query);
  if (point) return { source: 'coordinates', results: [coordinateResult(point)] };

  const failures: unknown[] = [];
  const providers: Array<[Exclude<GeocodeSource, 'coordinates' | 'none'>, GeocodeFetchers['photon']]> = [
    ['photon', fetchers.photon],
    ['nominatim', fetchers.nominatim],
  ];
  for (const [source, fetcher] of providers) {
    try {
      const results = (await fetcher(query, limit)).slice(0, limit);
      if (results.length) return { source, results };
    } catch (error) {
      failures.push(error);
    }
  }
  // Every provider answered and none knew the place: a real, cacheable "not found".
  if (failures.length < providers.length) return { source: 'none', results: [] };
  throw new GeocodersUnavailableError(failures);
}
