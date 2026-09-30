import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { FeedSettingsService } from '../settings/feed-settings.service';
import { TrafficController } from './traffic.controller';
import { GrenobleFlowProvider } from './open-flow/grenoble-flow.provider';
import { OpenFlowService } from './open-flow/open-flow.service';
import { RennesFlowProvider } from './open-flow/rennes-flow.provider';
import { DEFAULT_DAILY_TILE_BUDGET, TrafficService } from './traffic.service';

@Module({
  controllers: [TrafficController],
  providers: [
    {
      provide: OpenFlowService,
      useFactory: () => new OpenFlowService([new RennesFlowProvider(), new GrenobleFlowProvider()]),
    },
    {
      provide: TrafficService,
      inject: [ConfigService, FeedSettingsService],
      useFactory: (config: ConfigService<AppConfig, true>, feeds: FeedSettingsService) =>
        new TrafficService(
          config,
          undefined,
          () => feeds.get('tomtomApiKey'),
          () => feeds.getTileBudget() ?? config.get('intel', { infer: true }).tomtomDailyTileBudget ?? DEFAULT_DAILY_TILE_BUDGET,
        ),
    },
  ],
  exports: [TrafficService],
})
export class TrafficModule {}
