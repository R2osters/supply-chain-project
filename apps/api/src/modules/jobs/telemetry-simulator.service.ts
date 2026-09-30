import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import {
  bearingDegrees,
  haversineKm,
  interpolateAlongPolyline,
  polylineLengthMeters,
  type LatLng,
} from '@scip/shared';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { TrackingGateway } from '../gps/tracking.gateway';

/** Pace for a shipment without a usable planned window. */
const DEFAULT_CRUISE_KMH = 55;
/**
 * The fastest a simulated truck drives. The pace otherwise follows the plan, and a plan can be
 * impossible on purpose: the demo rehearsal promises two 250 km trips in five minutes so the ETA
 * engine has a real delay to detect. Followed literally, that promise would move the truck at
 * 3 000 km/h and end the delay before anyone saw it.
 */
export const MAX_CRUISE_KMH = 90;
/** How long a rehearsal waits for a tick already in flight before going ahead anyway. */
const PAUSE_WAIT_MS = 10_000;

/** The simulation's cruising speed: the plan's own pace, within what a truck can do. */
export function cruiseSpeedKmh(routeKm: number, plannedHours: number): number {
  const planned = plannedHours > 0 ? routeKm / plannedHours : DEFAULT_CRUISE_KMH;
  return Math.min(MAX_CRUISE_KMH, planned);
}

/**
 * Telemetry simulator — **DEMO DATA**.
 *
 * There is no GPS hardware attached to this deployment, so without something driving the map the
 * live-tracking half of the product would be an empty screen. This service moves vehicles along
 * their shipments' planned routes and writes real GPS rows, which then flow through the real
 * ingest path: the same ETA engine, the same anomaly detector, the same WebSocket broadcast.
 *
 * Every row it writes is marked `isSimulated = true`, the UI badges them, and analytics can
 * exclude them. Nothing synthetic is ever presented as real. The moment a physical tracker POSTs
 * to `/telemetry/gps`, its fixes are stored with `isSimulated = false` and the two are
 * distinguishable forever.
 *
 * The motion is not a straight interpolation. Real vehicles vary their speed, occasionally stop,
 * and drift a little off the centre line, and a simulator that produces a perfect line would make
 * the anomaly detector look good for the wrong reason — it would never see anything to detect.
 * So: speed noise, a small chance of a stop, and lateral jitter within the corridor. One vehicle
 * in twenty is deliberately given a genuine route deviation so the detector has something true to
 * find.
 */
@Injectable()
export class TelemetrySimulatorService {
  private readonly logger = new Logger(TelemetrySimulatorService.name);

  private readonly enabled: boolean;
  private readonly speedMultiplier: number;
  private readonly tickMs: number;

  /** Per-shipment simulation state, kept in memory — it is reconstructible from the track. */
  private readonly state = new Map<
    string,
    { progress: number; stoppedTicks: number; deviating: boolean }
  >();

  private ticking = false;
  /** Callers inside `pauseWhile`; ticks are skipped while any is running. */
  private paused = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly gateway: TrackingGateway,
    config: ConfigService<AppConfig, true>,
  ) {
    const simulator = config.get('simulator', { infer: true });
    this.enabled = simulator.enabled;
    this.speedMultiplier = simulator.speedMultiplier;
    this.tickMs = simulator.tickMs;

    if (this.enabled) {
      this.logger.warn(
        `Telemetry simulator ON — every position it writes is marked DEMO DATA. ` +
          `Tick ${this.tickMs}ms, time compression ×${this.speedMultiplier}. ` +
          'Set SIMULATOR_ENABLED=false to disable.',
      );
    }
  }

  /**
   * Fixed 5-second interval rather than the configured tick, because @Interval needs a compile-
   * time constant. The configured `tickMs` scales how far a vehicle moves per tick instead.
   */
  @Interval(5000)
  async tick(): Promise<void> {
    if (!this.enabled || this.ticking || this.paused > 0) return;
    this.ticking = true;

    try {
      const shipments = await this.prisma.shipment.findMany({
        where: {
          isDemoData: true,
          status: { in: ['DEPARTED', 'IN_TRANSIT', 'DELAYED'] },
          vehicleId: { not: null },
        },
        include: { route: true },
        take: 100,
      });

      for (const shipment of shipments) {
        try {
          await this.advance(shipment);
        } catch (error) {
          this.logger.warn(`Simulator failed on shipment ${shipment.id}: ${error}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async advance(shipment: {
    id: string;
    companyId: string;
    vehicleId: string | null;
    originLatitude: number;
    originLongitude: number;
    destinationLatitude: number;
    destinationLongitude: number;
    plannedDistanceKm: number;
    plannedDepartureAt: Date;
    plannedArrivalAt: Date;
    isDemoData: boolean;
    route: { polyline: unknown } | null;
  }): Promise<void> {
    if (!shipment.vehicleId) return;

    const polyline: LatLng[] = shipment.route
      ? (shipment.route.polyline as LatLng[])
      : [
          { latitude: shipment.originLatitude, longitude: shipment.originLongitude },
          { latitude: shipment.destinationLatitude, longitude: shipment.destinationLongitude },
        ];

    if (polyline.length < 2) return;

    const state =
      this.state.get(shipment.id) ??
      // One shipment in twenty gets a real route deviation, so the anomaly detector has
      // something genuine to find rather than only ever confirming a clean track.
      { progress: 0, stoppedTicks: 0, deviating: Math.random() < 0.05 };

    // A stopped vehicle stays stopped for a few ticks — a single stationary fix reads as noise,
    // a run of them reads as a stop, which is what the detector is looking for.
    if (state.stoppedTicks > 0) {
      state.stoppedTicks -= 1;
      this.state.set(shipment.id, state);
      await this.writeFix(shipment, polyline, state, 0);
      return;
    }
    if (Math.random() < 0.03) {
      state.stoppedTicks = 3 + Math.floor(Math.random() * 8);
      this.state.set(shipment.id, state);
      await this.writeFix(shipment, polyline, state, 0);
      return;
    }

    const plannedHours =
      (shipment.plannedArrivalAt.getTime() - shipment.plannedDepartureAt.getTime()) / 3_600_000;
    const routeKm = polylineLengthMeters(polyline) / 1000;
    const nominalSpeed = cruiseSpeedKmh(routeKm, plannedHours);

    // Speed varies ±25 % around nominal, so the observed average is not a constant and the ETA
    // engine's speed blending has something real to work with.
    const speedKmh = Math.max(5, nominalSpeed * (0.75 + Math.random() * 0.5));

    const tickHours = (this.tickMs / 3_600_000) * this.speedMultiplier;
    const advancedKm = speedKmh * tickHours;
    state.progress = Math.min(1, state.progress + (routeKm > 0 ? advancedKm / routeKm : 1));

    this.state.set(shipment.id, state);
    await this.writeFix(shipment, polyline, state, speedKmh);

    if (state.progress >= 1) {
      await this.arrive(shipment);
    }
  }

  private async writeFix(
    shipment: { id: string; companyId: string; vehicleId: string | null; isDemoData: boolean },
    polyline: LatLng[],
    state: { progress: number; deviating: boolean },
    speedKmh: number,
  ): Promise<void> {
    if (!shipment.vehicleId) return;

    const point = interpolateAlongPolyline(polyline, state.progress);
    const ahead = interpolateAlongPolyline(polyline, Math.min(1, state.progress + 0.01));
    const heading = bearingDegrees(point, ahead);

    // Lateral noise: ~50 m normally (GPS error plus lane position), or several kilometres for
    // the shipments deliberately sent off-corridor.
    const jitterDegrees = state.deviating && state.progress > 0.3 ? 0.05 : 0.0005;
    const latitude = point.latitude + (Math.random() - 0.5) * jitterDegrees;
    const longitude = point.longitude + (Math.random() - 0.5) * jitterDegrees;

    const recordedAt = new Date();

    await this.prisma.gpsPosition.create({
      data: {
        vehicleId: shipment.vehicleId,
        shipmentId: shipment.id,
        latitude,
        longitude,
        speedKmh: Math.round(speedKmh * 10) / 10,
        headingDegrees: Math.round(heading * 10) / 10,
        accuracyM: 5 + Math.random() * 10,
        isSimulated: true,
        recordedAt,
      },
    });

    await this.prisma.vehicle.update({
      where: { id: shipment.vehicleId },
      data: {
        lastLatitude: latitude,
        lastLongitude: longitude,
        lastSpeedKmh: Math.round(speedKmh * 10) / 10,
        lastHeadingDegrees: Math.round(heading * 10) / 10,
        lastPositionAt: recordedAt,
      },
    });

    this.gateway.emitPosition(shipment.companyId, shipment.id, {
      vehicleId: shipment.vehicleId,
      shipmentId: shipment.id,
      latitude,
      longitude,
      speedKmh: Math.round(speedKmh * 10) / 10,
      headingDegrees: Math.round(heading * 10) / 10,
      recordedAt: recordedAt.toISOString(),
      isSimulated: true,
    });
  }

  private async arrive(shipment: { id: string; companyId: string }): Promise<void> {
    this.state.delete(shipment.id);

    const current = await this.prisma.shipment.findUnique({
      where: { id: shipment.id },
      select: { status: true, travelledDistanceKm: true },
    });
    if (!current || !['DEPARTED', 'IN_TRANSIT', 'DELAYED'].includes(current.status)) return;

    await this.prisma.$transaction(async (tx) => {
      await tx.shipment.update({
        where: { id: shipment.id },
        data: { status: 'ARRIVED', actualArrivalAt: new Date() },
      });
      await tx.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          type: 'ARRIVED',
          description: 'Vehicle reached the destination (simulated telemetry)',
          fromStatus: current.status,
          toStatus: 'ARRIVED',
          isDemoData: true,
        },
      });
    });

    this.gateway.emitShipmentUpdate(shipment.companyId, shipment.id, {
      shipmentId: shipment.id,
      status: 'ARRIVED',
    });

    this.logger.log(`Simulated shipment ${shipment.id} arrived`);
  }

  /** Drops the progress of these shipments: their next tick starts again from the origin. */
  forget(shipmentIds: string[]): void {
    for (const id of shipmentIds) this.state.delete(id);
  }

  /**
   * Runs `work` with no tick in flight and none starting until it returns. A tick reads its
   * shipments first and writes a few awaits later: running beside a rewrite of those shipments,
   * it would put back a fix the rewrite deleted, or restore progress `forget` just dropped, or
   * mark as arrived a shipment that was just sent back to its origin.
   */
  async pauseWhile<T>(work: () => Promise<T>): Promise<T> {
    this.paused += 1;
    try {
      const deadline = Date.now() + PAUSE_WAIT_MS;
      while (this.ticking && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return await work();
    } finally {
      this.paused -= 1;
    }
  }

  /** Recomputes ETAs for simulated shipments so the map's countdown stays live. */
  @Interval(30_000)
  async refreshEtas(): Promise<void> {
    if (!this.enabled) return;

    const shipments = await this.prisma.shipment.findMany({
      where: { isDemoData: true, status: { in: ['DEPARTED', 'IN_TRANSIT', 'DELAYED'] } },
      select: { id: true },
      take: 100,
    });

    for (const { id } of shipments) {
      try {
        await this.shipments.computeCurrentEta(id);
      } catch (error) {
        this.logger.debug(`ETA refresh skipped for ${id}: ${error}`);
      }
    }
  }
}
