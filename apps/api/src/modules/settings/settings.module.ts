import { Global, Module } from '@nestjs/common';
import { FeedSettingsService } from './feed-settings.service';
import { SettingsController } from './settings.controller';

@Global()
@Module({
  controllers: [SettingsController],
  providers: [FeedSettingsService],
  exports: [FeedSettingsService],
})
export class SettingsModule {}
