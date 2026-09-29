import type { FleetVehicle, VehicleEstimate } from '@/lib/api';

/**
 * The map's picture of "GPS silent, probably here": a dashed circle of uncertainty around the
 * estimate, a dashed connector from the last real fix to it, and a hollow dot at its centre.
 * Kept separate from the vehicle markers so a real position and a guess never look alike.
 */

export const ESTIMATE_SOURCE = 'fleet-estimates';
export const ESTIMATE_AREA = 'fleet-estimates-area';
export const ESTIMATE_OUTLINE = 'fleet-estimates-outline';
export const ESTIMATE_LINK = 'fleet-estimates-link';
export const ESTIMATE_POINT = 'fleet-estimates-point';

const EARTH_RADIUS_KM = 6371;
const CIRCLE_STEPS = 48;

/** A geodesic circle as a polygon ring, good enough at the few-km scale of an estimate. */
export function circleRing(latitude: number, longitude: number, radiusKm: number, steps = CIRCLE_STEPS): number[][] {
  const lat = (latitude * Math.PI) / 180;
  const lon = (longitude * Math.PI) / 180;
  const angular = radiusKm / EARTH_RADIUS_KM;
  const ring: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const bearing = (2 * Math.PI * i) / steps;
    const lat2 = Math.asin(Math.sin(lat) * Math.cos(angular) + Math.cos(lat) * Math.sin(angular) * Math.cos(bearing));
    const lon2 =
      lon +
      Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat), Math.cos(angular) - Math.sin(lat) * Math.sin(lat2));
    ring.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return ring;
}

type Geometry = GeoJSON.Polygon | GeoJSON.LineString | GeoJSON.Point;

export function estimatesGeoJson(vehicles: FleetVehicle[], selectedId: string | null): GeoJSON.FeatureCollection<Geometry> {
  const features: Array<GeoJSON.Feature<Geometry>> = [];
  for (const vehicle of vehicles) {
    const estimate = vehicle.estimated;
    if (!estimate) continue;
    const properties = { vehicleId: vehicle.vehicleId, selected: vehicle.vehicleId === selectedId };
    features.push({
      type: 'Feature',
      properties: { ...properties, part: 'area' },
      geometry: { type: 'Polygon', coordinates: [circleRing(estimate.latitude, estimate.longitude, estimate.radiusKm)] },
    });
    if (vehicle.positionSource === 'gps') {
      features.push({
        type: 'Feature',
        properties: { ...properties, part: 'link' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [vehicle.longitude, vehicle.latitude],
            [estimate.longitude, estimate.latitude],
          ],
        },
      });
      features.push({
        type: 'Feature',
        properties: { ...properties, part: 'point' },
        geometry: { type: 'Point', coordinates: [estimate.longitude, estimate.latitude] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Minutes the GPS has been quiet, or null if it never reported. */
export function silentMinutes(vehicle: Pick<FleetVehicle, 'gpsSilentMinutes'>): number | null {
  return vehicle.gpsSilentMinutes ?? null;
}

export function describeEstimate(estimate: VehicleEstimate): { radius: string; progress: string } {
  return {
    radius: estimate.radiusKm < 10 ? estimate.radiusKm.toFixed(1) : String(Math.round(estimate.radiusKm)),
    progress: String(Math.round(estimate.progress * 100)),
  };
}
