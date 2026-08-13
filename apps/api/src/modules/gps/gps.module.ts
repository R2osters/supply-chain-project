import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ShipmentsModule } from '../shipments/shipments.module';
import { GpsController } from './gps.controller';
import { GpsService } from './gps.service';
import { SpatialRepository } from './spatial.repository';
import { TrackingGateway } from './tracking.gateway';

@Module({
  imports: [JwtModule.register({}), ShipmentsModule],
  controllers: [GpsController],
  providers: [GpsService, SpatialRepository, TrackingGateway],
  exports: [GpsService, SpatialRepository, TrackingGateway],
})
export class GpsModule {}
