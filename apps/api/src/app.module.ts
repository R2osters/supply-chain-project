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
  ],
  providers: [
    // Order matters: throttle first (cheapest rejection), then authenticate, then authorise.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
