import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { IngestGpsDto, NearbyQueryDto } from './gps.dto';
import { GpsService } from './gps.service';

@ApiBearerAuth()
@ApiTags('gps')
@Controller('telemetry')
export class GpsController {
  constructor(private readonly service: GpsService) {}

  @Post('gps')
  // Telemetry is high-frequency by nature; the default 120/min would throttle a fleet posting
  // every 5 s. Batching keeps the request count low, so this ceiling is generous but finite.
  @Throttle({ default: { limit: 1200, ttl: 60_000 } })
  @RequirePermissions('gps:create')
  @ApiOperation({
    summary: 'Ingest GPS fixes',
    description:
      'Accepts a batch so a device can flush its buffer after losing signal. Every fix is ' +
      'validated for clock skew, implausible implied speed and parked-vehicle jitter; the ' +
      'response reports exactly what was rejected and why. This is a real ingest endpoint — ' +
      'point a physical tracker at it and the map will move.',
  })
  ingest(@CurrentUser() user: AuthenticatedUser, @Body() dto: IngestGpsDto) {
    return this.service.ingest(user, dto);
  }

  @Get('fleet')
  @RequirePermissions('gps:read')
  @ApiOperation({
    summary: 'Live map snapshot',
    description:
      'One row per recently-reporting vehicle, with the shipment on board, its destination and ' +
      'ETA. `isDemoData` marks vehicles driven by the built-in simulator.',
  })
  fleet(@CurrentUser() user: AuthenticatedUser) {
    return this.service.fleet(user);
  }

  @Get('nearby')
  @RequirePermissions('gps:read')
  @ApiOperation({
    summary: 'Vehicles within a radius of a point',
    description: 'Index-assisted PostGIS ST_DWithin over the generated geography column.',
  })
  nearby(@CurrentUser() user: AuthenticatedUser, @Query() query: NearbyQueryDto) {
    return this.service.nearby(user, query);
  }

  @Get('near-warehouses')
  @RequirePermissions('gps:read')
  @ApiOperation({ summary: 'Vehicles approaching each warehouse' })
  @ApiQuery({ name: 'radiusKm', required: false, description: 'Default 20.' })
  nearWarehouses(@CurrentUser() user: AuthenticatedUser, @Query('radiusKm') radiusKm?: string) {
    const parsed = Number.parseFloat(radiusKm ?? '20');
    return this.service.nearWarehouses(user, Number.isFinite(parsed) ? parsed : 20);
  }

  @Get('vehicles/:vehicleId/history')
  @RequirePermissions('gps:read')
  @ApiOperation({ summary: 'Raw position history for one vehicle' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'limit', required: false })
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('vehicleId') vehicleId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number.parseInt(limit ?? '1000', 10);
    return this.service.history(user, vehicleId, from, to, Number.isFinite(parsed) ? parsed : 1000);
  }
}
