import { Module } from '@nestjs/common';
import {
  CarriersController,
  CustomersController,
  DriversController,
  ProductsController,
  VehiclesController,
  WarehousesController,
} from './master-data.controllers';
import {
  CarriersService,
  CustomersService,
  DriversService,
  ProductCategoriesService,
  ProductsService,
  VehiclesService,
  WarehousesService,
} from './master-data.services';

/**
 * The six reference tables that are pure master data. They share one module because they share
 * one behaviour (tenant-scoped CRUD with soft delete); anything with real domain rules —
 * suppliers, purchase orders, shipments, inventory — gets its own module.
 */
@Module({
  controllers: [
    CustomersController,
    CarriersController,
    WarehousesController,
    VehiclesController,
    DriversController,
    ProductsController,
  ],
  providers: [
    CustomersService,
    CarriersService,
    WarehousesService,
    VehiclesService,
    DriversService,
    ProductsService,
    ProductCategoriesService,
  ],
  exports: [
    CustomersService,
    CarriersService,
    WarehousesService,
    VehiclesService,
    DriversService,
    ProductsService,
  ],
})
export class MasterDataModule {}
