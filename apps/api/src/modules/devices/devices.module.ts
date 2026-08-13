import { Module } from '@nestjs/common';
import { GpsModule } from '../gps/gps.module';
import { DeviceGatewayService } from './device-gateway.service';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

@Module({
  imports: [GpsModule],
  controllers: [DevicesController],
  providers: [DevicesService, DeviceGatewayService],
  exports: [DevicesService, DeviceGatewayService],
})
export class DevicesModule {}
