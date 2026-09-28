import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { HazardsQueryDto, NewsQueryDto, WeatherQueryDto } from './hazards.dto';
import { HazardsService } from './hazards.service';

@ApiBearerAuth()
@ApiTags('hazards')
@Controller('hazards')
export class HazardsController {
  constructor(private readonly hazards: HazardsService) {}

  @Get()
  @RequirePermissions('gps:read')
  @ApiOperation({
    summary: 'Active natural hazards: cyclones, earthquakes, fires',
    description:
      'Without a bounding box: worldwide cyclones (NHC basins only) and earthquakes. With one: ' +
      'those inside it plus active fires, which are only ever fetched for a bounded area. Each ' +
      'source reports its own status, so one feed being down never empties the map.',
  })
  list(@Query() query: HazardsQueryDto) {
    return this.hazards.listHazards(query);
  }

  @Get('weather')
  @RequirePermissions('gps:read')
  @ApiOperation({
    summary: 'Current weather at a point, with a 0..1 severity for moving goods',
    description:
      'Served from a 0.1° grid cell (~11 km), so the coordinates returned are the cell’s. ' +
      '`reasons` lists what drove the severity; `stale` is true when the upstream was down.',
  })
  weather(@Query() query: WeatherQueryDto) {
    return this.hazards.getWeather(query);
  }

  @Get('exposure')
  @RequirePermissions('gps:read')
  @ApiOperation({
    summary: 'Which of your warehouses, shipments and suppliers sit near an active hazard',
    description:
      'An asset is exposed when it is within the configured radius plus the hazard’s own ' +
      'radius. Cyclones are also matched against their forecast track. Sorted by severity, ' +
      'then distance.',
  })
  exposure(@CurrentUser() user: AuthenticatedUser) {
    return this.hazards.exposureFor(user);
  }

  @Get('news')
  @RequirePermissions('gps:read')
  @ApiOperation({
    summary: 'Recent news for a place (GDELT)',
    description:
      'Pass q with a place or keyword. With only lat/lon, the nearest active hazard names the ' +
      'place; if there is none, status is UNAVAILABLE with an empty query.',
  })
  news(@Query() query: NewsQueryDto) {
    return this.hazards.news(query);
  }
}
