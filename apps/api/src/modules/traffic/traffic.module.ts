import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { TrafficController } from './traffic.controller';
import { TrafficService } from './traffic.service';

@Module({
  controllers: [TrafficController],
  providers: [
    {
      provide: TrafficService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => new TrafficService(config),
    },
  ],
  exports: [TrafficService],
})
export class TrafficModule {}
