import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FeedSettingsService } from './feed-settings.service';
import { NetworkSettingsService } from './network-settings.service';
import { SettingsController } from './settings.controller';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [SettingsController],
  providers: [FeedSettingsService, NetworkSettingsService],
  exports: [FeedSettingsService],
})
export class SettingsModule {}
