import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { VEHICLE_STATUSES, VEHICLE_TYPES, type VehicleStatus, type VehicleType } from '@scip/shared';

/* --------------------------------------------------------------------- shared */

class ContactFields {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contactName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(180)
  contactEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string;
}

/* ------------------------------------------------------------------ customers */

export class CreateCustomerDto extends ContactFields {
  @ApiProperty({ example: 'CUS-0001' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  code!: string;

  @ApiProperty({ example: 'Kumasi Retail Group' })
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @ApiProperty({ example: 'GH' })
  @IsString()
  @MaxLength(60)
  country!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(240)
  addressLine?: string;

  @ApiPropertyOptional({ description: 'Required for route optimisation and delivery geofencing.' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional({ description: 'Delivery window start, minutes from local midnight.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1440)
  windowStartMinutes?: number;

  @ApiPropertyOptional({ description: 'Delivery window end, minutes from local midnight.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1440)
  windowEndMinutes?: number;
}

export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}

/* ------------------------------------------------------------------- carriers */

export class CreateCarrierDto {
  @ApiProperty({ example: 'CAR-0001' })
  @IsString()
  @MaxLength(40)
  code!: string;

  @ApiProperty({ example: 'West Africa Freight' })
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @ApiProperty({ example: 'GH' })
  @IsString()
  @MaxLength(60)
  country!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(180)
  contactEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string;

  @ApiPropertyOptional({ description: 'Billing rate per kilometre, company currency.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costPerKm?: number;
}

export class UpdateCarrierDto extends PartialType(CreateCarrierDto) {}

/* ----------------------------------------------------------------- warehouses */

export class CreateWarehouseDto {
  @ApiProperty({ example: 'WH-ACC-01' })
  @IsString()
  @MaxLength(40)
  code!: string;

  @ApiProperty({ example: 'Accra Central DC' })
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @ApiProperty({ example: 'GH' })
  @IsString()
  @MaxLength(60)
  country!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(240)
  addressLine?: string;

  @ApiProperty({ example: 5.6037 })
  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: -0.187 })
  @Type(() => Number)
  @IsLongitude()
  longitude!: number;

  @ApiPropertyOptional({ description: 'Storage capacity in stock units.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  capacityUnits?: number;

  @ApiPropertyOptional({
    default: 300,
    description: 'Metres. A vehicle inside this radius counts as arrived.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(25)
  @Max(20000)
  geofenceRadiusM?: number;
}

export class UpdateWarehouseDto extends PartialType(CreateWarehouseDto) {}

export class CreateWarehouseLocationDto {
  @ApiProperty({ example: 'A-01-3-2' })
  @IsString()
  @MaxLength(40)
  code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  zone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  aisle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  rack?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  shelf?: string;
}

/* ------------------------------------------------------------------- vehicles */

export class CreateVehicleDto {
  @ApiProperty({ example: 'GT-4821-24' })
  @IsString()
  @MaxLength(30)
  plateNumber!: string;

  @ApiPropertyOptional({ example: 'Truck 12' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  @ApiProperty({ enum: VEHICLE_TYPES })
  @IsIn(VEHICLE_TYPES)
  type!: VehicleType;

  @ApiPropertyOptional({ enum: VEHICLE_STATUSES })
  @IsOptional()
  @IsIn(VEHICLE_STATUSES)
  status?: VehicleStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  carrierId?: string;

  @ApiProperty({ description: 'Payload capacity in stock units.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  capacityUnits!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  capacityKg?: number;

  @ApiPropertyOptional({ default: 28, description: 'Litres per 100 km — feeds route fuel cost.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(200)
  fuelConsumptionLPer100Km?: number;

  @ApiPropertyOptional({ default: 0.9 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costPerKm?: number;

  @ApiPropertyOptional({
    default: 60,
    description: 'Speed prior used by the ETA engine before trip observations exist.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(5)
  @Max(160)
  nominalSpeedKmh?: number;
}

export class UpdateVehicleDto extends PartialType(CreateVehicleDto) {}

/* -------------------------------------------------------------------- drivers */

export class CreateDriverDto {
  @ApiProperty()
  @IsString()
  @MaxLength(80)
  firstName!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(80)
  lastName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  licenseNumber?: string;

  @ApiPropertyOptional({ description: 'Links this driver to a DRIVER-role user account.' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  carrierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultVehicleId?: string;
}

export class UpdateDriverDto extends PartialType(CreateDriverDto) {}

/* ------------------------------------------------------------------- products */

export class CreateProductDto {
  @ApiProperty({ example: 'SKU-001' })
  @IsString()
  @MaxLength(60)
  sku!: string;

  @ApiProperty({ example: 'Sorghum flour 25 kg' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  barcode?: string;

  @ApiPropertyOptional({ default: 'EA' })
  @IsOptional()
  @IsString()
  @MaxLength(12)
  unitOfMeasure?: string;

  @ApiProperty({ description: 'Cost used for inventory valuation and stockout penalties.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitCost!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  weightKg?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  volumeM3?: number;

  @ApiPropertyOptional({ description: 'Days before expiry. Drives EXPIRING_SOON alerts.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  shelfLifeDays?: number;

  @ApiPropertyOptional({
    default: 0.95,
    description: 'Target cycle-service level, strictly between 0 and 1.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(0.9999)
  serviceLevel?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isPerishable?: boolean;
}

export class UpdateProductDto extends PartialType(CreateProductDto) {}

export class CreateProductCategoryDto {
  @ApiProperty()
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  parentId?: string;
}
