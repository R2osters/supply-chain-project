import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/decorators';
import { DeliveryQueryDto } from '../../common/dto/filter-query.dto';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { CapturePodDto, TransitionDeliveryDto } from './deliveries.dto';
import { DeliveriesService } from './deliveries.service';

@ApiBearerAuth()
@ApiTags('deliveries')
@Controller('deliveries')
export class DeliveriesController {
  constructor(private readonly service: DeliveriesService) {}

  @Get()
  @RequirePermissions('delivery:read')
  @ApiOperation({
    summary: 'List deliveries',
    description: 'A DRIVER sees only their own; a CUSTOMER sees only deliveries addressed to them.',
  })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: DeliveryQueryDto) {
    return this.service.list(user, query, query.status);
  }

  @Get('today')
  @RequirePermissions('delivery:read')
  @ApiOperation({ summary: 'Today’s delivery run, with completion counts' })
  today(@CurrentUser() user: AuthenticatedUser) {
    return this.service.today(user);
  }

  @Get(':id')
  @RequirePermissions('delivery:read')
  @ApiOperation({
    summary: 'One delivery with its proof',
    description: 'Signature and photo links are short-lived presigned URLs, valid for 15 minutes.',
  })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.findOne(user, id);
  }

  @Post('shipments/:shipmentId')
  @RequirePermissions('delivery:create')
  @Audit('CREATE', 'delivery')
  @ApiOperation({ summary: 'Create the delivery record for a shipment (idempotent)' })
  createForShipment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('shipmentId') shipmentId: string,
  ) {
    return this.service.createForShipment(user, shipmentId);
  }

  @Post(':id/transition')
  @RequirePermissions('delivery:update')
  @Audit('TRANSITION', 'delivery')
  @ApiOperation({ summary: 'Advance the delivery workflow' })
  transition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransitionDeliveryDto,
  ) {
    return this.service.transition(user, id, dto);
  }

  @Post(':id/proof')
  @RequirePermissions('delivery:update')
  @Audit('CAPTURE_POD', 'delivery')
  @ApiOperation({
    summary: 'Capture proof of delivery and complete the delivery',
    description:
      'Stores the signature and photos in object storage, records the capture location and its ' +
      'distance from the declared destination, and moves the shipment to DELIVERED through the ' +
      'normal path so carrier performance and vehicle availability stay correct.',
  })
  captureProof(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CapturePodDto,
  ) {
    return this.service.captureProof(user, id, dto);
  }
}
