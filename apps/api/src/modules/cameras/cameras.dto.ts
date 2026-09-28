import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { DEFAULT_LIMIT, DEFAULT_RADIUS_KM, MAX_LIMIT } from './cameras.service';

// Query strings arrive as text and implicit conversion is off globally, hence the @Type on each.

export class CameraBoundingBoxQueryDto {
  @ApiPropertyOptional({ example: 51.4 })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  minLat?: number;

  @ApiPropertyOptional({ example: -0.3 })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  minLon?: number;

  @ApiPropertyOptional({ example: 51.6 })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  maxLat?: number;

  @ApiPropertyOptional({ example: 0.1 })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  maxLon?: number;

  @ApiPropertyOptional({ default: DEFAULT_LIMIT, maximum: MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number;
}

export class CameraNearQueryDto {
  @ApiProperty({ example: 51.5074 })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -0.1278 })
  @Type(() => Number)
  @IsLongitude()
  lon!: number;

  @ApiPropertyOptional({ default: DEFAULT_RADIUS_KM, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(500)
  radiusKm?: number;

  @ApiPropertyOptional({ default: DEFAULT_LIMIT, maximum: MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number;
}
