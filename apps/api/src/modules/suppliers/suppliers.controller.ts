import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { CreateSupplierDto, UpdateSupplierDto, UpsertSupplierProductDto } from './suppliers.dto';
import { SuppliersService } from './suppliers.service';

@ApiBearerAuth()
@ApiTags('suppliers')
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly service: SuppliersService) {}

  @Get()
  @RequirePermissions('supplier:read')
  @ApiOperation({ summary: 'List suppliers' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationQueryDto) {
    return this.service.list(user, query);
  }

  @Get('leaderboard')
  @RequirePermissions('supplier:read')
  @ApiOperation({
    summary: 'Suppliers ranked by reliability score',
    description:
      '`scoreIsMeasured: false` means the score is still the neutral prior — no performance ' +
      'has been computed for that supplier yet.',
  })
  @ApiQuery({ name: 'limit', required: false })
  leaderboard(@CurrentUser() user: AuthenticatedUser, @Query('limit') limit?: string) {
    const parsed = Number.parseInt(limit ?? '20', 10);
    return this.service.leaderboard(user, Number.isFinite(parsed) ? Math.min(parsed, 100) : 20);
  }

  @Get(':id')
  @RequirePermissions('supplier:read')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.findOne(user, id);
  }

  @Get(':id/products')
  @RequirePermissions('supplier:read')
  @ApiOperation({ summary: 'Current price list (only rows with no validUntil)' })
  products(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.listProducts(user, id);
  }

  @Get(':id/performance')
  @RequirePermissions('supplier:read')
  @ApiOperation({ summary: 'Historical performance snapshots' })
  performance(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.performanceHistory(user, id);
  }

  @Post()
  @RequirePermissions('supplier:create')
  @Audit('CREATE', 'supplier')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSupplierDto) {
    return this.service.create(user, { ...dto });
  }

  @Post(':id/products')
  @RequirePermissions('supplier:update')
  @Audit('UPSERT_PRICE', 'supplier')
  @ApiOperation({
    summary: 'Add or reprice a product',
    description:
      'Repricing closes the current price row and opens a new one, so historical purchase ' +
      'orders can still be reconciled against the price that applied when they were raised.',
  })
  upsertProduct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpsertSupplierProductDto,
  ) {
    return this.service.upsertProduct(user, id, dto);
  }

  @Post(':id/recompute-performance')
  @RequirePermissions('supplier:update')
  @Audit('RECOMPUTE_PERFORMANCE', 'supplier')
  @ApiOperation({ summary: 'Recompute reliability from purchase-order history' })
  @ApiQuery({ name: 'windowDays', required: false })
  recompute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('windowDays') windowDays?: string,
  ) {
    const parsed = Number.parseInt(windowDays ?? '365', 10);
    return this.service.recomputePerformance(user, id, Number.isFinite(parsed) ? parsed : 365);
  }

  @Post('recompute-performance')
  @RequirePermissions('supplier:update')
  @Audit('RECOMPUTE_PERFORMANCE_ALL', 'supplier')
  @ApiOperation({ summary: 'Recompute reliability for every active supplier' })
  recomputeAll(@CurrentUser() user: AuthenticatedUser) {
    return this.service.recomputeAll(user);
  }

  @Patch(':id')
  @RequirePermissions('supplier:update')
  @Audit('UPDATE', 'supplier')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    return this.service.update(user, id, { ...dto });
  }

  @Delete(':id')
  @RequirePermissions('supplier:delete')
  @Audit('DEACTIVATE', 'supplier')
  deactivate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.deactivate(user, id);
  }
}
