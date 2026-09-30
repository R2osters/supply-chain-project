import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, Public, RequirePermissions } from '../../common/decorators';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { DemoRehearsalService, type RehearsalResult } from './demo-rehearsal.service';
import { SetupService, type SetupStatus } from './setup.service';

@ApiTags('setup')
@Controller('setup')
export class SetupController {
  constructor(
    private readonly setup: SetupService,
    private readonly rehearsal: DemoRehearsalService,
  ) {}

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

  @ApiBearerAuth()
  @Post('demo/rehearse')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('company:update')
  @Audit('setup.demo.rehearse', 'setup')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Stage the demo again, starting now',
    description:
      'Demo installs only, demo company administrator only (409 otherwise). Sends the live demo ' +
      'shipments back to their origin leaving now, promises SHP-DEMO-0054 and 0055 in five minutes ' +
      'so the ETA engine detects their delay live, makes SKU-006 short again, cancels open orders ' +
      'raised from accepted recommendations and deletes open recommendations.',
  })
  rehearse(@CurrentUser() user: AuthenticatedUser): Promise<RehearsalResult> {
    return this.rehearsal.rehearse(user);
  }
}
