import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import {
  AlertQueryDto,
  InventoryQueryDto,
  ManualMovementDto,
  MovementQueryDto,
  SetStockPolicyDto,
  StockAdjustmentDto,
  StockTransferDto,
} from './inventory.dto';
import { InventoryService } from './inventory.service';

@ApiBearerAuth()
@ApiTags('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly service: InventoryService) {}

  @Get()
  @RequirePermissions('inventory:read')
  @ApiOperation({ summary: 'Stock by product and warehouse' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: InventoryQueryDto) {
    return this.service.list(user, query);
  }

  @Get('valuation')
  @RequirePermissions('inventory:read')
  @ApiOperation({ summary: 'Company-wide stock value and exception counts' })
  valuation(@CurrentUser() user: AuthenticatedUser) {
    return this.service.valuation(user);
  }

  @Get('movements')
  @RequirePermissions('inventory:read')
  @ApiOperation({
    summary: 'The stock ledger',
    description: 'Every movement carries the balance it produced, so the ledger is replayable.',
  })
  movements(@CurrentUser() user: AuthenticatedUser, @Query() query: MovementQueryDto) {
    return this.service.movements(user, query, {
      productId: query.productId,
      warehouseId: query.warehouseId,
    });
  }

  @Get('alerts')
  @RequirePermissions('inventory:read')
  @ApiOperation({ summary: 'Open stock alerts' })
  alerts(@CurrentUser() user: AuthenticatedUser, @Query() query: AlertQueryDto) {
    return this.service.listAlerts(user, query);
  }

  @Post('alerts/sweep')
  @RequirePermissions('inventory:update')
  @Audit('SWEEP_ALERTS', 'inventory')
  @ApiOperation({ summary: 'Re-evaluate every alert condition in the company' })
  sweep(@CurrentUser() user: AuthenticatedUser) {
    return this.service.sweepAlerts(user);
  }

  @Post('movements')
  @RequirePermissions('inventory:create')
  @Audit('MANUAL_MOVEMENT', 'inventory')
  @ApiOperation({ summary: 'Post a manual IN or OUT movement' })
  manualMovement(@CurrentUser() user: AuthenticatedUser, @Body() dto: ManualMovementDto) {
    return this.service.manualMovement(user, dto);
  }

  @Post('adjustments')
  @RequirePermissions('inventory:update')
  @Audit('ADJUST', 'inventory')
  @ApiOperation({
    summary: 'Correct stock after a physical count',
    description: '`countedQuantity` is the new on-hand total, not a delta.',
  })
  adjust(@CurrentUser() user: AuthenticatedUser, @Body() dto: StockAdjustmentDto) {
    return this.service.adjust(user, dto);
  }

  @Post('transfers')
  @RequirePermissions('inventory:update')
  @Audit('TRANSFER', 'inventory')
  @ApiOperation({ summary: 'Move stock between warehouses' })
  transfer(@CurrentUser() user: AuthenticatedUser, @Body() dto: StockTransferDto) {
    return this.service.transfer(user, dto);
  }

  @Put('policy')
  @RequirePermissions('inventory:update')
  @Audit('SET_POLICY', 'inventory')
  @ApiOperation({
    summary: 'Set safety stock, reorder point and maximum for one product/warehouse',
    description:
      'Usually written by accepting an INCREASE_SAFETY_STOCK recommendation rather than by hand.',
  })
  setPolicy(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetStockPolicyDto) {
    return this.service.setPolicy(user, dto);
  }
}
