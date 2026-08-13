import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import {
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  RECOMMENDATION_PRIORITIES,
  RECOMMENDATION_STATUSES,
  RECOMMENDATION_TYPES,
  type IncidentSeverity,
  type IncidentStatus,
  type IncidentType,
  type RecommendationPriority,
  type RecommendationStatus,
  type RecommendationType,
} from '@scip/shared';
import { PaginationQueryDto } from './pagination.dto';

/**
 * Query DTOs for the list endpoints that filter.
 *
 * The global ValidationPipe runs with `whitelist` and `forbidNonWhitelisted`, which is what stops
 * mass-assignment — but it applies to query strings too. A controller that binds
 * `@Query() query: PaginationQueryDto` and *also* reads `@Query('status')` looks correct and
 * returns 400 for the very parameter it documents, because `status` is not a declared property of
 * the bound DTO. Every filter therefore has to be declared here.
 *
 * Booleans arrive as the strings `"true"`/`"false"`; `@Type(() => Boolean)` would coerce
 * `"false"` to `true`, so the transform is explicit.
 */
const asBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

export class RecommendationQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: RECOMMENDATION_STATUSES, default: 'OPEN' })
  @IsOptional()
  @IsIn(RECOMMENDATION_STATUSES)
  status?: RecommendationStatus;

  @ApiPropertyOptional({ enum: RECOMMENDATION_PRIORITIES })
  @IsOptional()
  @IsIn(RECOMMENDATION_PRIORITIES)
  priority?: RecommendationPriority;

  @ApiPropertyOptional({ enum: RECOMMENDATION_TYPES })
  @IsOptional()
  @IsIn(RECOMMENDATION_TYPES)
  type?: RecommendationType;
}

export class IncidentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: INCIDENT_STATUSES })
  @IsOptional()
  @IsIn(INCIDENT_STATUSES)
  status?: IncidentStatus;

  @ApiPropertyOptional({ enum: INCIDENT_SEVERITIES })
  @IsOptional()
  @IsIn(INCIDENT_SEVERITIES)
  severity?: IncidentSeverity;

  @ApiPropertyOptional({ enum: INCIDENT_TYPES })
  @IsOptional()
  @IsIn(INCIDENT_TYPES)
  type?: IncidentType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  shipmentId?: string;
}

export class NotificationQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(asBoolean)
  @IsBoolean()
  unreadOnly?: boolean;
}

export class DeliveryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED', 'DELIVERED', 'FAILED'] })
  @IsOptional()
  @IsIn(['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED', 'DELIVERED', 'FAILED'])
  status?: string;
}
