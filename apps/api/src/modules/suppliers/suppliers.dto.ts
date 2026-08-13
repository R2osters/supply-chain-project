import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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

export class CreateSupplierDto {
  @ApiProperty({ example: 'SUP-0001' })
  @IsString()
  @MaxLength(40)
  code!: string;

  @ApiProperty({ example: 'Volta Grain Cooperative' })
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

  @ApiPropertyOptional({ description: 'Needed to price transport in the allocation optimiser.' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional({ default: 7, description: 'Lead time the supplier contractually quotes.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  quotedLeadTimeDays?: number;

  @ApiPropertyOptional({ default: 'NET_30' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  paymentTerms?: string;

  @ApiPropertyOptional({ default: 'USD' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;
}

export class UpdateSupplierDto extends PartialType(CreateSupplierDto) {}

export class UpsertSupplierProductDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty({ example: 10.5 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice!: number;

  @ApiPropertyOptional({ default: 'USD' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @ApiPropertyOptional({ default: 1, description: 'MOQ enforced as a hard constraint by the allocator.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minimumOrderQuantity?: number;

  @ApiProperty({ description: 'Units this supplier can deliver within one lead-time cycle.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  capacityPerCycle!: number;

  @ApiProperty({ example: 7 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  leadTimeDays!: number;
}
