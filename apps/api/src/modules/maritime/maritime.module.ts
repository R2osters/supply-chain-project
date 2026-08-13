import { Module } from '@nestjs/common';
import { GpsModule } from '../gps/gps.module';
import { MaritimeController } from './maritime.controller';
import { MaritimeService } from './maritime.service';
import { VesselTrackingService } from './vessel-tracking.service';

@Module({
  imports: [GpsModule],
  controllers: [MaritimeController],
  providers: [MaritimeService, VesselTrackingService],
  exports: [MaritimeService, VesselTrackingService],
})
export class MaritimeModule {}
