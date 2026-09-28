import { BadRequestException, Controller, Get, Header, Param, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermissions } from '../../common/decorators';
import { parseTileSegment } from './tile-budget';
import { TrafficService } from './traffic.service';

@ApiBearerAuth()
@ApiTags('traffic')
@Controller('traffic')
export class TrafficController {
  constructor(private readonly traffic: TrafficService) {}

  @Get('status')
  @RequirePermissions('gps:read')
  @ApiOperation({
    summary: 'Whether the live traffic overlay is available',
    description: 'Enabled only when a TomTom key is configured. Reports today\'s tile usage against the daily budget.',
  })
  status() {
    return this.traffic.status();
  }

  @Get('tiles/:z/:x/:y')
  @RequirePermissions('gps:read')
  // One map view loads dozens of tiles at once and again on every pan; the global per-minute
  // limit is sized for API calls, not tiles, and would blank the overlay mid-drag.
  @Throttle({ default: { limit: 1200, ttl: 60_000 } })
  @Header('Cache-Control', 'private, max-age=120')
  @ApiProduces('image/png')
  @ApiOperation({
    summary: 'TomTom traffic-flow raster tile (256 px PNG)',
    description:
      'Slippy-map z/x/y. 404 when live traffic is not enabled, 429 once the daily tile budget is ' +
      'spent (cached tiles are still served), 502 when TomTom is unreachable.',
  })
  async tile(@Param('z') z: string, @Param('x') x: string, @Param('y') y: string): Promise<StreamableFile> {
    const [zoom, column, row] = [z, x, y.replace(/\.png$/i, '')].map(parseTileSegment);
    if (zoom === null || column === null || row === null) throw new BadRequestException('Invalid tile coordinates');
    const png = await this.traffic.getTile(zoom, column, row);
    return new StreamableFile(png, { type: 'image/png', length: png.length });
  }
}
