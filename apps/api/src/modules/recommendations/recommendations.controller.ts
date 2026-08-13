import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Audit, CurrentUser, RequirePermissions } from '../../common/decorators';
import { RecommendationQueryDto } from '../../common/dto/filter-query.dto';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { RecommendationsService } from './recommendations.service';

class DecisionDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

@ApiBearerAuth()
@ApiTags('recommendations')
@Controller('recommendations')
export class RecommendationsController {
  constructor(private readonly service: RecommendationsService) {}

  @Get()
  @RequirePermissions('recommendation:read')
  @ApiOperation({
    summary: 'Open recommendations, most urgent first',
    description: 'Defaults to OPEN. Ordering is CRITICAL → HIGH → MEDIUM → LOW, then newest.',
  })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: RecommendationQueryDto) {
    return this.service.list(user, query, {
      status: query.status,
      priority: query.priority,
      type: query.type,
    });
  }

  @Get('stats')
  @RequirePermissions('recommendation:read')
  @ApiOperation({
    summary: 'Acceptance statistics',
    description: 'How often the advice is acted on — the measure of whether it is any good.',
  })
  stats(@CurrentUser() user: AuthenticatedUser) {
    return this.service.stats(user);
  }

  @Get(':id')
  @RequirePermissions('recommendation:read')
  @ApiOperation({
    summary: 'One recommendation with the events that triggered it',
    description:
      'Returns the explanation from the model plus the domain events on the same subject, so ' +
      'the chain from "shipment delayed" to "order 3 000 more" is visible end to end.',
  })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.findOne(user, id);
  }

  @Post(':id/accept')
  @RequirePermissions('recommendation:approve')
  @Audit('ACCEPT', 'recommendation')
  @ApiOperation({
    summary: 'Accept and execute',
    description:
      'Performs the real action: ORDER_NOW and SPLIT_ORDER raise draft purchase orders, ' +
      'INCREASE_SAFETY_STOCK and REDUCE_INVENTORY write the inventory policy. Types with no ' +
      'automatable action are recorded as accepted and say so.',
  })
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DecisionDto,
  ) {
    return this.service.accept(user, id, dto.note);
  }

  @Post(':id/reject')
  @RequirePermissions('recommendation:update')
  @Audit('REJECT', 'recommendation')
  @ApiOperation({ summary: 'Dismiss a recommendation, with a reason' })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DecisionDto,
  ) {
    return this.service.reject(user, id, dto.note);
  }
}
