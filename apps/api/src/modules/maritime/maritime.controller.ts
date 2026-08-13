import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import {
  CreatePortDto,
  CreateVesselDto,
  CreateVoyageDto,
  ReportVesselPositionDto,
  VesselQueryDto,
  VesselSearchDto,
} from './maritime.dto';
import { MaritimeService } from './maritime.service';
import { VesselTrackingService } from './vessel-tracking.service';

@ApiBearerAuth()
@ApiTags('maritime')
@Controller('maritime')
export class MaritimeController {
  constructor(
    private readonly service: MaritimeService,
    private readonly tracking: VesselTrackingService,
  ) {}

  /* ---------------------------------------------------------------- search */

  @Get('vessels/search')
  @RequirePermissions('shipment:read')
  @ApiOperation({
    summary: 'Find a vessel by name, IMO, MMSI or call sign',
    description:
      'One box. A user holding a bill of lading has one identifier and does not know which kind ' +
      'it is, so the shape of the input decides how it is matched. Former names are searched too, ' +
      'because ships are renamed on sale and old paperwork carries the old name.',
  })
  search(@CurrentUser() user: AuthenticatedUser, @Query() dto: VesselSearchDto) {
    return this.service.search(user, dto);
  }

  /* ---------------------------------------------------------------- status */

  @Get('status')
  @RequirePermissions('gps:read')
  @ApiOperation({
    summary: 'Which position source is live',
    description:
      'Reports whether positions are coming from a real AIS feed or from the simulator, so ' +
      'nobody has to guess what produced a position on screen.',
  })
  status() {
    return this.tracking.status();
  }

  /* --------------------------------------------------------------- vessels */

  @Get('vessels')
  @RequirePermissions('shipment:read')
  @ApiOperation({ summary: 'List vessels' })
  listVessels(@CurrentUser() user: AuthenticatedUser, @Query() query: VesselQueryDto) {
    return this.service.listVessels(user, query);
  }

  @Get('vessels/:id')
  @RequirePermissions('shipment:read')
  @ApiOperation({ summary: 'One vessel with its recent voyages' })
  getVessel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.getVessel(user, id);
  }

  @Get('vessels/:id/track')
  @RequirePermissions('gps:read')
  @ApiOperation({
    summary: 'Position history, downsampled server-side',
    description: '`sampledEvery` tells you the stride that was applied.',
  })
  @ApiQuery({ name: 'maxPoints', required: false })
  getTrack(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('maxPoints') maxPoints?: string,
  ) {
    const parsed = Number.parseInt(maxPoints ?? '600', 10);
    return this.service.getVesselTrack(user, id, Math.min(Number.isFinite(parsed) ? parsed : 600, 5000));
  }

  @Post('vessels')
  @RequirePermissions('vehicle:create')
  @Audit('CREATE', 'vessel')
  @ApiOperation({
    summary: 'Register a vessel to track',
    description:
      'Needs an IMO number or an MMSI — without one there is nothing for a position feed to match on.',
  })
  createVessel(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateVesselDto) {
    return this.service.createVessel(user, dto);
  }

  @Post('vessels/:id/position')
  @RequirePermissions('gps:create')
  @Audit('REPORT_POSITION', 'vessel')
  @ApiOperation({
    summary: 'Report a position manually',
    description:
      'For a vessel outside AIS coverage, or an agent phoning one in. Stored with source MANUAL, ' +
      'so it stays distinguishable from a broadcast fix.',
  })
  reportPosition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReportVesselPositionDto,
  ) {
    return this.service.reportPosition(user, id, dto);
  }

  /* ----------------------------------------------------------------- ports */

  @Get('ports')
  @RequirePermissions('shipment:read')
  @ApiOperation({ summary: 'Ports, searchable by name, UN/LOCODE or country' })
  listPorts(@Query() query: PaginationQueryDto) {
    return this.service.listPorts(query);
  }

  @Post('ports')
  @RequirePermissions('warehouse:create')
  @Audit('CREATE', 'port')
  createPort(@Body() dto: CreatePortDto) {
    return this.service.createPort(dto);
  }

  /* --------------------------------------------------------------- voyages */

  @Get('voyages')
  @RequirePermissions('shipment:read')
  @ApiQuery({ name: 'status', required: false })
  listVoyages(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
    @Query('status') status?: string,
  ) {
    return this.service.listVoyages(user, query, status);
  }

  @Get('voyages/:id')
  @RequirePermissions('shipment:read')
  @ApiOperation({
    summary: 'One voyage with live progress',
    description:
      'ETA is recomputed from the remaining great-circle distance and the vessel’s observed ' +
      'speed over ground — a ship slow-steaming to save fuel arrives days later than the ' +
      'schedule assumed, and that is the delay worth knowing about a week early.',
  })
  getVoyage(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.getVoyage(user, id);
  }

  @Post('voyages')
  @RequirePermissions('shipment:create')
  @Audit('CREATE', 'voyage')
  @ApiOperation({
    summary: 'Plan a voyage',
    description:
      'Computes the great-circle track and distance, and derives a scheduled arrival from the ' +
      'vessel’s service speed when none is given.',
  })
  createVoyage(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateVoyageDto) {
    return this.service.createVoyage(user, dto);
  }

  /* ------------------------------------------------------------------- map */

  @Get('fleet')
  @RequirePermissions('gps:read')
  @ApiOperation({ summary: 'Everything to draw on the maritime map, in one call' })
  fleet(@CurrentUser() user: AuthenticatedUser) {
    return this.service.fleetSnapshot(user);
  }
}
