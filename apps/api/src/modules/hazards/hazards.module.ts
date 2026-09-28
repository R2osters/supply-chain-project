import { Module } from '@nestjs/common';
import { HazardsController } from './hazards.controller';
import { HazardsService } from './hazards.service';

/**
 * Exported so the AI module can read weather severity and company exposure without importing
 * the controller. Depends only on the global Prisma and Config modules, so AiModule can import
 * it without a cycle.
 */
@Module({
  controllers: [HazardsController],
  providers: [HazardsService],
  exports: [HazardsService],
})
export class HazardsModule {}
