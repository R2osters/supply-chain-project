import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import {
  CreateCarrierDto,
  CreateCustomerDto,
  CreateDriverDto,
  CreateProductCategoryDto,
  CreateProductDto,
  CreateVehicleDto,
  CreateWarehouseDto,
  CreateWarehouseLocationDto,
  UpdateCarrierDto,
  UpdateCustomerDto,
  UpdateDriverDto,
  UpdateProductDto,
  UpdateVehicleDto,
  UpdateWarehouseDto,
} from './master-data.dto';
import {
  CarriersService,
  CustomersService,
  DriversService,
  ProductCategoriesService,
  ProductsService,
  VehiclesService,
  WarehousesService,
} from './master-data.services';

@ApiBearerAuth()
@ApiTags('customers')
@Controller('customers')
export class CustomersController {
  constructor(private readonly service: CustomersService) {}

  @Get()
  @RequirePermissions('customer:read')
  @ApiOperation({ summary: 'List customers' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationQueryDto) {
    return this.service.list(user, query);
  }

  @Get(':id')
  @RequirePermissions('customer:read')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.findOne(user, id);
  }

  @Post()
  @RequirePermissions('customer:create')
  @Audit('CREATE', 'customer')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateCustomerDto) {
    return this.service.create(user, { ...dto });
  }

  @Patch(':id')
  @RequirePermissions('customer:update')
  @Audit('UPDATE', 'customer')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.service.update(user, id, { ...dto });
  }

  @Delete(':id')
  @RequirePermissions('customer:delete')
  @Audit('DEACTIVATE', 'customer')
  @ApiOperation({
    summary: 'Deactivate a customer',
    description: 'Soft delete — historical shipments keep pointing at the record.',
  })
  deactivate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.deactivate(user, id);
  }
}

@ApiBearerAuth()
@ApiTags('carriers')
@Controller('carriers')
export class CarriersController {
  constructor(private readonly service: CarriersService) {}

  @Get()
  @RequirePermissions('carrier:read')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationQueryDto) {
    return this.service.list(user, query);
  }

  @Get(':id')
  @RequirePermissions('carrier:read')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.findOne(user, id);
  }

  @Post()
  @RequirePermissions('carrier:create')
  @Audit('CREATE', 'carrier')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateCarrierDto) {
    return this.service.create(user, { ...dto });
  }

  @Patch(':id')
  @RequirePermissions('carrier:update')
  @Audit('UPDATE', 'carrier')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCarrierDto,
  ) {
    return this.service.update(user, id, { ...dto });
  }

  @Delete(':id')
  @RequirePermissions('carrier:delete')
  @Audit('DEACTIVATE', 'carrier')
  deactivate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.deactivate(user, id);
  }
}

@ApiBearerAuth()
@ApiTags('warehouses')
@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly service: WarehousesService) {}

  @Get()
  @RequirePermissions('warehouse:read')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationQueryDto) {
    return this.service.list(user, query);
  }

  @Get(':id')
  @RequirePermissions('warehouse:read')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.findOne(user, id);
  }

  @Get(':id/summary')
  @RequirePermissions('warehouse:read')
  @ApiOperation({ summary: 'SKU count, units, stock value and reorder breaches' })
  summary(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.summary(user, id);
  }

  @Get(':id/locations')
  @RequirePermissions('warehouse:read')
  locations(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.listLocations(user, id);
  }

  @Post(':id/locations')
  @RequirePermissions('warehouse:update')
  @Audit('CREATE_LOCATION', 'warehouse')
  addLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateWarehouseLocationDto,
  ) {
    return this.service.addLocation(user, id, dto);
  }

  @Post()
  @RequirePermissions('warehouse:create')
  @Audit('CREATE', 'warehouse')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWarehouseDto) {
    return this.service.create(user, { ...dto });
  }

  @Patch(':id')
  @RequirePermissions('warehouse:update')
  @Audit('UPDATE', 'warehouse')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateWarehouseDto,
  ) {
    return this.service.update(user, id, { ...dto });
  }

  @Delete(':id')
  @RequirePermissions('warehouse:delete')
  @Audit('DEACTIVATE', 'warehouse')
  deactivate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.deactivate(user, id);
  }
}

@ApiBearerAuth()
@ApiTags('vehicles')
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly service: VehiclesService) {}

  @Get()
  @RequirePermissions('vehicle:read')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationQueryDto) {
    return this.service.list(user, query);
  }

  @Get(':id')
  @RequirePermissions('vehicle:read')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.findOne(user, id);
  }

  @Get(':id/location')
  @RequirePermissions('vehicle:read')
  @ApiOperation({ summary: 'Last known position and the shipment currently on board' })
  location(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.lastLocation(user, id);
  }

  @Post()
  @RequirePermissions('vehicle:create')
  @Audit('CREATE', 'vehicle')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateVehicleDto) {
    return this.service.create(user, { ...dto });
  }

  @Patch(':id')
  @RequirePermissions('vehicle:update')
  @Audit('UPDATE', 'vehicle')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateVehicleDto,
  ) {
    return this.service.update(user, id, { ...dto });
  }

  @Delete(':id')
  @RequirePermissions('vehicle:delete')
  @Audit('DEACTIVATE', 'vehicle')
  deactivate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.deactivate(user, id);
  }
}

@ApiBearerAuth()
@ApiTags('drivers')
@Controller('drivers')
export class DriversController {
  constructor(private readonly service: DriversService) {}

  @Get()
  @RequirePermissions('driver:read')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationQueryDto) {
    return this.service.list(user, query);
  }

  @Get(':id')
  @RequirePermissions('driver:read')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.findOne(user, id);
  }

  @Post()
  @RequirePermissions('driver:create')
  @Audit('CREATE', 'driver')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateDriverDto) {
    return this.service.createChecked(user, { ...dto });
  }

  @Patch(':id')
  @RequirePermissions('driver:update')
  @Audit('UPDATE', 'driver')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateDriverDto,
  ) {
    return this.service.update(user, id, { ...dto });
  }

  @Delete(':id')
  @RequirePermissions('driver:delete')
  @Audit('DEACTIVATE', 'driver')
  deactivate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.deactivate(user, id);
  }
}

@ApiBearerAuth()
@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(
    private readonly service: ProductsService,
    private readonly categories: ProductCategoriesService,
  ) {}

  @Get()
  @RequirePermissions('product:read')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationQueryDto) {
    return this.service.list(user, query);
  }

  @Get('categories')
  @RequirePermissions('product:read')
  listCategories(@CurrentUser() user: AuthenticatedUser) {
    return this.categories.list(user);
  }

  @Post('categories')
  @RequirePermissions('product:create')
  @Audit('CREATE', 'product_category')
  createCategory(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateProductCategoryDto) {
    return this.categories.create(user, dto);
  }

  @Delete('categories/:id')
  @RequirePermissions('product:delete')
  @Audit('DELETE', 'product_category')
  removeCategory(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.categories.remove(user, id);
  }

  @Get(':id')
  @RequirePermissions('product:read')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.findOne(user, id);
  }

  @Get(':id/stock')
  @RequirePermissions('inventory:read')
  @ApiOperation({ summary: 'Stock for this product across every warehouse' })
  stock(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.stockSummary(user, id);
  }

  @Post()
  @RequirePermissions('product:create')
  @Audit('CREATE', 'product')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateProductDto) {
    return this.service.create(user, { ...dto });
  }

  @Patch(':id')
  @RequirePermissions('product:update')
  @Audit('UPDATE', 'product')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.service.update(user, id, { ...dto });
  }

  @Delete(':id')
  @RequirePermissions('product:delete')
  @Audit('DEACTIVATE', 'product')
  deactivate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.deactivate(user, id);
  }
}
