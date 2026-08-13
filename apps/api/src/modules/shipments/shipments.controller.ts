import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import {
  CreateShipmentDto,
  ShipmentQueryDto,
  TransitionShipmentDto,
  UpdateShipmentDto,
} from './shipments.dto';
import { ShipmentsService } from './shipments.service';

@ApiBearerAuth()
@ApiTags('shipments')
@Controller('shipments')
export class ShipmentsController {
  constructor(private readonly service: ShipmentsService) {}

  @Get()
  @RequirePermissions('shipment:read')
  @ApiOperation({
    summary: 'List shipments',
    description:
      'DRIVER sees only their own assignments, SUPPLIER only shipments against their own ' +
      'purchase orders, CUSTOMER only shipments addressed to them.',
  })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ShipmentQueryDto) {
    return this.service.list(user, query);
  }

  @Get(':id')
  @RequirePermissions('shipment:read')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.findOne(user, id);
  }

  @Get(':id/tracking')
  @RequirePermissions('shipment:read')
  @ApiOperation({
    summary: 'Full tracking view: events, breadcrumb trail, anomalies and live ETA',
    description:
      'The breadcrumb trail is downsampled server-side; `positionsSampledEvery` tells you the stride.',
  })
  @ApiQuery({ name: 'maxPoints', required: false, description: 'Default 500, max 5000.' })
  tracking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('maxPoints') maxPoints?: string,
  ) {
    const parsed = Number.parseInt(maxPoints ?? '500', 10);
    return this.service.tracking(user, id, Math.min(Number.isFinite(parsed) ? parsed : 500, 5000));
  }

  @Post()
  @RequirePermissions('shipment:create')
  @Audit('CREATE', 'shipment')
  @ApiOperation({
    summary: 'Plan a shipment',
    description:
      'Origin and destination can come from a warehouse or customer record, or be given as raw ' +
      'coordinates. When `plannedArrivalAt` is omitted it is derived from the ETA engine, so ' +
      'every shipment has a promise to be measured against.',
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateShipmentDto) {
    return this.service.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions('shipment:update')
  @Audit('UPDATE', 'shipment')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateShipmentDto,
  ) {
    return this.service.update(user, id, dto);
  }

  @Post(':id/transition')
  @RequirePermissions('shipment:update')
  @Audit('TRANSITION', 'shipment')
  @ApiOperation({
    summary: 'Move the shipment to another status',
    description: 'Also keeps the assigned vehicle’s availability in step.',
  })
  transition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransitionShipmentDto,
  ) {
    const location =
      dto.latitude !== undefined && dto.longitude !== undefined
        ? { latitude: dto.latitude, longitude: dto.longitude }
        : undefined;
    return this.service.transition(user, id, dto.status, dto.note, location);
  }

  @Post(':id/recompute-eta')
  @RequirePermissions('shipment:update')
  @ApiOperation({
    summary: 'Recompute the ETA from the latest telemetry',
    description:
      'Returns the estimate with its assumptions, arrival window and confidence. Flips the ' +
      'shipment to DELAYED the first time even the optimistic end of the window misses the promise.',
  })
  recomputeEta(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.recomputeEta(user, id);
  }
}
