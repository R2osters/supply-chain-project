import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import {
  greatCircleNauticalMiles,
  greatCirclePoint,
  greatCircleTrack,
  type LatLng,
} from '@scip/shared';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { MaritimeService } from './maritime.service';
import { AisStreamProvider, SimulatedVesselProvider, type VesselProvider } from './vessel-provider';

/**
 * Simulator tick. Fixed because `@Interval` needs a compile-time constant; how far a vessel moves
 * per tick is governed by the maritime compression factor instead.
 */
const TICK_MS = 10_000;

/**
 * Drives vessel positions from whichever source is configured.
 *
 * With `AISSTREAM_API_KEY` set, this subscribes to the real global AIS feed and every position on
 * the map is a live broadcast from the ship itself. Without it, voyages advance along their
 * great-circle track at a realistic service speed, and every fix is stamped `SIMULATOR`.
 *
 * Both paths funnel through `MaritimeService.recordFix`, so voyage progress, status transitions,
 * ETA and the WebSocket broadcast behave identically. Swapping the source changes where the
 * numbers come from, not what the system does with them — which is the point of the seam.
 */
@Injectable()
export class VesselTrackingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VesselTrackingService.name);

  private provider: VesselProvider;
  private ais: AisStreamProvider | null = null;
  private ticking = false;

  private fixesRecorded = 0;
  private fixesUnmatched = 0;
  private startedAt = new Date();

  private readonly simulatorEnabled: boolean;
  private readonly maritimeMultiplier: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maritime: MaritimeService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    this.simulatorEnabled = this.config.get('simulator', { infer: true }).enabled;
    this.maritimeMultiplier = this.config.get('maritime', { infer: true }).speedMultiplier;
    this.provider = new SimulatedVesselProvider();
  }

  onModuleInit(): void {
    const maritimeConfig = this.config.get('maritime', { infer: true });

    if (!maritimeConfig.aisStreamApiKey) {
      this.logger.warn(
        'No AISSTREAM_API_KEY configured — vessel positions are simulated along great-circle ' +
          'tracks and stamped SIMULATOR. Get a free key at aisstream.io for live global AIS.',
      );
      return;
    }

    this.ais = new AisStreamProvider(
      maritimeConfig.aisStreamApiKey,
      (fix) => {
        void this.maritime
          .recordFix(fix)
          .then((result) => {
            if (result.matched) this.fixesRecorded += 1;
            else this.fixesUnmatched += 1;
          })
          .catch((error) => this.logger.debug(`Could not record AIS fix: ${error}`));
      },
      maritimeConfig.aisBoundingBoxes,
    );

    this.provider = this.ais;
    this.ais.connect();
    this.logger.log('Live AIS tracking enabled');
  }

  onModuleDestroy(): void {
    this.ais?.disconnect();
  }

  status() {
    const uptimeMinutes = Math.round((Date.now() - this.startedAt.getTime()) / 60_000);
    return {
      source: this.provider.name,
      isLive: this.provider.isLive,
      detail: this.provider.describe(),
      fixesRecorded: this.fixesRecorded,
      /**
       * Fixes for vessels nobody here is tracking. On a public feed this is most of them —
       * roughly 100 000 ships are at sea and a company cares about a handful — so a large number
       * is healthy, not a fault.
       */
      fixesForUntrackedVessels: this.fixesUnmatched,
      uptimeMinutes,
      howToGoLive: this.provider.isLive
        ? null
        : 'Set AISSTREAM_API_KEY (free at aisstream.io) and restart the API. Positions then come from the vessels themselves.',
    };
  }

  /**
   * Advances simulated voyages.
   *
   * Runs only when no live AIS feed is configured — a real feed must never be mixed with
   * invented positions for the same vessel, or the track becomes fiction nobody can untangle.
   */
  @Interval(10_000)
  async tick(): Promise<void> {
    if (this.provider.isLive || !this.simulatorEnabled || this.ticking) return;
    this.ticking = true;

    try {
      const voyages = await this.prisma.voyage.findMany({
        where: {
          isDemoData: true,
          // BERTHED is included so a voyage that arrived is picked up and turned around. Leaving
          // it out is what left three ships parked at their destination with 0 nm remaining and
          // nothing to advance them.
          status: { in: ['SCHEDULED', 'LOADING', 'AT_SEA', 'APPROACHING', 'BERTHED'] },
          scheduledDepartureAt: { lte: new Date() },
        },
        include: { vessel: true, originPort: true, destinationPort: true },
        take: 60,
      });

      if (voyages.length === 0) return;

      for (const voyage of voyages) {
        try {
          await this.advance(voyage);
        } catch (error) {
          this.logger.warn(`Simulated voyage ${voyage.id} failed to advance: ${error}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async advance(voyage: {
    id: string;
    vessel: { id: string; mmsi: string | null; imoNumber: string | null; type: string; lastPositionAt: Date | null };
    originPort: { latitude: number; longitude: number };
    destinationPort: { latitude: number; longitude: number };
    scheduledDepartureAt: Date;
    scheduledArrivalAt: Date;
    distanceNm: number | null;
    travelledNm: number;
  }): Promise<void> {
    const from: LatLng = {
      latitude: voyage.originPort.latitude,
      longitude: voyage.originPort.longitude,
    };
    const to: LatLng = {
      latitude: voyage.destinationPort.latitude,
      longitude: voyage.destinationPort.longitude,
    };

    const distanceNm = voyage.distanceNm ?? greatCircleNauticalMiles(from, to);
    if (distanceNm <= 0) return;

    const plannedHours =
      (voyage.scheduledArrivalAt.getTime() - voyage.scheduledDepartureAt.getTime()) / 3_600_000;
    if (plannedHours <= 0) return;

    /*
     * Progress is an accumulated distance stored on the voyage, not a fraction derived from the
     * wall clock.
     *
     * The clock version looked cleaner and was wrong. The seed places each vessel partway along
     * its passage by backdating the departure, so multiplying elapsed real time by the
     * compression factor telescoped a 42 %-complete Atlantic crossing straight to 100 % on the
     * first tick — every ship teleported to its destination port. Advancing `travelledNm` by
     * speed × tick respects wherever the voyage already is, survives a restart (the value is
     * persisted), and makes the compression factor a *rate* rather than a multiplier on elapsed
     * history.
     */
    const nominalKnots = distanceNm / plannedHours;
    // Speed over ground varies with sea state and current; a perfectly constant speed would make
    // the ETA engine's speed blending meaningless.
    const speedKnots = Math.max(0.5, nominalKnots * (0.88 + Math.random() * 0.24));

    const tickHours = (TICK_MS / 3_600_000) * this.maritimeMultiplier;
    const advancedNm = speedKnots * tickHours;

    const travelledNm = Math.min(distanceNm, voyage.travelledNm + advancedNm);
    const fraction = travelledNm / distanceNm;
    // `>=` rather than `>`: a voyage that already sat at full distance before this tick must
    // still be recognised as arrived, or it never turns around.
    const arrived = fraction >= 0.999;

    // A completed voyage leaves its vessel parked at the destination with 0 nm remaining, and
    // after an hour of demo the whole fleet is motionless in port. Real liner services run a
    // rotation, so on arrival the voyage closes and the reverse leg opens. The demo stays alive
    // without anyone re-seeding, and the behaviour mirrors how the trade actually works.
    if (arrived) {
      await this.completeAndTurnAround(voyage);
      return;
    }

    const point = greatCirclePoint(from, to, fraction);
    const ahead = greatCirclePoint(from, to, Math.min(1, fraction + 0.005));
    const course = bearing(point, ahead);

    await this.prisma.voyage.update({
      where: { id: voyage.id },
      data: { travelledNm: Math.round(travelledNm * 10) / 10 },
    });

    await this.maritime.recordFix({
      mmsi: voyage.vessel.mmsi ?? '',
      imoNumber: voyage.vessel.imoNumber,
      latitude: point.latitude,
      longitude: point.longitude,
      speedKnots: Math.round(speedKnots * 10) / 10,
      courseDegrees: Math.round(course * 10) / 10,
      headingDegrees: Math.round(course * 10) / 10,
      draughtM: null,
      navStatus: 'UNDERWAY',
      recordedAt: new Date(),
      source: 'SIMULATOR',
    });
  }

  /** Closes an arrived voyage and opens the return leg, so the simulated fleet keeps sailing. */
  private async completeAndTurnAround(voyage: {
    id: string;
    vessel: { id: string; type: string };
    originPort: { latitude: number; longitude: number };
    destinationPort: { latitude: number; longitude: number };
    distanceNm: number | null;
  }): Promise<void> {
    const current = await this.prisma.voyage.findUnique({
      where: { id: voyage.id },
      select: {
        companyId: true,
        originPortId: true,
        destinationPortId: true,
        voyageNumber: true,
        isDemoData: true,
        distanceNm: true,
        status: true,
      },
    });
    if (!current || current.status === 'COMPLETED') return;

    await this.prisma.voyage.update({
      where: { id: voyage.id },
      data: { status: 'COMPLETED', actualArrivalAt: new Date(), travelledNm: current.distanceNm ?? 0 },
    });

    // Voyage numbers alternate direction the way liner services do: 084W outbound, 085E back.
    const sequence = Number.parseInt(current.voyageNumber.replace(/\D/g, ''), 10) || 1;
    const wasWestbound = current.voyageNumber.toUpperCase().endsWith('W');
    const nextNumber = `${String(sequence + 1).padStart(3, '0')}${wasWestbound ? 'E' : 'W'}`;

    const distanceNm = current.distanceNm ?? 0;
    const speedKnots = { CONTAINER: 18, FEEDER: 15, BULK_CARRIER: 13, REEFER: 19 }[
      voyage.vessel.type
    ] ?? 14;
    const passageHours = distanceNm > 0 ? distanceNm / speedKnots : 24;

    const departure = new Date();
    const track = greatCircleTrack(
      { latitude: voyage.destinationPort.latitude, longitude: voyage.destinationPort.longitude },
      { latitude: voyage.originPort.latitude, longitude: voyage.originPort.longitude },
      64,
    );

    await this.prisma.voyage.create({
      data: {
        companyId: current.companyId,
        vesselId: voyage.vessel.id,
        // Reversed: the ship sails back the way it came.
        originPortId: current.destinationPortId,
        destinationPortId: current.originPortId,
        voyageNumber: nextNumber,
        status: 'AT_SEA',
        scheduledDepartureAt: departure,
        actualDepartureAt: departure,
        scheduledArrivalAt: new Date(departure.getTime() + passageHours * 3_600_000),
        estimatedArrivalAt: new Date(departure.getTime() + passageHours * 3_600_000),
        plannedTrack: track as never,
        distanceNm,
        travelledNm: 0,
        isDemoData: current.isDemoData,
      },
    });

    this.logger.log(
      `Simulated voyage ${current.voyageNumber} completed; return leg ${nextNumber} opened`,
    );
  }
}

/** Initial great-circle bearing, degrees clockwise from true north. */
function bearing(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const dLon = toRad(b.longitude - a.longitude);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
