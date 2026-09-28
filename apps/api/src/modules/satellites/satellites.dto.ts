import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsLatitude, IsLongitude, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { SATELLITE_GROUPS } from './satellite-groups';

const GROUP_IDS = SATELLITE_GROUPS.map((group) => group.id);

export class TleQueryDto {
  @ApiPropertyOptional({ enum: GROUP_IDS, default: 'gps-ops' })
  @IsOptional()
  @IsIn(GROUP_IDS)
  group?: string;
}

export class VisibleQueryDto {
  @ApiProperty({ example: 5.6037 })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -0.187 })
  @Type(() => Number)
  @IsLongitude()
  lon!: number;

  @ApiPropertyOptional({ enum: GROUP_IDS, default: 'gps-ops' })
  @IsOptional()
  @IsIn(GROUP_IDS)
  group?: string;

  @ApiPropertyOptional({
    default: 10,
    minimum: 0,
    maximum: 90,
    description: 'Elevation mask in degrees. Receivers usually ignore satellites below 5–15°.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(90)
  minElevationDeg?: number;
}
