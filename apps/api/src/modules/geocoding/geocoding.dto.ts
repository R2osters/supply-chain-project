import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsLatitude, IsLongitude, IsString, Max, MaxLength, Min, MinLength, IsOptional } from 'class-validator';

export class GeocodeQueryDto {
  @ApiProperty({ example: 'Tema port', description: 'A place name, address, or "lat, lon" coordinates.' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  q!: string;

  @ApiPropertyOptional({ default: 5, maximum: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  limit?: number;
}

export class ReverseGeocodeQueryDto {
  @ApiProperty({ example: 5.6037 })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -0.187 })
  @Type(() => Number)
  @IsLongitude()
  lon!: number;
}
