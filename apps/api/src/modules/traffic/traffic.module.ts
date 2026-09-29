import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { FeedSettingsService } from '../settings/feed-settings.service';
import { TrafficController } from './traffic.controller';
import { TrafficService } from './traffic.service';

@Module({
  controllers: [TrafficController],
  providers: [
    {
      provide: TrafficService,
      inject: [ConfigService, FeedSettingsService],
      useFactory: (config: ConfigService<AppConfig, true>, feeds: FeedSettingsService) =>
        new TrafficService(config, undefined, () => feeds.get('tomtomApiKey')),
    },
  ],
  exports: [TrafficService],
})
export class TrafficModule {}
