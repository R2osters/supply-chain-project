import type { LatLng } from '@scip/shared';
import {
  estimatePosition,
  GPS_SILENT_AFTER_MINUTES,
  parsePolyline,
  type PositionEstimate,
} from './dead-reckoning';

/** One vehicle as `SpatialRepository.fleetSnapshot` returns it. */
export interface FleetRow {
  vehicleId: string;
  plateNumber: string;
  label: string | null;
  type: string;
  status: string;
  latitude: number | null;
  longitude: number | null;
  speedKmh: number | null;
  headingDegrees: number | null;
  lastPositionAt: Date | null;
  shipmentId: string | null;
  trackingNumber: string | null;
  shipmentStatus: string | null;
  destinationName: string | null;
  estimatedArrivalAt: Date | null;
  delayProbability: number | null;
  driverName: string | null;
  isDemoData: boolean;
  nominalSpeedKmh: number;
  originLatitude: number | null;
  originLongitude: number | null;
  destinationLatitude: number | null;
  destinationLongitude: number | null;
  departedAt: Date | null;
  routePolyline: unknown;
  routeDurationMinutes: number | null;
}

type EstimationFields =
  | 'nominalSpeedKmh'
  | 'originLatitude'
  | 'originLongitude'
  | 'destinationLatitude'
  | 'destinationLongitude'
  | 'departedAt'
  | 'routePolyline'
  | 'routeDurationMinutes';

/** What the live map receives: the row without its estimation inputs, always placed. */
export type FleetVehicle = Omit<FleetRow, EstimationFields | 'latitude' | 'longitude'> & {
  latitude: number;
  longitude: number;
  /** `estimated` only when the vehicle never reported and is placed at its estimate. */
  positionSource: 'gps' | 'estimated';
  /** Minutes since the last fix; null when there has never been one. */
  gpsSilentMinutes: number | null;
  /** Probable position along the planned route while the GPS is silent. */
  estimated: PositionEstimate | null;
};

const ON_THE_ROAD = new Set(['DEPARTED', 'IN_TRANSIT', 'DELAYED']);

/**
 * Adds the dead-reckoning estimate to a fleet row. Returns null for a vehicle that has neither a
 * fix nor anything to estimate from, so it is left off the map rather than drawn at 0,0.
 */
export function toFleetVehicle(row: FleetRow, now: Date): FleetVehicle | null {
  const {
    nominalSpeedKmh,
    originLatitude,
    originLongitude,
    destinationLatitude,
    destinationLongitude,
    departedAt,
    routePolyline,
    routeDurationMinutes,
    latitude,
    longitude,
    ...rest
  } = row;

  const gpsSilentMinutes = row.lastPositionAt
    ? Math.floor((now.getTime() - row.lastPositionAt.getTime()) / 60_000)
    : null;
  const onTheRoad = row.shipmentStatus !== null && ON_THE_ROAD.has(row.shipmentStatus);
  const quiet = gpsSilentMinutes === null || gpsSilentMinutes >= GPS_SILENT_AFTER_MINUTES;
  const hasFix = latitude !== null && longitude !== null && row.lastPositionAt !== null;

  let estimated: PositionEstimate | null = null;
  if (onTheRoad && quiet && departedAt) {
    const planned = parsePolyline(routePolyline);
    const straight: LatLng[] =
      originLatitude !== null && originLongitude !== null && destinationLatitude !== null && destinationLongitude !== null
        ? [
            { latitude: originLatitude, longitude: originLongitude },
            { latitude: destinationLatitude, longitude: destinationLongitude },
          ]
        : [];
    const usePlanned = planned.length >= 2;
    estimated = estimatePosition({
      path: usePlanned ? planned : straight,
      now,
      departedAt,
      lastFix: hasFix ? { position: { latitude: latitude!, longitude: longitude! }, at: row.lastPositionAt! } : null,
      nominalSpeedKmh,
      // A route's duration describes its own polyline, not the straight line.
      plannedDurationMinutes: usePlanned ? routeDurationMinutes : null,
    });
  }

  if (hasFix) {
    return { ...rest, latitude: latitude!, longitude: longitude!, positionSource: 'gps', gpsSilentMinutes, estimated };
  }
  if (!estimated) return null;
  return {
    ...rest,
    latitude: estimated.latitude,
    longitude: estimated.longitude,
    positionSource: 'estimated',
    gpsSilentMinutes,
    estimated,
  };
}
