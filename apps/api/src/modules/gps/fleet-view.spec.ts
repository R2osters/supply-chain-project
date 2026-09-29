import { type FleetRow, toFleetVehicle } from './fleet-view';

const NOW = new Date(Date.UTC(2026, 8, 29, 10, 0));
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function row(overrides: Partial<FleetRow> = {}): FleetRow {
  return {
    vehicleId: 'v1',
    plateNumber: 'GT-1000-24',
    label: null,
    type: 'TRUCK_MEDIUM',
    status: 'IN_USE',
    latitude: 5.6037,
    longitude: -0.187,
    speedKmh: 60,
    headingDegrees: 300,
    lastPositionAt: minutesAgo(1),
    shipmentId: 's1',
    trackingNumber: 'SHP-1',
    shipmentStatus: 'IN_TRANSIT',
    destinationName: 'Kumasi',
    estimatedArrivalAt: null,
    delayProbability: null,
    driverName: null,
    isDemoData: false,
    nominalSpeedKmh: 60,
    originLatitude: 5.6037,
    originLongitude: -0.187,
    destinationLatitude: 6.6885,
    destinationLongitude: -1.6244,
    departedAt: minutesAgo(120),
    routePolyline: null,
    routeDurationMinutes: null,
    ...overrides,
  };
}

describe('toFleetVehicle', () => {
  it('leaves a vehicle with a fresh fix alone', () => {
    const vehicle = toFleetVehicle(row(), NOW)!;
    expect(vehicle.positionSource).toBe('gps');
    expect(vehicle.estimated).toBeNull();
    expect(vehicle.gpsSilentMinutes).toBe(1);
    expect(vehicle).not.toHaveProperty('routePolyline');
  });

  it('adds an estimate ahead of the last fix once the GPS has been quiet', () => {
    const vehicle = toFleetVehicle(row({ lastPositionAt: minutesAgo(30) }), NOW)!;
    expect(vehicle.positionSource).toBe('gps');
    expect(vehicle.latitude).toBe(5.6037);
    expect(vehicle.estimated).toMatchObject({ basis: 'last-fix', minutesSinceBasis: 30 });
    expect(vehicle.estimated!.progress).toBeGreaterThan(0);
  });

  it('places a vehicle that never reported at its estimate from departure', () => {
    const vehicle = toFleetVehicle(row({ latitude: null, longitude: null, lastPositionAt: null }), NOW)!;
    expect(vehicle.positionSource).toBe('estimated');
    expect(vehicle.gpsSilentMinutes).toBeNull();
    expect(vehicle.estimated).toMatchObject({ basis: 'departure' });
    expect(vehicle.latitude).toBe(vehicle.estimated!.latitude);
  });

  it('prefers the planned route polyline over the straight line', () => {
    const polyline = [
      { latitude: 5.6037, longitude: -0.187 },
      { latitude: 6.0, longitude: -0.3 },
      { latitude: 6.6885, longitude: -1.6244 },
    ];
    const vehicle = toFleetVehicle(
      row({ latitude: null, longitude: null, lastPositionAt: null, routePolyline: polyline, routeDurationMinutes: 300 }),
      NOW,
    )!;
    expect(vehicle.estimated!.assumedSpeedKmh).toBeGreaterThan(40);
    expect(vehicle.estimated!.assumedSpeedKmh).toBeLessThan(60);
  });

  it('does not estimate for a parked vehicle or one without anything to estimate from', () => {
    expect(toFleetVehicle(row({ shipmentStatus: null, lastPositionAt: minutesAgo(30) }), NOW)!.estimated).toBeNull();
    expect(
      toFleetVehicle(row({ latitude: null, longitude: null, lastPositionAt: null, departedAt: null }), NOW),
    ).toBeNull();
  });
});
