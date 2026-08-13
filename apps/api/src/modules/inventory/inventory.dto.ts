import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { INVENTORY_ALERT_TYPES, type InventoryAlertType } from '@scip/shared';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class InventoryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warehouseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiPropertyOptional({ description: 'Only rows whose available stock is below the reorder point.' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  belowReorderPoint?: boolean;

  @ApiPropertyOptional({ description: 'Only rows with zero sellable stock.' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  outOfStock?: boolean;
}

/**
 * The global ValidationPipe runs with `forbidNonWhitelisted`, so any query parameter that is not
 * declared on the bound DTO is rejected outright. Filters therefore have to live on the DTO —
 * reading them with a separate `@Query('productId')` looks like it works and produces a 400.
 */
export class MovementQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warehouseId?: string;
}

export class StockAdjustmentDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty()
  @IsString()
  warehouseId!: string;

  @ApiProperty({ description: 'The counted on-hand quantity — a target, not a delta.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  countedQuantity!: number;

  @ApiProperty({ description: 'Why the count differs. Recorded on the ledger line.' })
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class StockTransferDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty()
  @IsString()
  fromWarehouseId!: string;

  @ApiProperty()
  @IsString()
  toWarehouseId!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ManualMovementDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty()
  @IsString()
  warehouseId!: string;

  @ApiProperty({ enum: ['IN', 'OUT'] })
  @IsIn(['IN', 'OUT'])
  type!: 'IN' | 'OUT';

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  batchNumber?: string;
}

export class SetStockPolicyDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty()
  @IsString()
  warehouseId!: string;

  @ApiProperty({ description: 'Units held as a buffer against demand and lead-time variability.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  safetyStock!: number;

  @ApiProperty({ description: 'Ordering is triggered when available stock falls below this.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  reorderPoint!: number;

  @ApiPropertyOptional({ description: 'Upper bound used to flag overstock.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxStock?: number;
}

export class AlertQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: INVENTORY_ALERT_TYPES })
  @IsOptional()
  @IsIn(INVENTORY_ALERT_TYPES)
  type?: InventoryAlertType;

  @ApiPropertyOptional({ default: false, description: 'Include alerts already resolved.' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeResolved?: boolean;
}
