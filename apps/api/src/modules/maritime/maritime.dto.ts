import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export const VESSEL_TYPES = [
  'CONTAINER',
  'BULK_CARRIER',
  'TANKER',
  'GENERAL_CARGO',
  'RORO',
  'REEFER',
  'FEEDER',
  'OTHER',
] as const;

export const VOYAGE_STATUSES = [
  'SCHEDULED',
  'LOADING',
  'AT_SEA',
  'APPROACHING',
  'BERTHED',
  'DISCHARGING',
  'COMPLETED',
  'CANCELLED',
] as const;

/**
 * The search box.
 *
 * One field, because a user holding a bill of lading has *one* identifier and does not know or
 * care which kind it is. "Ever Given", "9811000", "353136000" and "H3RC" all go in the same box
 * and the service works out what it was given.
 */
export class VesselSearchDto {
  @ApiProperty({
    description: 'Vessel name, former name, IMO number, MMSI or call sign. Partial names match.',
    example: 'Ever Given',
  })
  @IsString()
  @MinLength(2, { message: 'Saisissez au moins 2 caractères pour lancer la recherche' })
  @MaxLength(80)
  q!: string;

  @ApiPropertyOptional({ default: 20, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'Include vessels the company does not operate — anything seen on the public AIS feed.',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  includeUntracked?: string;
}

export class VesselQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: VESSEL_TYPES })
  @IsOptional()
  @IsIn(VESSEL_TYPES)
  type?: string;

  @ApiPropertyOptional({ description: 'Only vessels that have reported within the last hour.' })
  @IsOptional()
  @IsIn(['true', 'false'])
  reportingOnly?: string;
}

export class CreateVesselDto {
  @ApiProperty({ example: 'MSC Accra' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    example: '9811000',
    description: 'IMO number: 7 digits, permanent for the life of the hull.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{7}$/, { message: 'Le numéro IMO (imoNumber) doit comporter exactement 7 chiffres' })
  imoNumber?: string;

  @ApiPropertyOptional({
    example: '353136000',
    description: 'MMSI: 9 digits, the identity broadcast over AIS.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{9}$/, { message: 'Le MMSI (mmsi) doit comporter exactement 9 chiffres' })
  mmsi?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(16)
  callSign?: string;

  @ApiPropertyOptional({ enum: VESSEL_TYPES, default: 'CONTAINER' })
  @IsOptional()
  @IsIn(VESSEL_TYPES)
  type?: string;

  @ApiPropertyOptional({ example: 'PA' })
  @IsOptional()
  @IsString()
  @MaxLength(4)
  flag?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  capacityTeu?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  deadweightTonnes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  operator?: string;
}

export class CreatePortDto {
  @ApiProperty({ example: 'GHTEM', description: 'UN/LOCODE: 2-letter country + 3-letter place.' })
  @IsString()
  @Matches(/^[A-Z]{2}[A-Z0-9]{3}$/, {
    message: 'Le locode doit être un code UN/LOCODE de 5 caractères, par exemple GHTEM',
  })
  locode!: string;

  @ApiProperty({ example: 'Tema' })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'GH' })
  @IsString()
  @MaxLength(4)
  country!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsLongitude()
  longitude!: number;
}

export class CreateVoyageDto {
  @ApiProperty()
  @IsString()
  vesselId!: string;

  @ApiProperty()
  @IsString()
  originPortId!: string;

  @ApiProperty()
  @IsString()
  destinationPortId!: string;

  @ApiProperty({ example: '084W' })
  @IsString()
  @MaxLength(20)
  voyageNumber!: string;

  @ApiProperty()
  @IsString()
  scheduledDepartureAt!: string;

  @ApiPropertyOptional({
    description: 'Derived from distance and the vessel’s service speed when omitted.',
  })
  @IsOptional()
  @IsString()
  scheduledArrivalAt?: string;
}

export class UpdateVoyageStatusDto {
  @ApiProperty({ enum: VOYAGE_STATUSES })
  @IsIn(VOYAGE_STATUSES)
  status!: string;
}

/** Manual position report, for a vessel with no AIS coverage or an agent phoning it in. */
export class ReportVesselPositionDto {
  @ApiProperty()
  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsLongitude()
  longitude!: number;

  @ApiPropertyOptional({ description: 'Speed over ground, knots.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(60)
  speedKnots?: number;

  @ApiPropertyOptional({ description: 'Course over ground, degrees.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(359.9)
  courseDegrees?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(30)
  draughtM?: number;

  @ApiPropertyOptional({ description: 'ISO datetime. Defaults to now.' })
  @IsOptional()
  @IsString()
  recordedAt?: string;
}
