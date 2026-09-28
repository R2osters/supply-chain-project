import { Module } from '@nestjs/common';
import { CAMERA_UPSTREAM, HttpCameraUpstream } from './camera-upstream';
import { CamerasController } from './cameras.controller';
import { CamerasService } from './cameras.service';

/**
 * Public road cameras (TfL, Fintraffic, Ontario 511, DriveBC, Live Traffic NSW, Calgary): catalogue
 * search by area or distance, and a frame relay that only ever fetches server-registered URLs.
 */
@Module({
  controllers: [CamerasController],
  providers: [CamerasService, { provide: CAMERA_UPSTREAM, useClass: HttpCameraUpstream }],
  exports: [CamerasService],
})
export class CamerasModule {}
