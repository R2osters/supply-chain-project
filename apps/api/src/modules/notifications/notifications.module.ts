import { Global, Module } from '@nestjs/common';
import { GpsModule } from '../gps/gps.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Global because almost every module raises alerts, and threading this import through a dozen
 * feature modules would add ceremony without adding clarity.
 */
@Global()
@Module({
  imports: [GpsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
