import { describe, expect, it } from 'vitest';
import type { FleetVehicle } from '@/lib/api';
import { circleRing, describeEstimate, estimatesGeoJson } from './estimates';

const estimate = {
  latitude: 6.0,
  longitude: -1.0,
  radiusKm: 4.2,
  progress: 0.456,
  basis: 'last-fix' as const,
  minutesSinceBasis: 30,
  assumedSpeedKmh: 50,
  atDestination: false,
};

function vehicle(overrides: Partial<FleetVehicle> = {}): FleetVehicle {
  return {
    vehicleId: 'v1',
    plateNumber: 'GT-1',
    label: null,
    type: 'TRUCK_MEDIUM',
    status: 'IN_USE',
    latitude: 5.9,
    longitude: -0.9,
    speedKmh: null,
    headingDegrees: null,
    lastPositionAt: '2026-09-29T09:30:00Z',
    shipmentId: null,
    trackingNumber: null,
    shipmentStatus: 'IN_TRANSIT',
    destinationName: null,
    estimatedArrivalAt: null,
    delayProbability: null,
    driverName: null,
    isDemoData: false,
    positionSource: 'gps',
    gpsSilentMinutes: 30,
    estimated: estimate,
    ...overrides,
  };
}

describe('estimates layer', () => {
  it('draws a closed circle whose points sit at the radius', () => {
    const ring = circleRing(6, -1, 10, 16);
    expect(ring).toHaveLength(17);
    expect(ring[0]).toEqual(ring[16]);
    // 10 km north is ~0.09° of latitude.
    expect(ring[0][1] - 6).toBeCloseTo(0.0899, 3);
  });

  it('adds area, connector and centre for a vehicle whose GPS went quiet', () => {
    const parts = estimatesGeoJson([vehicle()], 'v1').features.map((f) => f.properties?.part);
    expect(parts).toEqual(['area', 'link', 'point']);
  });

  it('draws only the area when the vehicle itself sits at its estimate', () => {
    const parts = estimatesGeoJson([vehicle({ positionSource: 'estimated' })], null).features.map((f) => f.properties?.part);
    expect(parts).toEqual(['area']);
  });

  it('skips vehicles with a live fix', () => {
    expect(estimatesGeoJson([vehicle({ estimated: null })], null).features).toHaveLength(0);
  });

  it('formats radius and progress for the card', () => {
    expect(describeEstimate(estimate)).toEqual({ radius: '4.2', progress: '46' });
    expect(describeEstimate({ ...estimate, radiusKm: 23.7 })).toEqual({ radius: '24', progress: '46' });
  });
});
