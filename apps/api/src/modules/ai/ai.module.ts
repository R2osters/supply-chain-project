import { Module } from '@nestjs/common';
import { AiClientService } from './ai-client.service';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

@Module({
  controllers: [AiController],
  providers: [AiClientService, AiService],
  exports: [AiClientService, AiService],
})
export class AiModule {}
