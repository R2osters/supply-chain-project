import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Query DTOs. Query strings arrive as text and the global pipe does no implicit conversion, so
 * each number is converted explicitly with `@Type` before it is range-checked.
 */

export class HazardsQueryDto {
  @ApiPropertyOptional({ description: 'South edge of the viewport. Give all four edges or none.' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  minLat?: number;

  @ApiPropertyOptional({ description: 'West edge. May exceed maxLon for a view across 180°.' })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  minLon?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  maxLat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  maxLon?: number;
}

export class WeatherQueryDto {
  @ApiProperty({ example: 5.6037 })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -0.187 })
  @Type(() => Number)
  @IsLongitude()
  lon!: number;
}

export class NewsQueryDto {
  @ApiPropertyOptional({ example: 'Tema port', description: 'Place or keyword. Preferred over lat/lon.' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    description: 'Used only when q is absent: resolved to the place of the nearest active hazard.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lon?: number;
}
