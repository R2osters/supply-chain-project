import { Logger } from '@nestjs/common';
import { DEFAULT_USER_AGENT } from '../../common/http';
import { mapNavStatus, type VesselFix } from './vessel-provider';

/**
 * Keyless live AIS for the map: Fintraffic's Digitraffic open data (CC BY 4.0).
 *
 * Global live AIS needs an account somewhere (AISStream, MarineTraffic). Finland publishes the
 * ships its coastal receivers hear — the Baltic Sea, Gulf of Finland and Gulf of Bothnia, about a
 * thousand vessels at any moment — to anyone, without a key. So the live ship layer works the
 * moment SCIP is installed, and an AISStream key, when one is entered, extends it to the world.
 *
 * These fixes feed the map layer only. Tracked voyages keep a single source of truth (the
 * configured provider or the simulator), so a vessel's stored track never mixes two feeds.
 */

export const DIGITRAFFIC_ATTRIBUTION = 'Fintraffic / Digitraffic, CC BY 4.0';

const BASE_URL = 'https://meri.digitraffic.fi/api/ais/v1';
const LOCATIONS_EVERY_MS = 60_000;
/** Names and destinations change rarely; the full list is ~1 000 rows. */
const METADATA_EVERY_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

export interface DigitrafficLocationFeature {
  mmsi?: unknown;
  geometry?: { coordinates?: unknown };
  properties?: { sog?: unknown; cog?: unknown; heading?: unknown; navStat?: unknown; timestampExternal?: unknown };
}

export interface DigitrafficVessel {
  mmsi?: unknown;
  name?: unknown;
  destination?: unknown;
  imo?: unknown;
  draught?: unknown;
}

export interface VesselMetadata {
  name: string | null;
  destination: string | null;
  imoNumber: string | null;
  draughtM: number | null;
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const cleanText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/@+$/, '').trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * One feature of `/locations`. AIS encodes "not available" with sentinel values rather than
 * nulls — speed 102.3, course 360, heading 511 — so they are turned into nulls here.
 */
export function fromDigitrafficLocation(
  feature: DigitrafficLocationFeature,
  metadata: Map<string, VesselMetadata>,
  now: Date = new Date(),
): VesselFix | null {
  const mmsiNumber = finite(feature.mmsi);
  const coordinates = feature.geometry?.coordinates;
  if (mmsiNumber === null || !Array.isArray(coordinates)) return null;
  const longitude = finite(coordinates[0]);
  const latitude = finite(coordinates[1]);
  if (latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  const mmsi = String(mmsiNumber);
  const properties = feature.properties ?? {};
  const sog = finite(properties.sog);
  const cog = finite(properties.cog);
  const heading = finite(properties.heading);
  const navStat = finite(properties.navStat);
  const reportedAt = finite(properties.timestampExternal);
  const meta = metadata.get(mmsi);

  return {
    mmsi,
    imoNumber: meta?.imoNumber ?? null,
    name: meta?.name ?? null,
    latitude,
    longitude,
    speedKnots: sog === null || sog >= 102.3 ? null : sog,
    courseDegrees: cog === null || cog >= 360 ? null : cog,
    headingDegrees: heading === null || heading >= 511 ? null : heading,
    draughtM: meta?.draughtM ?? null,
    navStatus: navStat === null ? null : mapNavStatus(navStat),
    destination: meta?.destination ?? null,
    recordedAt: reportedAt === null ? now : new Date(reportedAt),
    source: 'DIGITRAFFIC',
  };
}

/** `/vessels` rows keyed by MMSI. Draught is published in tenths of a metre. */
export function indexDigitrafficVessels(rows: DigitrafficVessel[]): Map<string, VesselMetadata> {
  const index = new Map<string, VesselMetadata>();
  for (const row of rows) {
    const mmsi = finite(row.mmsi);
    if (mmsi === null) continue;
    const imo = finite(row.imo);
    const draught = finite(row.draught);
    index.set(String(mmsi), {
      name: cleanText(row.name),
      destination: cleanText(row.destination),
      imoNumber: imo && imo > 0 ? String(imo) : null,
      draughtM: draught && draught > 0 ? draught / 10 : null,
    });
  }
  return index;
}

/**
 * Polls Digitraffic and hands every fix to `onFix`. After the first full snapshot it asks only for
 * what changed since the last poll (`from`), which keeps each request small.
 */
export class DigitrafficAmbientFeed {
  private readonly logger = new Logger('DigitrafficAmbientFeed');
  private metadata = new Map<string, VesselMetadata>();
  private metadataAt = 0;
  private lastPollAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastError: string | null = null;
  private fixes = 0;

  constructor(private readonly onFix: (fix: VesselFix) => void) {}

  get active(): boolean {
    return this.running && this.lastError === null && this.fixes > 0;
  }

  describe(): string {
    if (!this.running) return 'stopped';
    if (this.lastError) return `unavailable (${this.lastError})`;
    return `${this.fixes} fixes received`;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), LOCATIONS_EVERY_MS);
    // A poll timer must never keep the process alive on shutdown.
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    try {
      if (Date.now() - this.metadataAt > METADATA_EVERY_MS) await this.refreshMetadata();
      const since = this.lastPollAt;
      const startedAt = Date.now();
      const url = since ? `${BASE_URL}/locations?from=${since - 5_000}` : `${BASE_URL}/locations`;
      const body = (await this.getJson(url)) as { features?: DigitrafficLocationFeature[] };
      for (const feature of body.features ?? []) {
        const fix = fromDigitrafficLocation(feature, this.metadata);
        if (!fix) continue;
        this.fixes += 1;
        this.onFix(fix);
      }
      this.lastPollAt = startedAt;
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Digitraffic AIS unavailable: ${this.lastError}`);
    }
  }

  private async refreshMetadata(): Promise<void> {
    const rows = (await this.getJson(`${BASE_URL}/vessels`)) as DigitrafficVessel[];
    if (Array.isArray(rows)) {
      this.metadata = indexDigitrafficVessels(rows);
      this.metadataAt = Date.now();
    }
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await fetch(url, {
      // Digitraffic asks every client to identify itself.
      headers: { 'Digitraffic-User': 'SCIP desktop', 'User-Agent': DEFAULT_USER_AGENT, 'Accept-Encoding': 'gzip' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
}
