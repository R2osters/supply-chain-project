import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GateFullError,
  RequestGate,
  TtlCache,
  UpstreamError,
  haversineKm,
  type CachedValue,
} from '../../common/http';
import { requireCompanyId } from '../../common/tenancy/tenant-scope';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { FeedSettingsService } from '../settings/feed-settings.service';
import {
  computeExposures,
  shipmentAssetPoints,
  type ActiveShipment,
  type ExposureAsset,
} from './hazard-exposure';
import { mergeKeylessFires, outsideNhcBasins } from './hazard-merge';
import { isInBoundingBox } from './hazard-severity';
import type {
  BoundingBox,
  ExposureResponse,
  Hazard,
  HazardsResponse,
  NewsResponse,
  SourceId,
  SourceStatus,
  WeatherResponse,
} from './hazard.types';
import type { HazardsQueryDto, NewsQueryDto, WeatherQueryDto } from './hazards.dto';
import {
  EONET_ATTRIBUTION,
  eonetFireToHazard,
  fetchEonetFires,
  type EonetFire,
} from './sources/eonet-wildfires';
import { boxesAroundPoints, clampFirmsBox, fetchFirmsArea, firmsAreaKey } from './sources/firms-fires';
import {
  GDACS_ATTRIBUTION,
  GDACS_QUERIES,
  fetchGdacsEvents,
  gdacsEventToHazard,
  liveGdacsEvents,
  type GdacsEvent,
  type GdacsQuery,
} from './sources/gdacs-events';
import { fetchGdeltArticles, placeQueryFromHazard, sanitiseQuery } from './sources/gdelt-news';
import { NHC_COVERAGE_NOTE, fetchNhcHazards } from './sources/nhc-cyclones';
import {
  OPEN_METEO_ATTRIBUTION,
  fetchOpenMeteo,
  weatherCell,
  weatherToHazard,
  type WeatherObservation,
} from './sources/open-meteo-weather';
import { fetchUsgsHazards } from './sources/usgs-earthquakes';
import { SEVERE_WEATHER_THRESHOLD, computeWeatherSeverity } from './weather-severity';

const MINUTE_MS = 60_000;

/**
 * Labels are shown as is in the sources panel. The NHC label stays the agency's proper name: the
 * web matches a hazard's `source` ('NOAA National Hurricane Center') to its feed by this label.
 */
const SOURCE_META: Record<SourceId, { label: string; attribution: string }> = {
  nhc: {
    label: 'NOAA National Hurricane Center',
    attribution: 'NOAA/NWS National Hurricane Center (domaine public)',
  },
  usgs: {
    label: 'Séismes USGS (M2.5+, dernières 24 h)',
    attribution: 'U.S. Geological Survey Earthquake Hazards Program (domaine public)',
  },
  firms: {
    label: 'Feux actifs NASA FIRMS (VIIRS)',
    attribution:
      'We acknowledge the use of data and/or imagery from NASA’s Fire Information for Resource ' +
      'Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA’s Earth ' +
      'Science Data and Information System (ESDIS).',
  },
  'open-meteo': {
    label: 'Météo actuelle Open-Meteo',
    attribution: `${OPEN_METEO_ATTRIBUTION} — https://open-meteo.com/`,
  },
  gdelt: { label: 'Actualités GDELT', attribution: 'GDELT Project (https://www.gdeltproject.org/)' },
  gdacs: {
    label: 'Alertes catastrophes mondiales GDACS',
    attribution: `${GDACS_ATTRIBUTION} (https://www.gdacs.org/)`,
  },
  eonet: {
    label: 'Feux de forêt NASA EONET',
    attribution: `${EONET_ATTRIBUTION} (https://eonet.gsfc.nasa.gov/)`,
  },
};

/** NHC's coverage caveat when GDACS is answering for the other basins. */
const NHC_COVERAGE_WITH_GDACS_NOTE =
  'Le NHC couvre l’Atlantique et le Pacifique Nord oriental et central ; les cyclones des autres bassins viennent de GDACS.';

/** A source served from cache because its upstream failed. */
const STALE_NOTE = 'Source indisponible : affichage des dernières données valides.';

/** Active shipment states: the goods are between two places and can be caught by weather. */
const ACTIVE_SHIPMENT_STATUSES = ['DEPARTED', 'IN_TRANSIT', 'DELAYED'] as const;

/** Upper bounds on one exposure pass, so a large tenant cannot turn a page load into a flood. */
const MAX_ASSETS_PER_KIND = 500;
const MAX_ACTIVE_SHIPMENTS = 300;
const MAX_WEATHER_CELLS = 40;
const WEATHER_CONCURRENCY = 4;
const DB_BATCH = 20;

/** When lat/lon is given without words, the nearest hazard within this range names the place. */
const NEWS_PLACE_SEARCH_KM = 500;

interface Loaded<T> {
  value: T | null;
  status: SourceStatus;
}

/** The two keyless global feeds, loaded together because their events are merged together. */
interface OpenFeeds {
  gdacs: Loaded<GdacsEvent[]>;
  eonet: Loaded<EonetFire[]>;
  /** Whether the GDACS query that carries cyclones answered (fresh or stale). */
  cyclonesCovered: boolean;
}

/**
 * Natural hazards near the map viewport and near the company's own assets.
 *
 * Every source is free and run by someone else, so each is cached, served stale when it goes
 * down, and isolated: USGS being unreachable leaves cyclones and fires on the map and reports
 * USGS as UNAVAILABLE rather than failing the whole response. A map with one layer missing and a
 * label saying why is useful; an error page is not.
 */
@Injectable()
export class HazardsService {
  private readonly logger = new Logger(HazardsService.name);

  private readonly nhcCache = new TtlCache<Hazard[]>({ ttlMs: 5 * MINUTE_MS, staleMs: 60 * MINUTE_MS, maxEntries: 1 });
  private readonly usgsCache = new TtlCache<Hazard[]>({ ttlMs: 5 * MINUTE_MS, staleMs: 60 * MINUTE_MS, maxEntries: 1 });
  private readonly firmsCache = new TtlCache<Hazard[]>({ ttlMs: 30 * MINUTE_MS, staleMs: 120 * MINUTE_MS, maxEntries: 200 });
  /** One entry per GDACS query (see GDACS_QUERIES). Liveness is judged on read, not on load. */
  private readonly gdacsCache = new TtlCache<GdacsEvent[]>({
    ttlMs: 20 * MINUTE_MS,
    staleMs: 180 * MINUTE_MS,
    maxEntries: 3,
  });
  private readonly eonetCache = new TtlCache<EonetFire[]>({
    ttlMs: 30 * MINUTE_MS,
    staleMs: 180 * MINUTE_MS,
    maxEntries: 1,
  });
  private readonly weatherCache = new TtlCache<WeatherObservation>({
    ttlMs: 10 * MINUTE_MS,
    staleMs: 60 * MINUTE_MS,
    maxEntries: 5000,
  });
  private readonly newsCache = new TtlCache<NewsResponse['articles']>({
    ttlMs: 15 * MINUTE_MS,
    staleMs: 120 * MINUTE_MS,
    maxEntries: 300,
  });
  /** GDELT throttles clients that ask more than about once per five seconds. */
  private readonly gdeltGate = new RequestGate({ minIntervalMs: 5_000, maxQueue: 4 });

  private readonly exposureRadiusKm: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<AppConfig, true>,
    private readonly feeds: FeedSettingsService,
  ) {
    const intel = config.get('intel', { infer: true });
    this.exposureRadiusKm = intel.hazardExposureRadiusKm;
  }

  /** Read on each use: a key entered in the settings screen applies without a restart. */
  private get firmsMapKey(): string | null {
    return this.feeds.get('firmsMapKey');
  }

  /* ================================================================== hazards */

  async listHazards(query: HazardsQueryDto): Promise<HazardsResponse> {
    const bbox = parseBoundingBox(query);
    // Read once: whether fires come from FIRMS or from the keyless feeds is decided per request.
    const firmsKey = this.firmsMapKey;
    const [nhc, usgs, firms, open] = await Promise.all([
      this.loadCyclones(),
      this.loadEarthquakes(),
      this.loadFiresForViewport(bbox, firmsKey),
      this.loadOpenFeeds(!firmsKey),
    ]);
    const openHazards = this.openFeedHazards(open, nhc.value !== null);
    noteNhcCoverage(nhc.status, open.cyclonesCovered);

    const global = [...(nhc.value ?? []), ...(usgs.value ?? []), ...openHazards];
    const visible = bbox ? global.filter((h) => hazardTouchesBox(h, bbox)) : global;
    const hazards = [...visible, ...(firms.value ?? [])].sort((a, b) => b.severityScore - a.severityScore);

    return {
      generatedAt: new Date().toISOString(),
      sources: [nhc.status, usgs.status, open.gdacs.status, firms.status, open.eonet.status],
      hazards,
    };
  }

  /* ================================================================== weather */

  async getWeather(query: WeatherQueryDto): Promise<WeatherResponse> {
    const cell = weatherCell(query.lat, query.lon);
    let result;
    try {
      result = await this.weatherCache.getOrLoad(cell.key, () => fetchOpenMeteo(cell.latitude, cell.longitude));
    } catch (error) {
      this.logger.warn(`Open-Meteo unavailable: ${describeError(error)}`);
      throw new ServiceUnavailableException('La météo est momentanément indisponible. Réessayez dans un instant.');
    }
    const observation = result.value;
    const assessment = computeWeatherSeverity(observation);
    return {
      latitude: observation.latitude,
      longitude: observation.longitude,
      observedAt: observation.observedAt,
      temperatureC: observation.temperatureC,
      windKmh: observation.windKmh,
      windGustKmh: observation.windGustKmh,
      precipitationMm: observation.precipitationMm,
      visibilityM: observation.visibilityM,
      cloudCoverPct: observation.cloudCoverPct,
      weatherCode: observation.weatherCode,
      condition: assessment.condition,
      severity: assessment.severity,
      reasons: assessment.reasons,
      attribution: SOURCE_META['open-meteo'].attribution,
      stale: result.stale,
    };
  }

  /**
   * Weather severity at a point for other modules (the delay model). Returns null instead of
   * throwing: a prediction must never fail because a free weather API is down.
   */
  async weatherSeverityAt(latitude: number, longitude: number): Promise<number | null> {
    try {
      const response = await this.getWeather({ lat: latitude, lon: longitude });
      return response.severity;
    } catch {
      return null;
    }
  }

  /* ================================================================= exposure */

  async exposureFor(user: AuthenticatedUser): Promise<ExposureResponse> {
    return this.companyExposure(requireCompanyId(user));
  }

  /** Company-scoped exposure; also the input the risk engine receives. */
  async companyExposure(companyId: string): Promise<ExposureResponse> {
    const assets = await this.loadAssets(companyId);
    const firmsKey = this.firmsMapKey;
    const [nhc, usgs, firms, weather, open] = await Promise.all([
      this.loadCyclones(),
      this.loadEarthquakes(),
      this.loadFiresAroundAssets(assets, firmsKey),
      this.loadSevereWeather(assets),
      this.loadOpenFeeds(!firmsKey),
    ]);
    const openHazards = this.openFeedHazards(open, nhc.value !== null);
    noteNhcCoverage(nhc.status, open.cyclonesCovered);

    const hazards = [
      ...(nhc.value ?? []),
      ...(usgs.value ?? []),
      ...(firms.value ?? []),
      ...(weather.value ?? []),
      ...openHazards,
    ];

    return {
      radiusKm: this.exposureRadiusKm,
      generatedAt: new Date().toISOString(),
      exposures: computeExposures(assets, hazards, this.exposureRadiusKm),
      sources: [nhc.status, usgs.status, open.gdacs.status, firms.status, open.eonet.status, weather.status],
    };
  }

  /* ===================================================================== news */

  async news(query: NewsQueryDto): Promise<NewsResponse> {
    const text = query.q?.trim() || (await this.placeNear(query));
    if (text === undefined) {
      throw new BadRequestException('Indiquez un lieu ou un mot-clé dans q, ou bien lat et lon.');
    }
    const cleaned = text ? sanitiseQuery(text) : '';
    if (cleaned.length < 2) {
      return { status: 'UNAVAILABLE', query: cleaned, articles: [], attribution: 'GDELT Project' };
    }

    try {
      const result = await this.newsCache.getOrLoad(cleaned.toLowerCase(), () =>
        this.gdeltGate.run(() => fetchGdeltArticles(cleaned)),
      );
      return {
        status: result.stale ? 'STALE' : 'OK',
        query: cleaned,
        articles: result.value,
        attribution: 'GDELT Project',
      };
    } catch (error) {
      if (!(error instanceof GateFullError)) this.logger.warn(`GDELT unavailable: ${describeError(error)}`);
      return { status: 'UNAVAILABLE', query: cleaned, articles: [], attribution: 'GDELT Project' };
    }
  }

  /**
   * Coordinates without words: GDELT searches text, not places, so the nearest known hazard
   * lends its place name. Returns '' when nothing is nearby, undefined when no point was given.
   */
  private async placeNear(query: NewsQueryDto): Promise<string | undefined> {
    if (query.lat === undefined || query.lon === undefined) return undefined;
    const point = { latitude: query.lat, longitude: query.lon };
    const [nhc, usgs] = await Promise.all([this.loadCyclones(), this.loadEarthquakes()]);
    const nearest = [...(nhc.value ?? []), ...(usgs.value ?? [])]
      .map((hazard) => ({ hazard, distance: haversineKm(point, hazard) }))
      .filter(({ hazard, distance }) => distance <= NEWS_PLACE_SEARCH_KM + hazard.radiusKm)
      .sort((a, b) => a.distance - b.distance)
      .map(({ hazard }) => placeQueryFromHazard(hazard))
      .find((place): place is string => Boolean(place));
    return nearest ?? '';
  }

  /* ================================================================== sources */

  /** Positions only; the coverage caveat is added by the caller, which knows whether GDACS answered. */
  private loadCyclones(): Promise<Loaded<Hazard[]>> {
    return this.loadSource('nhc', this.nhcCache, 'all', fetchNhcHazards);
  }

  private loadEarthquakes(): Promise<Loaded<Hazard[]>> {
    return this.loadSource('usgs', this.usgsCache, 'all', fetchUsgsHazards);
  }

  private async loadFiresForViewport(bbox: BoundingBox | null, key: string | null): Promise<Loaded<Hazard[]>> {
    if (!key) return disabledFirms();
    if (!bbox) {
      return {
        value: [],
        status: status(
          'firms',
          'OK',
          null,
          0,
          'Les feux ne sont chargés que pour une zone de la carte : envoyez une emprise (minLat, minLon, maxLat, maxLon).',
        ),
      };
    }
    const { box, clamped } = clampFirmsBox(bbox);
    const loaded = await this.loadFireBoxes([box], key);
    if (clamped) {
      const note =
        'Vue trop étendue : feux affichés pour ses 15°×15° centraux seulement. Zoomez pour une couverture complète.';
      loaded.status.note = loaded.status.note ? `${loaded.status.note} ${note}` : note;
    }
    return loaded;
  }

  private async loadFiresAroundAssets(assets: ExposureAsset[], key: string | null): Promise<Loaded<Hazard[]>> {
    if (!key) return disabledFirms();
    if (assets.length === 0) {
      return { value: [], status: status('firms', 'OK', null, 0, 'Aucun actif géolocalisé à vérifier.') };
    }
    // Pad each box by the exposure radius plus a fire's own footprint, in degrees of latitude.
    const paddingDeg = (this.exposureRadiusKm + 10) / 111;
    return this.loadFireBoxes(boxesAroundPoints(assets, paddingDeg), key);
  }

  /**
   * Boxes are fetched one after another rather than in parallel: FIRMS meters transactions per
   * key, and a burst of parallel area queries is what gets a key throttled.
   */
  private async loadFireBoxes(boxes: BoundingBox[], key: string): Promise<Loaded<Hazard[]>> {
    const byId = new Map<string, Hazard>();
    let ok = 0;
    let stale = 0;
    let oldest: Date | null = null;
    let lastError: string | null = null;

    for (const box of boxes) {
      try {
        const result = await this.firmsCache.getOrLoad(firmsAreaKey(box), () => fetchFirmsArea(key, box));
        ok += 1;
        if (result.stale) stale += 1;
        if (!oldest || result.fetchedAt < oldest) oldest = result.fetchedAt;
        for (const hazard of result.value) byId.set(hazard.id, hazard);
      } catch (error) {
        lastError = describeError(error);
      }
    }

    const hazards = [...byId.values()];
    if (ok === 0 && boxes.length > 0) {
      this.logger.warn(`FIRMS unavailable: ${lastError}`);
      return { value: null, status: status('firms', 'UNAVAILABLE', null, 0, lastError) };
    }
    const partial = ok < boxes.length;
    const state = stale > 0 || partial ? 'STALE' : 'OK';
    const failed = boxes.length - ok;
    const note = partial
      ? plural(
          failed,
          `${failed} zone sur ${boxes.length} n’a pas pu être récupérée.`,
          `${failed} zones sur ${boxes.length} n’ont pas pu être récupérées.`,
        )
      : stale > 0
        ? STALE_NOTE
        : null;
    return { value: hazards, status: status('firms', state, oldest?.toISOString() ?? null, hazards.length, note) };
  }

  /**
   * GDACS (floods, droughts, eruptions, cyclones, and forest fires when `withFires`) and EONET
   * wildfires (only when `withFires`). Without a FIRMS key these two are how fires reach the map.
   */
  private async loadOpenFeeds(withFires: boolean): Promise<OpenFeeds> {
    const [gdacs, eonet] = await Promise.all([this.loadGdacs(withFires), this.loadEonet(withFires)]);
    return { ...gdacs, eonet };
  }

  /**
   * The GDACS queries run in parallel and fail independently: droughts being unreachable leaves
   * floods and cyclones on the map, and the status note says which part is missing.
   */
  private async loadGdacs(withFires: boolean): Promise<Omit<OpenFeeds, 'eonet'>> {
    const queries: GdacsQuery[] = [GDACS_QUERIES.events, GDACS_QUERIES.droughts];
    if (withFires) queries.push(GDACS_QUERIES.fires);

    type Outcome =
      | { query: GdacsQuery; result: CachedValue<GdacsEvent[]> }
      | { query: GdacsQuery; error: string };
    const outcomes = await Promise.all(
      queries.map(async (query): Promise<Outcome> => {
        try {
          return { query, result: await this.gdacsCache.getOrLoad(query.key, () => fetchGdacsEvents(query)) };
        } catch (error) {
          return { query, error: describeError(error) };
        }
      }),
    );

    const answered = outcomes.flatMap((o) => ('result' in o ? [o] : []));
    const failed = outcomes.flatMap((o) => ('error' in o ? [o] : []));
    if (answered.length === 0) {
      const reason = failed[0]?.error ?? null;
      this.logger.warn(`GDACS unavailable: ${reason}`);
      const unavailable = status('gdacs', 'UNAVAILABLE', null, 0, reason);
      return { gdacs: { value: null, status: unavailable }, cyclonesCovered: false };
    }

    const stale = answered.some(({ result }) => result.stale);
    const oldest = Math.min(...answered.map(({ result }) => result.fetchedAt.getTime()));
    const notes: string[] = [];
    if (failed.length > 0) {
      notes.push(`Momentanément indisponible : ${failed.map(({ query }) => query.label).join(', ')}.`);
    }
    if (stale) notes.push(STALE_NOTE);
    return {
      gdacs: {
        value: answered.flatMap(({ result }) => result.value),
        // The count is what GDACS contributes after merging; `openFeedHazards` fills it in.
        status: status(
          'gdacs',
          failed.length > 0 || stale ? 'STALE' : 'OK',
          new Date(oldest).toISOString(),
          0,
          notes.length > 0 ? notes.join(' ') : null,
        ),
      },
      cyclonesCovered: answered.some(({ query }) => query === GDACS_QUERIES.events),
    };
  }

  private loadEonet(enabled: boolean): Promise<Loaded<EonetFire[]>> {
    if (!enabled) {
      const note = 'Non utilisé tant qu’une clé NASA FIRMS est définie : les détections FIRMS couvrent les feux.';
      return Promise.resolve({ value: [], status: status('eonet', 'DISABLED', null, 0, note) });
    }
    return this.loadSource('eonet', this.eonetCache, 'wildfires', () => fetchEonetFires());
  }

  /**
   * GDACS and EONET events that are live now, as hazards, after the two merge rules of
   * `hazard-merge.ts`: GDACS cyclones inside NHC's basins give way to NHC when NHC answered, and a
   * fire reported by both GDACS and EONET is kept once. Also fills in each feed's count, which is
   * what it contributed after merging.
   */
  private openFeedHazards(open: OpenFeeds, nhcAnswered: boolean): Hazard[] {
    const live = liveGdacsEvents(open.gdacs.value ?? [], Date.now());
    const events = nhcAnswered ? outsideNhcBasins(live) : live;
    const merged = mergeKeylessFires(events, open.eonet.value ?? []);

    const hazards = [...merged.gdacs.map(gdacsEventToHazard), ...merged.eonet.map(eonetFireToHazard)];
    for (const hazard of hazards) {
      const other = merged.sameFire.get(hazard.id);
      if (other) hazard.details.sameFireAs = other;
    }
    open.gdacs.status.count = merged.gdacs.length;
    open.eonet.status.count = merged.eonet.length;
    return hazards;
  }

  /**
   * Local weather at each asset, kept only where it is severe. Assets are snapped to weather
   * cells first so a cluster of sites costs one request, and the number of cells per pass is
   * capped — warehouses come first in the asset list, so they are the ones always checked.
   */
  private async loadSevereWeather(assets: ExposureAsset[]): Promise<Loaded<Hazard[]>> {
    const cells = new Map<string, { latitude: number; longitude: number }>();
    for (const asset of assets) {
      const cell = weatherCell(asset.latitude, asset.longitude);
      if (!cells.has(cell.key)) cells.set(cell.key, cell);
    }
    const checked = [...cells.entries()].slice(0, MAX_WEATHER_CELLS);

    let ok = 0;
    let stale = 0;
    const hazards: Hazard[] = [];
    await mapWithConcurrency(checked, WEATHER_CONCURRENCY, async ([key, cell]) => {
      try {
        const result = await this.weatherCache.getOrLoad(key, () => fetchOpenMeteo(cell.latitude, cell.longitude));
        ok += 1;
        if (result.stale) stale += 1;
        const assessment = computeWeatherSeverity(result.value);
        if (assessment.severity >= SEVERE_WEATHER_THRESHOLD) hazards.push(weatherToHazard(result.value, assessment));
      } catch {
        // Counted below as a missing cell; one failed point must not hide the others.
      }
    });

    const notes: string[] = [];
    if (cells.size > checked.length) {
      notes.push(
        plural(
          checked.length,
          `${checked.length} emplacement vérifié sur ${cells.size}.`,
          `${checked.length} emplacements vérifiés sur ${cells.size}.`,
        ),
      );
    }
    const missing = checked.length - ok;
    if (missing > 0) {
      notes.push(
        plural(
          missing,
          `${missing} emplacement n’a pas pu être récupéré.`,
          `${missing} emplacements n’ont pas pu être récupérés.`,
        ),
      );
    }
    if (stale > 0) notes.push('Certaines observations viennent du cache, car la source était indisponible.');

    const state = checked.length > 0 && ok === 0 ? 'UNAVAILABLE' : stale > 0 || ok < checked.length ? 'STALE' : 'OK';
    return {
      value: hazards,
      status: status(
        'open-meteo',
        state,
        ok > 0 ? new Date().toISOString() : null,
        hazards.length,
        notes.length ? notes.join(' ') : null,
      ),
    };
  }

  private async loadSource<T extends unknown[]>(
    id: SourceId,
    cache: TtlCache<T>,
    key: string,
    load: () => Promise<T>,
  ): Promise<Loaded<T>> {
    try {
      const result = await cache.getOrLoad(key, load);
      return {
        value: result.value,
        status: status(
          id,
          result.stale ? 'STALE' : 'OK',
          result.fetchedAt.toISOString(),
          result.value.length,
          result.stale ? STALE_NOTE : null,
        ),
      };
    } catch (error) {
      const reason = describeError(error);
      this.logger.warn(`${id} unavailable: ${reason}`);
      return { value: null, status: status(id, 'UNAVAILABLE', null, 0, reason) };
    }
  }

  /* =================================================================== assets */

  /**
   * Warehouses first, then shipments, then suppliers: the order also decides which sites get a
   * weather check when the cell cap is reached, and a company's own buildings matter most.
   */
  private async loadAssets(companyId: string): Promise<ExposureAsset[]> {
    const [warehouses, suppliers, shipments] = await Promise.all([
      this.prisma.warehouse.findMany({
        where: { companyId, isActive: true },
        select: { id: true, code: true, name: true, latitude: true, longitude: true },
        take: MAX_ASSETS_PER_KIND,
      }),
      this.prisma.supplier.findMany({
        where: { companyId, isActive: true, latitude: { not: null }, longitude: { not: null } },
        select: { id: true, code: true, name: true, latitude: true, longitude: true },
        take: MAX_ASSETS_PER_KIND,
      }),
      this.prisma.shipment.findMany({
        where: { companyId, status: { in: [...ACTIVE_SHIPMENT_STATUSES] } },
        select: {
          id: true,
          trackingNumber: true,
          originName: true,
          originLatitude: true,
          originLongitude: true,
          destinationName: true,
          destinationLatitude: true,
          destinationLongitude: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: MAX_ACTIVE_SHIPMENTS,
      }),
    ]);

    const fixes = await this.latestFixes(shipments.map((s) => s.id));

    return [
      ...warehouses.map(
        (w): ExposureAsset => ({
          subjectType: 'WAREHOUSE',
          subjectId: w.id,
          subjectLabel: `${w.name} (${w.code})`,
          latitude: w.latitude,
          longitude: w.longitude,
        }),
      ),
      ...shipments.flatMap((s: ActiveShipment) => shipmentAssetPoints(s, fixes.get(s.id) ?? null)),
      ...suppliers.map(
        (s): ExposureAsset => ({
          subjectType: 'SUPPLIER',
          subjectId: s.id,
          subjectLabel: `${s.name} (${s.code})`,
          latitude: s.latitude as number,
          longitude: s.longitude as number,
        }),
      ),
    ];
  }

  /**
   * Last GPS fix per shipment, one indexed lookup each (shipmentId, recordedAt). Batched so a
   * few hundred shipments do not exhaust the connection pool in one burst.
   */
  private async latestFixes(shipmentIds: string[]): Promise<Map<string, { latitude: number; longitude: number }>> {
    const fixes = new Map<string, { latitude: number; longitude: number }>();
    for (let i = 0; i < shipmentIds.length; i += DB_BATCH) {
      const batch = shipmentIds.slice(i, i + DB_BATCH);
      const rows = await Promise.all(
        batch.map((shipmentId) =>
          this.prisma.gpsPosition.findFirst({
            where: { shipmentId },
            orderBy: { recordedAt: 'desc' },
            select: { shipmentId: true, latitude: true, longitude: true },
          }),
        ),
      );
      for (const row of rows) {
        if (row?.shipmentId) fixes.set(row.shipmentId, { latitude: row.latitude, longitude: row.longitude });
      }
    }
    return fixes;
  }
}

/* ======================================================================== helpers */

function status(
  id: SourceId,
  state: SourceStatus['status'],
  fetchedAt: string | null,
  count: number,
  note: string | null,
): SourceStatus {
  return { id, ...SOURCE_META[id], status: state, fetchedAt, count, note };
}

/** Singular or plural form for a count: French treats 0 and 1 as singular. */
function plural(count: number, singular: string, pluralForm: string): string {
  return Math.abs(count) < 2 ? singular : pluralForm;
}

function disabledFirms(): Loaded<Hazard[]> {
  const note =
    'Facultatif : sans clé, les feux viennent de GDACS et de NASA EONET. Une clé FIRMS gratuite (MAP_KEY) ajoute ' +
    'les points chauds détectés par satellite.';
  return { value: [], status: status('firms', 'DISABLED', null, 0, note) };
}

/**
 * The coverage caveat is always shown: "no storms" must not read as "no storms anywhere". When
 * GDACS answered, it says where the other basins' cyclones come from instead.
 */
function noteNhcCoverage(nhc: SourceStatus, gdacsCoversOtherBasins: boolean): void {
  const coverage = gdacsCoversOtherBasins ? NHC_COVERAGE_WITH_GDACS_NOTE : NHC_COVERAGE_NOTE;
  nhc.note = nhc.note ? `${nhc.note} ${coverage}` : coverage;
}

/**
 * All four edges or none. A half-specified box is a client bug, and guessing the missing edges
 * would silently show the wrong area.
 */
export function parseBoundingBox(query: HazardsQueryDto): BoundingBox | null {
  const edges = [query.minLat, query.minLon, query.maxLat, query.maxLon];
  const given = edges.filter((e) => e !== undefined).length;
  if (given === 0) return null;
  if (given < 4) throw new BadRequestException('Indiquez minLat, minLon, maxLat et maxLon, ou aucun des quatre.');
  const box = query as Required<HazardsQueryDto>;
  if (box.minLat > box.maxLat) throw new BadRequestException('minLat ne doit pas dépasser maxLat.');
  return { minLat: box.minLat, minLon: box.minLon, maxLat: box.maxLat, maxLon: box.maxLon };
}

/** A cyclone offshore whose forecast track enters the view belongs on that map. */
function hazardTouchesBox(hazard: Hazard, box: BoundingBox): boolean {
  if (isInBoundingBox(hazard.latitude, hazard.longitude, box)) return true;
  return (hazard.track ?? []).some((p) => isInBoundingBox(p.latitude, p.longitude, box));
}

/** Upstream errors carry only host and status; anything else is reduced to a generic line. */
function describeError(error: unknown): string {
  if (error instanceof UpstreamError) return error.message;
  if (error instanceof GateFullError) return 'Trop de requêtes en attente pour cette source.';
  return 'La requête vers la source a échoué.';
}

async function mapWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
