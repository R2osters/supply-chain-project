import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { DELIVERY_STATUSES, type DeliveryStatus } from '@scip/shared';

export class TransitionDeliveryDto {
  @ApiProperty({ enum: DELIVERY_STATUSES })
  @IsIn(DELIVERY_STATUSES)
  status!: DeliveryStatus;

  @ApiPropertyOptional({ description: 'Required when moving to FAILED.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  failureReason?: string;
}

export class CapturePodDto {
  @ApiProperty({ example: 'Kwame Boateng' })
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  receiverName!: string;

  @ApiPropertyOptional({
    description: 'Base64 PNG of the signature. Stored in object storage, never in the database.',
  })
  @IsOptional()
  @IsString()
  signatureBase64?: string;

  @ApiPropertyOptional({ description: 'Base64 JPEGs, at most 5, 10 MB each.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  photosBase64?: string[];

  @ApiPropertyOptional({
    description:
      'Where the delivery was captured. Compared against the declared destination; a large ' +
      'gap is recorded and flagged as a suspicious delivery.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
