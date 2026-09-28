import { haversineKm, type LatLon } from '../../common/http';
import { round, severityRank } from './hazard-severity';
import type { Exposure, ExposureSubjectType, Hazard } from './hazard.types';

/**
 * Which of a company's sites and shipments sit inside which hazard's area of concern.
 *
 * A pair counts as exposed when
 *
 *     distance(asset, hazard) ≤ exposureRadiusKm + hazard.radiusKm
 *
 * The hazard's own radius extends the threshold because an M7 earthquake 250 km away matters and
 * a single fire pixel 250 km away does not; a flat radius would get one of those two wrong.
 *
 * For a cyclone, distance is measured to the nearest of its current position and forecast track
 * points: a hurricane forecast to make landfall on a warehouse in 48 hours is exactly the
 * exposure worth knowing about now, while it is still 800 km out to sea.
 *
 * One shipment can contribute several points (last GPS fix, destination). Each hazard/subject pair
 * is reported once, at its closest point.
 */

export interface ExposureAsset {
  subjectType: ExposureSubjectType;
  subjectId: string;
  subjectLabel: string;
  latitude: number;
  longitude: number;
}

export interface ActiveShipment {
  id: string;
  trackingNumber: string;
  originName: string;
  originLatitude: number;
  originLongitude: number;
  destinationName: string;
  destinationLatitude: number;
  destinationLongitude: number;
}

/**
 * Where a shipment can be hit. With a GPS fix: where it is now, and where it is going — a storm
 * sitting on the destination delays delivery as surely as one on the road. Without a fix its
 * position is unknown, so both ends of the trip stand in for it and the label says which.
 */
export function shipmentAssetPoints(shipment: ActiveShipment, lastFix: LatLon | null): ExposureAsset[] {
  const asset = (label: string, point: LatLon): ExposureAsset => ({
    subjectType: 'SHIPMENT',
    subjectId: shipment.id,
    subjectLabel: `${shipment.trackingNumber} — ${label}`,
    latitude: point.latitude,
    longitude: point.longitude,
  });
  const destination = asset(`destination ${shipment.destinationName}`, {
    latitude: shipment.destinationLatitude,
    longitude: shipment.destinationLongitude,
  });
  if (lastFix) return [asset('last GPS fix', lastFix), destination];
  return [
    asset(`origin ${shipment.originName} (no GPS fix)`, {
      latitude: shipment.originLatitude,
      longitude: shipment.originLongitude,
    }),
    destination,
  ];
}

export function computeExposures(assets: ExposureAsset[], hazards: Hazard[], radiusKm: number): Exposure[] {
  const closest = new Map<string, Exposure>();

  for (const hazard of hazards) {
    const threshold = Math.max(0, radiusKm) + Math.max(0, hazard.radiusKm);
    const references = referencePoints(hazard);

    for (const asset of assets) {
      const distanceKm = minimumDistanceKm(asset, references);
      if (distanceKm > threshold) continue;

      const key = `${hazard.id}|${asset.subjectType}|${asset.subjectId}`;
      const existing = closest.get(key);
      if (existing && existing.distanceKm <= distanceKm) continue;

      closest.set(key, {
        hazardId: hazard.id,
        hazardKind: hazard.kind,
        hazardTitle: hazard.title,
        severity: hazard.severity,
        subjectType: asset.subjectType,
        subjectId: asset.subjectId,
        subjectLabel: asset.subjectLabel,
        latitude: asset.latitude,
        longitude: asset.longitude,
        distanceKm: round(distanceKm, 1),
      });
    }
  }

  return sortExposures([...closest.values()]);
}

/** Worst severity first; within a level, nearest first — the order someone should read them in. */
export function sortExposures(exposures: Exposure[]): Exposure[] {
  return exposures.sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.distanceKm - b.distanceKm,
  );
}

function referencePoints(hazard: Hazard): LatLon[] {
  const points: LatLon[] = [{ latitude: hazard.latitude, longitude: hazard.longitude }];
  for (const p of hazard.track ?? []) points.push({ latitude: p.latitude, longitude: p.longitude });
  return points;
}

function minimumDistanceKm(asset: LatLon, references: LatLon[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const ref of references) {
    const d = haversineKm(asset, ref);
    if (d < best) best = d;
  }
  return best;
}
