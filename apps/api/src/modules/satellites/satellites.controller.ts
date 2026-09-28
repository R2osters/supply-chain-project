import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators';
import { TleQueryDto, VisibleQueryDto } from './satellites.dto';
import { SatellitesService } from './satellites.service';

@ApiBearerAuth()
@ApiTags('satellites')
@Controller('satellites')
export class SatellitesController {
  constructor(private readonly satellites: SatellitesService) {}

  @Get('groups')
  @RequirePermissions('gps:read')
  @ApiOperation({ summary: 'Satellite groups available for the orbital layer' })
  groups() {
    return this.satellites.listGroups();
  }

  @Get('tle')
  @RequirePermissions('gps:read')
  @ApiOperation({
    summary: 'Two-line element sets for one group',
    description:
      'Validated TLEs from CelesTrak for client-side propagation. Refreshed at most every two ' +
      'hours; `stale: true` means CelesTrak could not be reached and an older copy (at most 24 h) ' +
      'is being served.',
  })
  tle(@Query() query: TleQueryDto) {
    return this.satellites.getTle(query.group ?? 'gps-ops');
  }

  @Get('visible')
  @RequirePermissions('gps:read')
  @ApiOperation({
    summary: 'Satellites above a position right now',
    description:
      'Propagates every satellite in the group to the current instant (SGP4) and returns those ' +
      'above the elevation mask, highest first. `summary.quality` rates the GNSS geometry: fewer ' +
      'than 4 satellites means no reliable fix; 8 or more with at least 4 above 30° is good.',
  })
  visible(@Query() query: VisibleQueryDto) {
    return this.satellites.getVisible(query.lat, query.lon, query.group ?? 'gps-ops', query.minElevationDeg ?? 10);
  }
}
