import { haversineKm } from '../../common/http';
import { equalAreaRadiusKm } from './hazard-severity';
import type { EonetFire } from './sources/eonet-wildfires';
import { burnedAreaHa, type GdacsEvent } from './sources/gdacs-events';

/**
 * Where two keyless feeds describe the same thing, one copy is dropped before the map, the
 * exposure list or the risk engine sees it. Two rules, both documented in docs/intel/hazards.md.
 *
 * Cyclones. NHC is the reference inside its basins — the North Atlantic and the eastern and
 * central North Pacific, i.e. north of the equator and west of the prime meridian — because it
 * publishes the forecast track and cone, and GDACS only a position. GDACS cyclones there are
 * dropped whenever NHC answered (fresh or stale); when NHC is down they are kept, so a hurricane
 * never vanishes from the map because one feed failed. Everywhere else (West Pacific, Indian
 * Ocean, Southern Hemisphere) GDACS is the only cyclone source.
 *
 * Fires, only without a FIRMS key. A GDACS forest fire and an EONET wildfire are one fire when
 *
 *     distance ≤ max(15 km, r(GDACS area) + r(EONET area) + 5 km)   (r: radius of a disc of that area)
 *
 * and their dates overlap, give or take three days. The copy with the better geometry is kept: a
 * perimeter polygon beats a multi-day track, which beats a point with a measured size, which beats
 * a bare point. On a tie GDACS is kept — its alert weighs the exposed population, and its report
 * page is public. The kept hazard names the other copy in `details.sameFireAs`.
 */

/** North of the equator and west of 0°: the Atlantic, eastern and central North Pacific. */
export function isInNhcBasin(latitude: number, longitude: number): boolean {
  return latitude >= 0 && longitude < 0;
}

export function outsideNhcBasins(events: GdacsEvent[]): GdacsEvent[] {
  return events.filter((event) => event.type !== 'TC' || !isInNhcBasin(event.latitude, event.longitude));
}

const DAY_MS = 86_400_000;
const SAME_FIRE_MIN_KM = 15;
const SAME_FIRE_MARGIN_KM = 5;
const SAME_FIRE_SLACK_MS = 3 * DAY_MS;

/** 0 bare point · 1 point with a measured size · 2 multi-day track · 3 perimeter polygon. */
export function gdacsGeometryRank(event: GdacsEvent): number {
  // The search answer carries the burned area's centroid, never its perimeter.
  return burnedAreaHa(event) === null ? 0 : 1;
}

export function eonetGeometryRank(fire: EonetFire): number {
  if (fire.polygon) return 3;
  if (fire.observations > 1) return 2;
  return fire.areaHa === null ? 0 : 1;
}

export function isSameFire(gdacs: GdacsEvent, eonet: EonetFire): boolean {
  const gdacsHa = burnedAreaHa(gdacs);
  const reach =
    equalAreaRadiusKm((gdacsHa ?? 0) / 100) + equalAreaRadiusKm((eonet.areaHa ?? 0) / 100) + SAME_FIRE_MARGIN_KM;
  if (haversineKm(gdacs, eonet) > Math.max(SAME_FIRE_MIN_KM, reach)) return false;
  const overlaps =
    Date.parse(eonet.firstSeenAt) <= Date.parse(gdacs.toDate) + SAME_FIRE_SLACK_MS &&
    Date.parse(eonet.lastSeenAt) >= Date.parse(gdacs.fromDate) - SAME_FIRE_SLACK_MS;
  return overlaps;
}

export interface MergedFires {
  gdacs: GdacsEvent[];
  eonet: EonetFire[];
  /** Kept hazard id → id of the copy dropped in its favour. */
  sameFire: Map<string, string>;
}

/**
 * Applies the fire rule. Only GDACS forest fires take part; every other GDACS event passes
 * through untouched, in order. An EONET fire is compared with its nearest matching GDACS fire.
 */
export function mergeKeylessFires(gdacs: GdacsEvent[], eonet: EonetFire[]): MergedFires {
  const gdacsFires = gdacs.filter((event) => event.type === 'WF');
  const droppedGdacs = new Set<GdacsEvent>();
  const keptEonet: EonetFire[] = [];
  const sameFire = new Map<string, string>();

  for (const fire of eonet) {
    const match = gdacsFires
      .filter((candidate) => isSameFire(candidate, fire))
      .sort((a, b) => haversineKm(a, fire) - haversineKm(b, fire))[0];
    if (!match) {
      keptEonet.push(fire);
      continue;
    }
    const gdacsId = `gdacs:WF:${match.eventId}`;
    const eonetId = `eonet:${fire.id}`;
    if (eonetGeometryRank(fire) > gdacsGeometryRank(match)) {
      droppedGdacs.add(match);
      keptEonet.push(fire);
      sameFire.set(eonetId, gdacsId);
    } else if (!droppedGdacs.has(match)) {
      sameFire.set(gdacsId, eonetId);
    }
    // Otherwise the GDACS copy already gave way to another EONET fire that covers this one.
  }

  return { gdacs: gdacs.filter((event) => !droppedGdacs.has(event)), eonet: keptEonet, sameFire };
}
