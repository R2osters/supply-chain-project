import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class GpsFixDto {
  @ApiProperty({ example: 5.6037 })
  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: -0.187 })
  @Type(() => Number)
  @IsLongitude()
  longitude!: number;

  @ApiPropertyOptional({ description: 'km/h. Rejected above 400 as a sensor fault.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(400)
  speedKmh?: number;

  @ApiPropertyOptional({ description: 'Degrees clockwise from true north, [0, 360).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(359.999)
  headingDegrees?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  altitudeM?: number;

  @ApiPropertyOptional({ description: 'Reported horizontal accuracy in metres.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  accuracyM?: number;

  @ApiProperty({ description: 'ISO datetime the device recorded the fix.' })
  @IsDateString()
  recordedAt!: string;
}

export class IngestGpsDto {
  @ApiProperty()
  @IsString()
  vehicleId!: string;

  @ApiPropertyOptional({
    description: 'Omit to attach the fixes to the vehicle’s current in-motion shipment.',
  })
  @IsOptional()
  @IsString()
  shipmentId?: string;

  @ApiProperty({
    type: [GpsFixDto],
    description: 'Up to 500 fixes per call so a device can flush a buffer after losing signal.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => GpsFixDto)
  fixes!: GpsFixDto[];
}

export class NearbyQueryDto {
  @ApiProperty()
  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsLongitude()
  longitude!: number;

  @ApiPropertyOptional({ default: 20, description: 'Search radius in kilometres.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(2000)
  radiusKm?: number;

  @ApiPropertyOptional({
    default: 30,
    description: 'Ignore vehicles whose last fix is older than this many minutes.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  staleAfterMinutes?: number;
}
