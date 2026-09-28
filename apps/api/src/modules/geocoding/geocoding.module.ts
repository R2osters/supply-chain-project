import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { GeocodingController } from './geocoding.controller';
import { GeocodingService } from './geocoding.service';

@Module({
  controllers: [GeocodingController],
  providers: [
    {
      provide: GeocodingService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => new GeocodingService(config),
    },
  ],
  exports: [GeocodingService],
})
export class GeocodingModule {}
