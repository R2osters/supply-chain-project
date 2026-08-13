import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min, IsIn } from 'class-validator';

export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 25;

  @ApiPropertyOptional({ description: 'Free-text search. Meaning depends on the endpoint.' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order: 'asc' | 'desc' = 'desc';

  @ApiPropertyOptional({ description: 'Column to sort by. Validated per endpoint.' })
  @IsOptional()
  @IsString()
  sortBy?: string;

  get skip(): number {
    return (this.page - 1) * this.limit;
  }
}

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
  };
}

export function paginated<T>(data: T[], total: number, query: PaginationQueryDto): PaginatedResult<T> {
  const totalPages = Math.max(1, Math.ceil(total / query.limit));
  return {
    data,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNextPage: query.page < totalPages,
    },
  };
}

/**
 * Guards against `?sortBy=` injection into Prisma's orderBy: only columns a controller
 * explicitly allows can be sorted on.
 */
export function safeOrderBy(
  query: PaginationQueryDto,
  allowed: readonly string[],
  fallback: string,
): Record<string, 'asc' | 'desc'> {
  const column = query.sortBy && allowed.includes(query.sortBy) ? query.sortBy : fallback;
  return { [column]: query.order };
}
