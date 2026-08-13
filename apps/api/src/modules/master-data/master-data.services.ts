import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  Carrier,
  Customer,
  Driver,
  Product,
  ProductCategory,
  Vehicle,
  Warehouse,
} from '@prisma/client';
import {
  MasterDataService,
  type PrismaDelegateLike,
} from '../../common/crud/master-data.service';
import { PrismaService } from '../../prisma/prisma.service';
import { companyFilter, requireCompanyId } from '../../common/tenancy/tenant-scope';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { CreateProductCategoryDto, CreateWarehouseLocationDto } from './master-data.dto';

/**
 * Prisma's generated delegates are heavily generic; `PrismaDelegateLike` is the narrow structural
 * subset the shared CRUD helper actually calls. The cast is confined to these constructors so no
 * `any` escapes into request handling.
 */
const asDelegate = <T>(delegate: unknown): PrismaDelegateLike<T> =>
  delegate as PrismaDelegateLike<T>;

@Injectable()
export class CustomersService extends MasterDataService<Customer> {
  constructor(prisma: PrismaService) {
    super(asDelegate<Customer>(prisma.customer), {
      entity: 'customer',
      sortable: ['name', 'code', 'country', 'city', 'createdAt'],
      defaultSort: 'name',
      searchable: ['name', 'code', 'city', 'contactName', 'contactEmail'],
    });
  }
}

@Injectable()
export class CarriersService extends MasterDataService<Carrier> {
  constructor(prisma: PrismaService) {
    super(asDelegate<Carrier>(prisma.carrier), {
      entity: 'carrier',
      sortable: ['name', 'code', 'onTimeRate', 'shipmentsCompleted', 'createdAt'],
      defaultSort: 'name',
      searchable: ['name', 'code', 'country'],
      listInclude: { _count: { select: { vehicles: true, shipments: true } } },
    });
  }
}

@Injectable()
export class WarehousesService extends MasterDataService<Warehouse> {
  constructor(private readonly prisma: PrismaService) {
    super(asDelegate<Warehouse>(prisma.warehouse), {
      entity: 'warehouse',
      sortable: ['name', 'code', 'country', 'city', 'createdAt'],
      defaultSort: 'name',
      searchable: ['name', 'code', 'city', 'country'],
      listInclude: { _count: { select: { inventories: true, locations: true } } },
    });
  }

  async addLocation(user: AuthenticatedUser, warehouseId: string, dto: CreateWarehouseLocationDto) {
    await this.findOne(user, warehouseId);
    return this.prisma.warehouseLocation.create({ data: { ...dto, warehouseId } });
  }

  async listLocations(user: AuthenticatedUser, warehouseId: string) {
    await this.findOne(user, warehouseId);
    return this.prisma.warehouseLocation.findMany({
      where: { warehouseId },
      orderBy: { code: 'asc' },
    });
  }

  /**
   * Stock value and utilisation for one warehouse. Aggregated in SQL rather than by loading
   * every inventory row into Node — a busy DC has tens of thousands of SKUs.
   */
  async summary(user: AuthenticatedUser, warehouseId: string) {
    const warehouse = await this.findOne(user, warehouseId);

    const rows = await this.prisma.$queryRaw<
      Array<{ skus: bigint; units: number | null; value: number | null; below_reorder: bigint }>
    >`
      SELECT COUNT(*)::bigint                                                   AS skus,
             COALESCE(SUM(i."availableStock"), 0)::double precision             AS units,
             COALESCE(SUM(i."availableStock" * p."unitCost"), 0)::double precision AS value,
             COUNT(*) FILTER (WHERE i."availableStock" < i."reorderPoint")::bigint AS below_reorder
        FROM "inventory" i
        JOIN "products" p ON p.id = i."productId"
       WHERE i."warehouseId" = ${warehouseId}
    `;

    const row = rows[0];
    const units = Number(row?.units ?? 0);
    const capacity = warehouse.capacityUnits ? Number(warehouse.capacityUnits) : null;

    return {
      warehouseId,
      distinctSkus: Number(row?.skus ?? 0),
      totalUnits: units,
      inventoryValue: Number(row?.value ?? 0),
      productsBelowReorderPoint: Number(row?.below_reorder ?? 0),
      capacityUnits: capacity,
      utilisationPercent: capacity && capacity > 0 ? round((units / capacity) * 100, 2) : null,
    };
  }
}

@Injectable()
export class VehiclesService extends MasterDataService<Vehicle> {
  constructor(private readonly prisma: PrismaService) {
    super(asDelegate<Vehicle>(prisma.vehicle), {
      entity: 'vehicle',
      sortable: ['plateNumber', 'label', 'type', 'status', 'lastPositionAt', 'createdAt'],
      defaultSort: 'plateNumber',
      searchable: ['plateNumber', 'label'],
      listInclude: { carrier: { select: { id: true, name: true } } },
      detailInclude: {
        carrier: { select: { id: true, name: true } },
        drivers: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  /** Last known position, or null when the vehicle has never reported. */
  async lastLocation(user: AuthenticatedUser, vehicleId: string) {
    const vehicle = await this.findOne(user, vehicleId);
    if (vehicle.lastLatitude === null || vehicle.lastLongitude === null) {
      return { vehicleId, position: null, message: 'This vehicle has never reported a position' };
    }

    const activeShipment = await this.prisma.shipment.findFirst({
      where: { vehicleId, status: { in: ['LOADING', 'DEPARTED', 'IN_TRANSIT', 'DELAYED'] } },
      select: {
        id: true,
        trackingNumber: true,
        status: true,
        destinationName: true,
        estimatedArrivalAt: true,
        delayProbability: true,
      },
      orderBy: { plannedDepartureAt: 'desc' },
    });

    return {
      vehicleId,
      position: {
        latitude: vehicle.lastLatitude,
        longitude: vehicle.lastLongitude,
        speedKmh: vehicle.lastSpeedKmh,
        headingDegrees: vehicle.lastHeadingDegrees,
        recordedAt: vehicle.lastPositionAt,
      },
      activeShipment,
    };
  }
}

@Injectable()
export class DriversService extends MasterDataService<Driver> {
  constructor(private readonly prisma: PrismaService) {
    super(asDelegate<Driver>(prisma.driver), {
      entity: 'driver',
      sortable: ['lastName', 'firstName', 'onTimeRate', 'tripsCompleted', 'createdAt'],
      defaultSort: 'lastName',
      searchable: ['firstName', 'lastName', 'phone', 'licenseNumber'],
      listInclude: {
        carrier: { select: { id: true, name: true } },
        defaultVehicle: { select: { id: true, plateNumber: true } },
      },
    });
  }

  /**
   * A DRIVER-role user may be linked to exactly one driver profile; the schema enforces
   * uniqueness, this turns the resulting P2002 into a message an operator can act on.
   */
  async createChecked(user: AuthenticatedUser, data: Record<string, unknown>) {
    if (data.userId) {
      const linked = await this.prisma.user.findUnique({
        where: { id: data.userId as string },
        select: { id: true, role: true, companyId: true, driverProfile: { select: { id: true } } },
      });
      if (!linked) throw new NotFoundException('The user to link does not exist');
      if (linked.companyId !== requireCompanyId(user)) {
        throw new BadRequestException('That user belongs to another company');
      }
      if (linked.driverProfile) {
        throw new BadRequestException('That user already has a driver profile');
      }
      if (linked.role !== 'DRIVER') {
        throw new BadRequestException(
          `User role is ${linked.role}; only a DRIVER-role account can own a driver profile`,
        );
      }
    }
    return this.create(user, data);
  }
}

@Injectable()
export class ProductsService extends MasterDataService<Product> {
  constructor(private readonly prisma: PrismaService) {
    super(asDelegate<Product>(prisma.product), {
      entity: 'product',
      sortable: ['sku', 'name', 'unitCost', 'unitPrice', 'createdAt'],
      defaultSort: 'sku',
      searchable: ['sku', 'name', 'barcode', 'description'],
      listInclude: { category: { select: { id: true, name: true } } },
      detailInclude: {
        category: { select: { id: true, name: true } },
        suppliers: {
          include: { supplier: { select: { id: true, name: true, reliabilityScore: true } } },
        },
        inventories: {
          include: { warehouse: { select: { id: true, code: true, name: true } } },
        },
      },
    });
  }

  /** Stock across every warehouse, plus the value that stock represents. */
  async stockSummary(user: AuthenticatedUser, productId: string) {
    const product = await this.findOne(user, productId);
    const rows = await this.prisma.inventory.findMany({
      where: { productId },
      include: { warehouse: { select: { id: true, code: true, name: true } } },
    });

    const totals = rows.reduce(
      (acc, row) => ({
        available: acc.available + Number(row.availableStock),
        reserved: acc.reserved + Number(row.reservedStock),
        damaged: acc.damaged + Number(row.damagedStock),
        incoming: acc.incoming + Number(row.incomingStock),
      }),
      { available: 0, reserved: 0, damaged: 0, incoming: 0 },
    );

    return {
      productId,
      sku: product.sku,
      ...totals,
      /** Sellable right now: on hand minus what is already promised. */
      free: totals.available - totals.reserved,
      valuation: round(totals.available * Number(product.unitCost), 2),
      byWarehouse: rows.map((row) => ({
        warehouse: row.warehouse,
        available: Number(row.availableStock),
        reserved: Number(row.reservedStock),
        damaged: Number(row.damagedStock),
        incoming: Number(row.incomingStock),
        reorderPoint: Number(row.reorderPoint),
        safetyStock: Number(row.safetyStock),
        belowReorderPoint: Number(row.availableStock) < Number(row.reorderPoint),
      })),
    };
  }
}

@Injectable()
export class ProductCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthenticatedUser) {
    return this.prisma.productCategory.findMany({
      where: companyFilter(user),
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
  }

  async create(user: AuthenticatedUser, dto: CreateProductCategoryDto) {
    const companyId = requireCompanyId(user);
    if (dto.parentId) {
      const parent = await this.prisma.productCategory.findUnique({ where: { id: dto.parentId } });
      if (!parent || parent.companyId !== companyId) {
        throw new BadRequestException('Parent category not found in your company');
      }
    }
    return this.prisma.productCategory.create({ data: { ...dto, companyId } });
  }

  async remove(user: AuthenticatedUser, id: string): Promise<{ success: true }> {
    const category = (await this.prisma.productCategory.findUnique({
      where: { id },
      include: { _count: { select: { products: true, children: true } } },
    })) as (ProductCategory & { _count: { products: number; children: number } }) | null;

    if (!category || category.companyId !== requireCompanyId(user)) {
      throw new NotFoundException('Category not found');
    }
    if (category._count.products > 0 || category._count.children > 0) {
      throw new BadRequestException(
        'Category still has products or sub-categories; move them before deleting',
      );
    }

    await this.prisma.productCategory.delete({ where: { id } });
    return { success: true };
  }
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
