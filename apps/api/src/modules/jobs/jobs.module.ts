import { Injectable, Logger, Module } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AiModule } from '../ai/ai.module';
import { GpsModule } from '../gps/gps.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PrismaService } from '../../prisma/prisma.service';
import { RecommendationsModule } from '../recommendations/recommendations.module';
import { RecommendationsService } from '../recommendations/recommendations.service';
import { ShipmentsModule } from '../shipments/shipments.module';
import { ShipmentsService } from '../shipments/shipments.service';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SpatialRepository } from '../gps/spatial.repository';
import { TokenService } from '../auth/token.service';
import { AuthModule } from '../auth/auth.module';
import { DevicesModule } from '../devices/devices.module';
import { DevicesService } from '../devices/devices.service';
import { DomainEventWorker } from './domain-event.worker';
import { TelemetrySimulatorService } from './telemetry-simulator.service';

/**
 * Housekeeping that has to happen whether or not anyone is looking at the screen.
 *
 * Everything here is idempotent and logs what it did. Jobs that touch every company iterate
 * tenants explicitly rather than running one cross-tenant query, so a failure in one company's
 * data cannot take down the sweep for everyone else.
 */
@Injectable()
export class ScheduledTasksService {
  private readonly logger = new Logger(ScheduledTasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly inventory: InventoryService,
    private readonly recommendations: RecommendationsService,
    private readonly notifications: NotificationsService,
    private readonly spatial: SpatialRepository,
    private readonly tokens: TokenService,
    private readonly devices: DevicesService,
  ) {}

  private activeCompanies() {
    return this.prisma.company.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
    });
  }

  /** Keeps ETAs fresh for everything on the road, and flips shipments to DELAYED when needed. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async recomputeEtas(): Promise<void> {
    try {
      const result = await this.shipments.recomputeAllActive();
      if (result.recomputed > 0) {
        this.logger.log(`Recomputed ETA for ${result.recomputed} shipment(s)`);
      }
    } catch (error) {
      this.logger.error(`ETA recompute sweep failed: ${error}`);
    }
  }

  /** Warns when a vehicle is within half an hour of a warehouse, so the dock can be ready. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async warnOnApproach(): Promise<void> {
    for (const company of await this.activeCompanies()) {
      try {
        const nearby = await this.spatial.vehiclesNearWarehouses(company.id, 25);
        for (const vehicle of nearby) {
          if (!vehicle.speedKmh || vehicle.speedKmh < 5) continue;
          const minutesAway = (vehicle.distanceKm / vehicle.speedKmh) * 60;
          if (minutesAway > 30) continue;

          await this.notifications.notify({
            companyId: company.id,
            type: 'SHIPMENT_ARRIVING',
            title: `${vehicle.plateNumber} arrive à ${vehicle.warehouseName} dans ~${minutesAway.toFixed(0)} min`,
            body: `À ${vehicle.distanceKm.toFixed(1)} km, roulant à ${vehicle.speedKmh.toFixed(0)} km/h.`,
            target: { entity: 'vehicle', id: vehicle.id },
          });
        }
      } catch (error) {
        this.logger.warn(`Approach sweep failed for ${company.name}: ${error}`);
      }
    }
  }

  /** Re-evaluates every stock alert condition, including expiry. */
  @Cron(CronExpression.EVERY_HOUR)
  async sweepInventoryAlerts(): Promise<void> {
    for (const company of await this.activeCompanies()) {
      try {
        const created = await this.inventory.evaluateExpiryAlerts(company.id);
        if (created > 0) {
          this.logger.log(`${created} expiry alert(s) raised for ${company.name}`);
        }
      } catch (error) {
        this.logger.warn(`Expiry sweep failed for ${company.name}: ${error}`);
      }
    }
  }

  /** Ages out recommendations nobody acted on. */
  @Cron(CronExpression.EVERY_HOUR)
  async expireRecommendations(): Promise<void> {
    try {
      const expired = await this.recommendations.expireStale();
      if (expired > 0) this.logger.log(`Expired ${expired} stale recommendation(s)`);
    } catch (error) {
      this.logger.error(`Recommendation expiry failed: ${error}`);
    }
  }

  /**
   * Marks silent trackers OFFLINE.
   *
   * A device that loses power or coverage never says goodbye — the TCP socket dies without a
   * FIN, or a phone simply stops posting. Without this sweep the devices screen would show a
   * truck as ONLINE indefinitely, which is worse than showing nothing: an operator reads a green
   * dot as "I would know if it stopped".
   *
   * Every minute, because the shortest reporting interval in use is 30 s and the service allows
   * five missed reports before declaring silence; a slower sweep would add its own period on top
   * of that and blunt the signal.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async sweepSilentDevices(): Promise<void> {
    try {
      const marked = await this.devices.sweepOffline();
      if (marked > 0) this.logger.log(`Marked ${marked} silent tracking device(s) offline`);
    } catch (error) {
      this.logger.error(`Device sweep failed: ${error}`);
    }
  }

  /**
   * Nightly retention. GPS history is the table that grows without bound — one vehicle at one
   * fix every five seconds is ~6 million rows a year — so it is trimmed on a schedule rather
   * than left to become an outage.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async nightlyHousekeeping(): Promise<void> {
    try {
      const positions = await this.spatial.purgePositionsOlderThan(180);
      const tokens = await this.tokens.purgeExpired(30);
      const notifications = await this.notifications.purgeOld(90);

      this.logger.log(
        `Housekeeping: removed ${positions} GPS position(s), ${tokens} expired token(s), ` +
          `${notifications} old notification(s)`,
      );
    } catch (error) {
      this.logger.error(`Nightly housekeeping failed: ${error}`);
    }
  }
}

@Module({
  imports: [
    AiModule,
    GpsModule,
    ShipmentsModule,
    InventoryModule,
    SuppliersModule,
    RecommendationsModule,
    AuthModule,
    DevicesModule,
  ],
  providers: [ScheduledTasksService, DomainEventWorker, TelemetrySimulatorService],
  exports: [TelemetrySimulatorService],
})
export class JobsModule {}
