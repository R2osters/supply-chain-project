import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { UpdateCompanyDto } from './companies.dto';
import { CompaniesService } from './companies.service';

@ApiBearerAuth()
@ApiTags('companies')
@Controller('companies')
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Get('me')
  @RequirePermissions('company:read')
  @ApiOperation({ summary: "The caller's company (name, currency, time zone)" })
  current(@CurrentUser() user: AuthenticatedUser) {
    return this.companies.current(user);
  }

  @Patch('me')
  @RequirePermissions('company:update')
  @Audit('UPDATE', 'company')
  @ApiOperation({ summary: "Rename the caller's company or change its currency and time zone" })
  update(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateCompanyDto) {
    return this.companies.updateCurrent(user, dto);
  }
}
