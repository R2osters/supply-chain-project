import { Module } from '@nestjs/common';
import { SatellitesController } from './satellites.controller';
import { SatellitesService } from './satellites.service';

@Module({
  controllers: [SatellitesController],
  providers: [{ provide: SatellitesService, useFactory: () => new SatellitesService() }],
  exports: [SatellitesService],
})
export class SatellitesModule {}
