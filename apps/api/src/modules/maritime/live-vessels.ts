import type { VesselFix } from './vessel-provider';

export interface LiveBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export interface LiveVessel {
  mmsi: string;
  name: string | null;
  latitude: number;
  longitude: number;
  speedKnots: number | null;
  courseDegrees: number | null;
  headingDegrees: number | null;
  navStatus: string | null;
  destination: string | null;
  /** A vessel this install follows (has a voyage), as opposed to traffic passing by. */
  tracked: boolean;
  lastSeenAt: string;
}

/** A ship silent this long has left coverage or switched off; drop it from the map. */
const MAX_AGE_MS = 30 * 60_000;
/** A worldwide AIS stream reaches ~100 000 ships; this bounds memory whatever the feed sends. */
const MAX_VESSELS = 60_000;
const MAX_PER_VIEW = 3_000;

/**
 * Latest position of every ship heard on the live AIS feed, in memory only.
 *
 * The database keeps tracks for the vessels a user follows; the map layer, like God's Eye View,
 * also shows the traffic around them, which nobody needs to store.
 */
export class LiveVesselIndex {
  private readonly vessels = new Map<string, LiveVessel & { seenAt: number }>();
  private readonly tracked = new Set<string>();

  record(fix: VesselFix, now: number = Date.now()): void {
    const previous = this.vessels.get(fix.mmsi);
    this.vessels.delete(fix.mmsi);
    this.vessels.set(fix.mmsi, {
      mmsi: fix.mmsi,
      // Position reports often lack the name; keep the one a static report gave earlier.
      name: fix.name ?? previous?.name ?? null,
      latitude: fix.latitude,
      longitude: fix.longitude,
      speedKnots: fix.speedKnots,
      courseDegrees: fix.courseDegrees,
      headingDegrees: fix.headingDegrees,
      navStatus: fix.navStatus,
      destination: fix.destination ?? previous?.destination ?? null,
      tracked: this.tracked.has(fix.mmsi),
      lastSeenAt: new Date(now).toISOString(),
      seenAt: now,
    });
    if (this.vessels.size > MAX_VESSELS) this.evictOldest();
  }

  markTracked(mmsi: string): void {
    this.tracked.add(mmsi);
    const vessel = this.vessels.get(mmsi);
    if (vessel) vessel.tracked = true;
  }

  inBox(box: LiveBox, now: number = Date.now()): LiveVessel[] {
    const found: LiveVessel[] = [];
    for (const { seenAt, ...vessel } of this.vessels.values()) {
      if (now - seenAt > MAX_AGE_MS) continue;
      if (vessel.latitude < box.minLat || vessel.latitude > box.maxLat) continue;
      if (vessel.longitude < box.minLon || vessel.longitude > box.maxLon) continue;
      found.push(vessel);
      if (found.length >= MAX_PER_VIEW) break;
    }
    return found;
  }

  get size(): number {
    return this.vessels.size;
  }

  clear(): void {
    this.vessels.clear();
  }

  /** Map order is insertion order and `record` re-inserts, so the first entries are the stalest. */
  private evictOldest(): void {
    const excess = this.vessels.size - MAX_VESSELS;
    const keys = this.vessels.keys();
    for (let i = 0; i < excess; i++) this.vessels.delete(keys.next().value as string);
  }
}
