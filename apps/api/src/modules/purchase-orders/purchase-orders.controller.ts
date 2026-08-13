import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import {
  CreatePurchaseOrderDto,
  PurchaseOrderQueryDto,
  ReceivePurchaseOrderDto,
  TransitionPurchaseOrderDto,
  UpdatePurchaseOrderDto,
} from './purchase-orders.dto';
import { PurchaseOrdersService } from './purchase-orders.service';

@ApiBearerAuth()
@ApiTags('purchase-orders')
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly service: PurchaseOrdersService) {}

  @Get()
  @RequirePermissions('purchase_order:read')
  @ApiOperation({
    summary: 'List purchase orders',
    description: 'A SUPPLIER-role account sees only its own orders.',
  })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: PurchaseOrderQueryDto) {
    return this.service.list(user, query);
  }

  @Get(':id')
  @RequirePermissions('purchase_order:read')
  @ApiOperation({ summary: 'One purchase order, with its allowed next statuses' })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.findOne(user, id);
  }

  @Post()
  @RequirePermissions('purchase_order:create')
  @Audit('CREATE', 'purchase_order')
  @ApiOperation({
    summary: 'Raise a purchase order',
    description:
      'Line prices default to the supplier price list in force today. Quantities below the ' +
      'supplier MOQ are rejected.',
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePurchaseOrderDto) {
    return this.service.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions('purchase_order:update')
  @Audit('UPDATE', 'purchase_order')
  @ApiOperation({ summary: 'Edit a DRAFT or PENDING order' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdatePurchaseOrderDto,
  ) {
    return this.service.update(user, id, dto);
  }

  @Post(':id/transition')
  @RequirePermissions('purchase_order:approve')
  @Audit('TRANSITION', 'purchase_order')
  @ApiOperation({
    summary: 'Move the order to another status',
    description:
      'Confirming reserves the quantity as incoming stock so the reorder engine stops ' +
      'recommending the same order twice.',
  })
  transition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransitionPurchaseOrderDto,
  ) {
    return this.service.transition(user, id, dto.status, dto.reason);
  }

  @Post(':id/receive')
  @RequirePermissions('inventory:create')
  @Audit('RECEIVE', 'purchase_order')
  @ApiOperation({
    summary: 'Record a goods receipt',
    description:
      'Supports partial deliveries. Accepted units enter available stock; rejected units go to ' +
      'damaged stock. The order becomes DELIVERED only once every line is complete.',
  })
  receive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReceivePurchaseOrderDto,
  ) {
    return this.service.receive(user, id, dto);
  }
}
