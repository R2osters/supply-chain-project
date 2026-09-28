import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators';
import { RadioStationsQueryDto } from './radio.dto';
import { RadioService } from './radio.service';

@ApiBearerAuth()
@ApiTags('radio')
@Controller('radio')
export class RadioController {
  constructor(private readonly radio: RadioService) {}

  @Get('stations')
  @RequirePermissions('gps:read')
  @ApiOperation({
    summary: 'Internet radio stations near a position',
    description:
      'Local news and traffic radio for a driver or dispatcher, from the Radio Browser directory. ' +
      'Only HTTPS MP3/AAC streams are listed. Audio is never proxied: the browser plays the stream ' +
      'directly from the broadcaster. `status` is STALE when the directory could not be refreshed ' +
      'and a cached list is served, UNAVAILABLE when there is nothing to serve.',
  })
  stations(@Query() query: RadioStationsQueryDto) {
    return this.radio.findStations({
      latitude: query.lat,
      longitude: query.lon,
      radiusKm: query.radiusKm ?? 150,
      tag: query.tag ?? null,
      limit: query.limit ?? 40,
    });
  }

  @Post('stations/:id/click')
  @HttpCode(200)
  @RequirePermissions('gps:read')
  @ApiOperation({
    summary: 'Report that a station was played',
    description:
      'Relays a play to Radio Browser, whose popularity ranking depends on these counts. Only ' +
      'station ids this API has listed are relayed; anything else answers `{ ok: false }`.',
  })
  click(@Param('id') id: string) {
    return this.radio.registerClick(id);
  }
}
