import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PURCHASE_ORDER_STATUSES, type PurchaseOrderStatus } from '@scip/shared';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class PurchaseOrderItemDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty({ example: 8000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity!: number;

  @ApiPropertyOptional({
    description: 'Omit to use the supplier price list in force today.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice?: number;
}

export class CreatePurchaseOrderDto {
  @ApiProperty()
  @IsString()
  supplierId!: string;

  @ApiPropertyOptional({ description: 'Warehouse the goods will be received into.' })
  @IsOptional()
  @IsString()
  warehouseId?: string;

  @ApiProperty({ type: [PurchaseOrderItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  items!: PurchaseOrderItemDto[];

  @ApiPropertyOptional({ description: 'ISO date. Defaults to today + the supplier lead time.' })
  @IsOptional()
  @IsDateString()
  expectedDeliveryDate?: string;

  @ApiPropertyOptional({ description: 'ISO date the supplier is expected to ship.' })
  @IsOptional()
  @IsDateString()
  expectedShippingDate?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  shippingCost?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  taxAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({ description: 'Set when this PO comes from accepting a recommendation.' })
  @IsOptional()
  @IsString()
  sourceRecommendationId?: string;
}

export class UpdatePurchaseOrderDto {
  @ApiPropertyOptional({ type: [PurchaseOrderItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  items?: PurchaseOrderItemDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expectedDeliveryDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expectedShippingDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warehouseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  shippingCost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  taxAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class TransitionPurchaseOrderDto {
  @ApiProperty({ enum: PURCHASE_ORDER_STATUSES })
  @IsIn(PURCHASE_ORDER_STATUSES)
  status!: PurchaseOrderStatus;

  @ApiPropertyOptional({ description: 'Required when moving to CANCELLED.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ReceiveLineDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty({ description: 'Units physically received in this delivery.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  receivedQuantity!: number;

  @ApiPropertyOptional({ default: 0, description: 'Of those received, how many failed QC.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  rejectedQuantity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  batchNumber?: string;

  @ApiPropertyOptional({ description: 'ISO date; required for perishable products.' })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;
}

export class ReceivePurchaseOrderDto {
  @ApiProperty()
  @IsString()
  warehouseId!: string;

  @ApiProperty({ type: [ReceiveLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiveLineDto)
  lines!: ReceiveLineDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class PurchaseOrderQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PURCHASE_ORDER_STATUSES })
  @IsOptional()
  @IsIn(PURCHASE_ORDER_STATUSES)
  status?: PurchaseOrderStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  supplierId?: string;

  @ApiPropertyOptional({ description: 'Only orders expected on or after this ISO date.' })
  @IsOptional()
  @IsDateString()
  expectedFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expectedTo?: string;
}
