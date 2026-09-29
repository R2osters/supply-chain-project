import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators';
import { parseBoundingBox } from './aircraft.model';
import { AircraftService } from './aircraft.service';

@ApiBearerAuth()
@ApiTags('aircraft')
@Controller('aircraft')
export class AircraftController {
  constructor(private readonly aircraft: AircraftService) {}

  @Get()
  @RequirePermissions('gps:read')
  @ApiOperation({
    summary: 'Live aircraft in a map view (OpenSky Network, adsb.lol as fallback)',
    description: 'Query: minLat, minLon, maxLat, maxLon. Views wider than 20° are shrunk around their centre.',
  })
  inView(@Query() query: Record<string, string>) {
    const box = parseBoundingBox(query);
    if (!box) throw new BadRequestException('minLat, minLon, maxLat and maxLon must describe a valid box');
    return this.aircraft.inView(box);
  }

  @Get('status')
  @RequirePermissions('gps:read')
  @ApiOperation({ summary: 'Which aircraft source is in use, and the OpenSky quota left' })
  status() {
    return this.aircraft.status();
  }
}
