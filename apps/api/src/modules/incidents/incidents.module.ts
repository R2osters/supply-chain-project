import { Body, Controller, Get, Injectable, Module, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  type IncidentSeverity,
  type IncidentStatus,
  type IncidentType,
} from '@scip/shared';
import { Audit, CurrentUser, RequirePermissions } from '../../common/decorators';
import { PaginationQueryDto, paginated } from '../../common/dto/pagination.dto';
import { IncidentQueryDto } from '../../common/dto/filter-query.dto';
import { companyFilter, requireCompanyId } from '../../common/tenancy/tenant-scope';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/* ------------------------------------------------------------------------ DTOs */

export class CreateIncidentDto {
  @ApiProperty({ enum: INCIDENT_TYPES })
  @IsIn(INCIDENT_TYPES)
  type!: IncidentType;

  @ApiProperty({ example: 'Tyre blowout on the N1' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(4000)
  description!: string;

  @ApiPropertyOptional({ enum: INCIDENT_SEVERITIES, default: 'MEDIUM' })
  @IsOptional()
  @IsIn(INCIDENT_SEVERITIES)
  severity?: IncidentSeverity;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  shipmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional({ description: 'Estimated financial impact, company currency.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  estimatedCost?: number;
}

export class UpdateIncidentDto {
  @ApiPropertyOptional({ enum: INCIDENT_STATUSES })
  @IsOptional()
  @IsIn(INCIDENT_STATUSES)
  status?: IncidentStatus;

  @ApiPropertyOptional({ enum: INCIDENT_SEVERITIES })
  @IsOptional()
  @IsIn(INCIDENT_SEVERITIES)
  severity?: IncidentSeverity;

  @ApiPropertyOptional({ description: 'Required when moving to RESOLVED or CLOSED.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  resolution?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assignedToId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  estimatedCost?: number;
}

/* --------------------------------------------------------------------- service */

@Injectable()
export class IncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(
    user: AuthenticatedUser,
    query: PaginationQueryDto,
    filters: { status?: string; severity?: string; type?: string; shipmentId?: string },
  ) {
    const where: Prisma.IncidentWhereInput = {
      ...companyFilter(user),
      ...(filters.status ? { status: filters.status as never } : {}),
      ...(filters.severity ? { severity: filters.severity as never } : {}),
      ...(filters.type ? { type: filters.type as never } : {}),
      ...(filters.shipmentId ? { shipmentId: filters.shipmentId } : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: 'insensitive' } },
              { description: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.incident.findMany({
        where,
        include: {
          shipment: { select: { id: true, trackingNumber: true, status: true } },
          reportedBy: { select: { id: true, firstName: true, lastName: true } },
          assignedTo: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { occurredAt: query.order },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.incident.count({ where }),
    ]);

    return paginated(data, total, query);
  }

  async findOne(user: AuthenticatedUser, id: string) {
    const incident = await this.prisma.incident.findFirst({
      where: { id, ...companyFilter(user) },
      include: {
        shipment: { select: { id: true, trackingNumber: true, status: true, carrierId: true } },
        reportedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        assignedTo: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
    if (!incident) throw new NotFoundException('Incident not found');
    return incident;
  }

  async create(user: AuthenticatedUser, dto: CreateIncidentDto) {
    const companyId = requireCompanyId(user);

    if (dto.shipmentId) {
      const shipment = await this.prisma.shipment.findFirst({
        where: { id: dto.shipmentId, companyId },
        select: { id: true },
      });
      if (!shipment) throw new NotFoundException('Shipment not found in your company');
    }

    const incident = await this.prisma.$transaction(async (tx) => {
      const created = await tx.incident.create({
        data: {
          companyId,
          shipmentId: dto.shipmentId ?? null,
          type: dto.type as never,
          severity: (dto.severity ?? 'MEDIUM') as never,
          status: 'OPEN',
          title: dto.title,
          description: dto.description,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          estimatedCost: dto.estimatedCost ?? null,
          reportedById: user.id,
        },
      });

      // An incident against a shipment belongs on that shipment's timeline, or the tracking
      // page tells a different story from the incident list.
      if (dto.shipmentId) {
        await tx.shipmentEvent.create({
          data: {
            shipmentId: dto.shipmentId,
            type: 'INCIDENT',
            description: `${dto.type}: ${dto.title}`,
            latitude: dto.latitude ?? null,
            longitude: dto.longitude ?? null,
            metadata: { incidentId: created.id, severity: created.severity } as Prisma.InputJsonValue,
          },
        });
      }

      return created;
    });

    await this.notifications.notify({
      companyId,
      type: 'INCIDENT_CREATED',
      severity: incident.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
      title: `${incident.severity} incident: ${incident.title}`,
      body: incident.description,
      target: { entity: 'incident', id: incident.id },
      channels: incident.severity === 'CRITICAL' ? ['DASHBOARD', 'EMAIL'] : ['DASHBOARD'],
    });

    return incident;
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateIncidentDto) {
    const incident = await this.findOne(user, id);

    const closing = dto.status === 'RESOLVED' || dto.status === 'CLOSED';
    if (closing && !dto.resolution && !incident.resolution) {
      throw new NotFoundException(
        'A resolution is required before an incident can be resolved or closed',
      );
    }

    if (dto.assignedToId) {
      const assignee = await this.prisma.user.findFirst({
        where: { id: dto.assignedToId, companyId: incident.companyId, isActive: true },
        select: { id: true },
      });
      if (!assignee) throw new NotFoundException('Assignee not found in your company');
    }

    const updated = await this.prisma.incident.update({
      where: { id },
      data: {
        ...(dto.status ? { status: dto.status as never } : {}),
        ...(dto.severity ? { severity: dto.severity as never } : {}),
        ...(dto.resolution !== undefined ? { resolution: dto.resolution } : {}),
        ...(dto.assignedToId !== undefined ? { assignedToId: dto.assignedToId } : {}),
        ...(dto.estimatedCost !== undefined ? { estimatedCost: dto.estimatedCost } : {}),
        ...(closing && !incident.resolvedAt ? { resolvedAt: new Date() } : {}),
      },
    });

    if (closing) {
      await this.notifications.notify({
        companyId: incident.companyId,
        type: 'INCIDENT_RESOLVED',
        title: `Incident resolved: ${incident.title}`,
        body: dto.resolution ?? incident.resolution ?? 'Resolved.',
        target: { entity: 'incident', id },
      });
    }

    return updated;
  }

  /** Counts and cost by type and severity — the incident tile on the dashboard. */
  async summary(user: AuthenticatedUser, days = 30) {
    const companyId = requireCompanyId(user);
    const since = new Date(Date.now() - days * 86_400_000);

    const rows = await this.prisma.incident.groupBy({
      by: ['type', 'severity', 'status'],
      where: { companyId, occurredAt: { gte: since } },
      _count: { _all: true },
      _sum: { estimatedCost: true },
    });

    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    let open = 0;
    let totalCost = 0;

    for (const row of rows) {
      byType[row.type] = (byType[row.type] ?? 0) + row._count._all;
      bySeverity[row.severity] = (bySeverity[row.severity] ?? 0) + row._count._all;
      if (row.status === 'OPEN' || row.status === 'INVESTIGATING') open += row._count._all;
      totalCost += Number(row._sum.estimatedCost ?? 0);
    }

    return {
      windowDays: days,
      total: rows.reduce((sum, row) => sum + row._count._all, 0),
      open,
      byType,
      bySeverity,
      estimatedCost: Math.round(totalCost * 100) / 100,
    };
  }
}

/* ------------------------------------------------------------------ controller */

@ApiBearerAuth()
@ApiTags('incidents')
@Controller('incidents')
export class IncidentsController {
  constructor(private readonly service: IncidentsService) {}

  @Get()
  @RequirePermissions('incident:read')
  @ApiOperation({ summary: 'List incidents' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: IncidentQueryDto) {
    return this.service.list(user, query, {
      status: query.status,
      severity: query.severity,
      type: query.type,
      shipmentId: query.shipmentId,
    });
  }

  @Get('summary')
  @RequirePermissions('incident:read')
  @ApiOperation({ summary: 'Counts and estimated cost by type and severity' })
  @ApiQuery({ name: 'days', required: false, description: 'Window in days, default 30.' })
  summary(@CurrentUser() user: AuthenticatedUser, @Query('days') days?: string) {
    const parsed = Number.parseInt(days ?? '30', 10);
    return this.service.summary(user, Number.isFinite(parsed) ? parsed : 30);
  }

  @Get(':id')
  @RequirePermissions('incident:read')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.findOne(user, id);
  }

  @Post()
  @RequirePermissions('incident:create')
  @Audit('CREATE', 'incident')
  @ApiOperation({
    summary: 'Report an incident',
    description:
      'Also lands on the shipment timeline when linked, so the tracking page and the incident ' +
      'list never disagree. CRITICAL incidents are emailed as well as shown on the dashboard.',
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateIncidentDto) {
    return this.service.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions('incident:update')
  @Audit('UPDATE', 'incident')
  @ApiOperation({ summary: 'Update, assign or resolve an incident' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateIncidentDto,
  ) {
    return this.service.update(user, id, dto);
  }
}

/* ---------------------------------------------------------------------- module */

@Module({
  controllers: [IncidentsController],
  providers: [IncidentsService],
  exports: [IncidentsService],
})
export class IncidentsModule {}
