import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators';
import { SetupService, type SetupStatus } from './setup.service';

@ApiTags('setup')
@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Public()
  @Get('status')
  @ApiOperation({ summary: 'Whether this install still needs its first company' })
  status(): Promise<SetupStatus> {
    return this.setup.status();
  }

  @Public()
  @Post('demo')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'Populate an empty install with the demo data set (first run only)' })
  async loadDemo(): Promise<void> {
    await this.setup.loadDemo();
  }
}
