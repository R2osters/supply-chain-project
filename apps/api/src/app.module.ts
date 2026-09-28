import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { join } from 'node:path';
import configuration, { type AppConfig } from './config/configuration';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { PrismaModule } from './prisma/prisma.module';
import { MailModule } from './modules/mail/mail.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { MasterDataModule } from './modules/master-data/master-data.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { EventsModule } from './modules/events/events.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { PurchaseOrdersModule } from './modules/purchase-orders/purchase-orders.module';
import { ShipmentsModule } from './modules/shipments/shipments.module';
import { GpsModule } from './modules/gps/gps.module';
import { AiModule } from './modules/ai/ai.module';
import { StorageModule } from './modules/storage/storage.module';
import { DeliveriesModule } from './modules/deliveries/deliveries.module';
import { IncidentsModule } from './modules/incidents/incidents.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { RecommendationsModule } from './modules/recommendations/recommendations.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { MaritimeModule } from './modules/maritime/maritime.module';
import { DevicesModule } from './modules/devices/devices.module';
import { CamerasModule } from './modules/cameras/cameras.module';
import { GeocodingModule } from './modules/geocoding/geocoding.module';
import { SatellitesModule } from './modules/satellites/satellites.module';
import { RadioModule } from './modules/radio/radio.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      // The repo root .env is the single file for the whole stack; apps/api/.env overrides it
      // when present, which is what the e2e suite uses to point at a scratch database.
      envFilePath: [join(process.cwd(), '.env'), join(process.cwd(), '..', '..', '.env')],
      cache: true,
    }),

    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const throttle = config.get('throttle', { infer: true });
        return {
          throttlers: [{ name: 'default', ttl: throttle.ttlSeconds * 1000, limit: throttle.limit }],
        };
      },
    }),

    ScheduleModule.forRoot(),

    PrismaModule,
    EventsModule,
    MailModule,
    AuthModule,
    HealthModule,
    MasterDataModule,
    SuppliersModule,
    InventoryModule,
    PurchaseOrdersModule,
    ShipmentsModule,
    GpsModule,
    StorageModule,
    NotificationsModule,
    AiModule,
    DeliveriesModule,
    IncidentsModule,
    AnalyticsModule,
    RecommendationsModule,
    MaritimeModule,
    DevicesModule,
    CamerasModule,
    RadioModule,
    SatellitesModule,
    GeocodingModule,
    // Last: it depends on almost everything above.
    JobsModule,
  ],
  providers: [
    // Order matters: throttle first (cheapest rejection), then authenticate, then authorise.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
