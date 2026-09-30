import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { JobsModule } from '../jobs/jobs.module';
import { DemoRehearsalService } from './demo-rehearsal.service';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';

@Module({
  imports: [JobsModule, InventoryModule],
  controllers: [SetupController],
  providers: [SetupService, DemoRehearsalService],
  exports: [SetupService],
})
export class SetupModule {}
