/**
 * Public traffic cameras near a truck or a route.
 *
 * The use case is narrow: an operator sees a truck stopped for twenty minutes, or a route flagged
 * as blocked, and wants to look at the road. Six road agencies publish still cameras for free;
 * this service keeps their catalogues in memory and relays single frames on demand.
 *
 * Failure isolation is per pack. Each catalogue sits in its own cache entry with a 15-minute TTL
 * and a 6-hour stale window, and packs are loaded with `allSettled`: Calgary being down leaves
 * London, Finland and the rest on the map, and the pack status list says which one is missing
 * rather than the whole layer going blank.
 *
 * The frame cache is deliberately short (10 s) and small. Its job is not to save bandwidth over
 * time but to collapse a burst: ten dispatchers watching the same junction during an incident
 * cost one upstream request every ten seconds, not ten. Frames live only in memory.
 */
import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TtlCache, haversineKm } from '../../common/http';
import type { AppConfig } from '../../config/configuration';
import { CAMERA_UPSTREAM, type CameraUpstream } from './camera-upstream';
import type {
  Camera,
  CameraFrame,
  CameraList,
  CameraPack,
  CameraRecord,
  PackStatus,
} from './camera.types';
import { parseCameraId, resolveFrameUrl, sniffImageType } from './frame-guard';
import { ALL_CAMERA_PACKS } from './packs';

const CATALOG_TTL_MS = 15 * 60_000;
const CATALOG_STALE_MS = 6 * 3600_000;
const FRAME_TTL_MS = 10_000;
// Bounded so a crawl over every camera cannot pin gigabytes: 64 x 3 MiB worst case, ~10 MB typical.
const FRAME_CACHE_ENTRIES = 64;

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 2000;
export const DEFAULT_RADIUS_KM = 25;

interface PackSnapshot {
  cameras: Camera[];
  byUpstreamId: Map<string, Camera>;
  /** Kept apart from `Camera` so an upstream URL can never be serialised by accident. */
  frameUrls: Map<string, string>;
}

interface PackLoad {
  pack: CameraPack;
  snapshot: PackSnapshot | null;
  status: PackStatus;
}

export interface BoundingBoxQuery {
  minLat?: number;
  minLon?: number;
  maxLat?: number;
  maxLon?: number;
  limit?: number;
}

export interface NearQuery {
  lat: number;
  lon: number;
  radiusKm?: number;
  limit?: number;
}

@Injectable()
export class CamerasService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CamerasService.name);
  private readonly packs: CameraPack[];
  private readonly catalogs = new TtlCache<PackSnapshot>({
    ttlMs: CATALOG_TTL_MS,
    staleMs: CATALOG_STALE_MS,
  });
  private readonly frames = new TtlCache<CameraFrame>({
    ttlMs: FRAME_TTL_MS,
    maxEntries: FRAME_CACHE_ENTRIES,
  });

  constructor(
    config: ConfigService<AppConfig, true>,
    @Inject(CAMERA_UPSTREAM) private readonly upstream: CameraUpstream,
  ) {
    this.packs = selectPacks(config.get('intel', { infer: true }).cameraPacks, this.logger);
  }

  /** Warms the catalogues so the first operator to open the map does not wait on six agencies. */
  onApplicationBootstrap(): void {
    void this.loadAllPacks().catch(() => undefined);
  }

  async listInBoundingBox(query: BoundingBoxQuery): Promise<CameraList> {
    const box = readBoundingBox(query);
    const loads = await this.loadAllPacks();
    const all = loads.flatMap((load) => load.snapshot?.cameras ?? []);
    const inside = box ? all.filter((camera) => isInBox(camera, box)) : all;
    // When the limit truncates, keep the cameras nearest the middle of what the user is looking at.
    const centre = box ? boxCentre(box) : null;
    const ordered = centre
      ? [...inside].sort((a, b) => haversineKm(centre, a) - haversineKm(centre, b))
      : inside;
    return {
      cameras: ordered.slice(0, clampLimit(query.limit)),
      packs: loads.map((load) => load.status),
    };
  }

  async listNear(query: NearQuery): Promise<CameraList> {
    const origin = { latitude: query.lat, longitude: query.lon };
    const radiusKm = query.radiusKm ?? DEFAULT_RADIUS_KM;
    const loads = await this.loadAllPacks();
    const cameras = loads
      .flatMap((load) => load.snapshot?.cameras ?? [])
      .map((camera) => ({ ...camera, distanceKm: round3(haversineKm(origin, camera)) }))
      .filter((camera) => camera.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, clampLimit(query.limit));
    return { cameras, packs: loads.map((load) => load.status) };
  }

  async getCamera(id: string): Promise<Camera> {
    const { camera } = await this.findRegistered(id);
    return camera;
  }

  async getFrame(id: string): Promise<CameraFrame> {
    const { camera, pack, frameUrl } = await this.findRegistered(id);
    const url = resolveFrameUrl(pack, frameUrl);
    if (!url) {
      // A catalogue row that passed the normaliser but fails the fetch-time check means the pack
      // definition and its normaliser disagree. Worth a log line; not worth telling the client.
      this.logger.warn(`Refused frame URL for ${camera.id}: host or scheme not allowed for ${pack.id}`);
      throw new BadGatewayException('This camera frame is not available');
    }
    try {
      const cached = await this.frames.getOrLoad(camera.id, () => this.loadFrame(url, pack));
      return cached.value;
    } catch (error) {
      this.logger.warn(`Frame for ${camera.id} failed: ${describe(error)}`);
      throw new BadGatewayException('The camera provider did not return a picture');
    }
  }

  private async loadFrame(url: URL, pack: CameraPack): Promise<CameraFrame> {
    const bytes = await this.upstream.fetchFrame(url, pack);
    const contentType = sniffImageType(bytes);
    if (!contentType) throw new Error(`${url.hostname} returned bytes that are not a JPEG or PNG`);
    return { bytes, contentType };
  }

  private async findRegistered(
    id: string,
  ): Promise<{ camera: Camera; pack: CameraPack; frameUrl: string }> {
    const parsed = parseCameraId(id);
    const pack = parsed ? this.packs.find((candidate) => candidate.id === parsed.pack) : undefined;
    if (!parsed || !pack) throw new NotFoundException('Unknown camera');
    const load = await this.loadPack(pack);
    const camera = load.snapshot?.byUpstreamId.get(parsed.upstreamId);
    const frameUrl = load.snapshot?.frameUrls.get(parsed.upstreamId);
    if (!camera || !frameUrl) throw new NotFoundException('Unknown camera');
    return { camera, pack, frameUrl };
  }

  private loadAllPacks(): Promise<PackLoad[]> {
    return Promise.all(this.packs.map((pack) => this.loadPack(pack)));
  }

  /** Never rejects: a pack that cannot be loaded comes back UNAVAILABLE with no cameras. */
  private async loadPack(pack: CameraPack): Promise<PackLoad> {
    try {
      const cached = await this.catalogs.getOrLoad(pack.id, () => this.fetchSnapshot(pack));
      return {
        pack,
        snapshot: cached.value,
        status: packStatus(pack, cached.stale ? 'STALE' : 'OK', cached.value.cameras.length, cached.fetchedAt),
      };
    } catch (error) {
      this.logger.warn(`Camera pack ${pack.id} unavailable: ${describe(error)}`);
      return { pack, snapshot: null, status: packStatus(pack, 'UNAVAILABLE', 0, null) };
    }
  }

  private async fetchSnapshot(pack: CameraPack): Promise<PackSnapshot> {
    const raw = await this.upstream.fetchCatalog(pack);
    const records = pack.normalize(raw);
    // An empty catalogue from a pack that normally lists hundreds is an upstream format change or
    // outage. Treating it as a failure keeps the last good catalogue on screen (marked STALE).
    if (records.length === 0) throw new Error(`${pack.id} catalogue produced no usable cameras`);
    return buildSnapshot(pack, records);
  }
}

export function selectPacks(ids: readonly string[], logger?: Logger): CameraPack[] {
  const selected: CameraPack[] = [];
  for (const id of ids) {
    const pack = ALL_CAMERA_PACKS.find((candidate) => candidate.id === id.trim().toLowerCase());
    if (pack && !selected.includes(pack)) selected.push(pack);
    else if (!pack) logger?.warn(`Ignoring unknown camera pack "${id}"`);
  }
  return selected;
}

function buildSnapshot(pack: CameraPack, records: CameraRecord[]): PackSnapshot {
  const cameras: Camera[] = [];
  const byUpstreamId = new Map<string, Camera>();
  const frameUrls = new Map<string, string>();
  for (const record of records) {
    const camera: Camera = {
      id: `${pack.id}:${record.upstreamId}`,
      pack: pack.id,
      name: record.name,
      latitude: record.latitude,
      longitude: record.longitude,
      headingDegrees: record.headingDegrees,
      direction: record.direction,
      refreshSeconds: pack.refreshSeconds,
      attribution: pack.attribution,
    };
    cameras.push(camera);
    byUpstreamId.set(record.upstreamId, camera);
    frameUrls.set(record.upstreamId, record.frameUrl);
  }
  return { cameras, byUpstreamId, frameUrls };
}

function packStatus(
  pack: CameraPack,
  status: PackStatus['status'],
  count: number,
  fetchedAt: Date | null,
): PackStatus {
  return {
    id: pack.id,
    label: pack.label,
    status,
    count,
    fetchedAt: fetchedAt ? fetchedAt.toISOString() : null,
    attribution: pack.attribution,
    licence: pack.licence,
  };
}

interface Box {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** All four bounds or none; a half-specified box is a client bug worth surfacing. */
function readBoundingBox(query: BoundingBoxQuery): Box | null {
  const values = [query.minLat, query.minLon, query.maxLat, query.maxLon];
  const given = values.filter((value) => value !== undefined).length;
  if (given === 0) return null;
  if (given !== 4) throw new BadRequestException('Give all of minLat, minLon, maxLat, maxLon, or none');
  const box = query as Box;
  if (box.minLat > box.maxLat) throw new BadRequestException('minLat must not exceed maxLat');
  return box;
}

/** `minLon > maxLon` is a box across the antimeridian (a map view centred on the Pacific). */
function isInBox(camera: Camera, box: Box): boolean {
  if (camera.latitude < box.minLat || camera.latitude > box.maxLat) return false;
  return box.minLon <= box.maxLon
    ? camera.longitude >= box.minLon && camera.longitude <= box.maxLon
    : camera.longitude >= box.minLon || camera.longitude <= box.maxLon;
}

function boxCentre(box: Box): { latitude: number; longitude: number } {
  const span = box.minLon <= box.maxLon ? box.maxLon - box.minLon : box.maxLon + 360 - box.minLon;
  let longitude = box.minLon + span / 2;
  if (longitude > 180) longitude -= 360;
  return { latitude: (box.minLat + box.maxLat) / 2, longitude };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
