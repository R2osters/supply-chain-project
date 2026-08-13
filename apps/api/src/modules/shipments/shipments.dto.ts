import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { SHIPMENT_STATUSES, type ShipmentStatus } from '@scip/shared';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class ShipmentItemDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  batchNumber?: string;
}

export class CreateShipmentDto {
  @ApiPropertyOptional({ description: 'Links this shipment to the order it fulfils.' })
  @IsOptional()
  @IsString()
  purchaseOrderId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  carrierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vehicleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  driverId?: string;

  @ApiPropertyOptional({ description: 'Planned corridor. Enables route-deviation detection.' })
  @IsOptional()
  @IsString()
  routeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({ description: 'Origin warehouse. Its coordinates are used when given.' })
  @IsOptional()
  @IsString()
  originWarehouseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  destinationWarehouseId?: string;

  @ApiPropertyOptional({ description: 'Required unless originWarehouseId is set.' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  originName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  originLatitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  originLongitude?: number;

  @ApiPropertyOptional({ description: 'Required unless destinationWarehouseId or customerId is set.' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  destinationName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  destinationLatitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  destinationLongitude?: number;

  @ApiProperty({ description: 'ISO datetime the vehicle is scheduled to leave.' })
  @IsDateString()
  plannedDepartureAt!: string;

  @ApiPropertyOptional({
    description: 'ISO datetime promised to the receiver. Derived from the ETA engine when omitted.',
  })
  @IsOptional()
  @IsDateString()
  plannedArrivalAt?: string;

  @ApiProperty({ type: [ShipmentItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ShipmentItemDto)
  items!: ShipmentItemDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateShipmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  carrierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vehicleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  driverId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  routeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  plannedDepartureAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  plannedArrivalAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class TransitionShipmentDto {
  @ApiProperty({ enum: SHIPMENT_STATUSES })
  @IsIn(SHIPMENT_STATUSES)
  status!: ShipmentStatus;

  @ApiPropertyOptional({ description: 'Recorded on the shipment event.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ description: 'Where the transition happened, if known.' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;
}

export class ShipmentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SHIPMENT_STATUSES })
  @IsOptional()
  @IsIn(SHIPMENT_STATUSES)
  status?: ShipmentStatus;

  @ApiPropertyOptional({ description: 'Only shipments that are still open.' })
  @IsOptional()
  @IsString()
  @IsIn(['true', 'false'])
  activeOnly?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  carrierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vehicleId?: string;

  @ApiPropertyOptional({ description: 'Only shipments whose delay probability is at least this.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minDelayProbability?: number;
}
