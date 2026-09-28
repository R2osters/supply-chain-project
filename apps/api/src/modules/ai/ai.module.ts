import { Module } from '@nestjs/common';
import { HazardsModule } from '../hazards/hazards.module';
import { AiClientService } from './ai-client.service';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

@Module({
  // Weather severity for delay predictions, hazard exposure for risk analysis.
  imports: [HazardsModule],
  controllers: [AiController],
  providers: [AiClientService, AiService],
  exports: [AiClientService, AiService],
})
export class AiModule {}
