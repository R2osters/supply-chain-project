import { BadRequestException, Controller, Get, Header, Param, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermissions } from '../../common/decorators';
import { parseBbox } from './open-flow/bbox';
import { OpenFlowService, type SourceStatus } from './open-flow/open-flow.service';
import { parseTileSegment } from './tile-budget';
import { TOMTOM_ATTRIBUTION, TrafficService } from './traffic.service';

@ApiBearerAuth()
@ApiTags('traffic')
@Controller('traffic')
export class TrafficController {
  constructor(
    private readonly traffic: TrafficService,
    private readonly openFlowService: OpenFlowService,
  ) {}

  @Get('status')
  @RequirePermissions('gps:read')
  @ApiOperation({
    summary: 'Live traffic sources and the TomTom tile budget',
    description:
      '`enabled` is true when a TomTom key is configured; `tilesUsedToday` counts against `dailyBudget` ' +
      '(0 = unlimited). `sources` lists TomTom and the keyless measured-speed sources with their last outcome.',
  })
  status() {
    const tomtom = this.traffic.status();
    const tomtomSource: SourceStatus = {
      id: 'tomtom',
      active: tomtom.enabled && !this.traffic.budgetExhausted(),
      stale: false,
      updatedAt: null,
      attribution: TOMTOM_ATTRIBUTION,
    };
    return { ...tomtom, sources: [tomtomSource, ...this.openFlowService.sources()] };
  }

  @Get('open-flow')
  @RequirePermissions('gps:read')
  @Header('Cache-Control', 'private, max-age=60')
  @ApiOperation({
    summary: 'Measured road speeds from keyless open data inside a box',
    description:
      'GeoJSON LineStrings from Rennes Métropole and Métromobilité (Grenoble), both ODbL: level = current / ' +
      'free-flow speed (0..1, null when unmeasured), closed, speedKmh, limitKmh, bothDirections. ' +
      'bbox = minLon,minLat,maxLon,maxLat, at most 5° wide. Sources outside the box are not asked.',
  })
  openFlow(@Query('bbox') bbox?: string) {
    const box = parseBbox(bbox);
    if (!box) throw new BadRequestException('bbox must be minLon,minLat,maxLon,maxLat, at most 5° wide');
    return this.openFlowService.inBbox(box);
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

  @Get('flow-tiles/:z/:x/:y')
  @RequirePermissions('gps:read')
  @Throttle({ default: { limit: 1200, ttl: 60_000 } })
  @Header('Cache-Control', 'private, max-age=120')
  @ApiProduces('application/vnd.mapbox-vector-tile')
  @ApiOperation({
    summary: 'TomTom traffic-flow vector tile (relative speeds per road line)',
    description:
      'Layer "Traffic flow": traffic_level (current / free-flow speed), road_type, road_closure, ' +
      'traffic_road_coverage. Same budget and errors as the raster tiles: 404 without a key, 429 once ' +
      'the daily budget is spent, 502 when TomTom fails.',
  })
  async flowTile(@Param('z') z: string, @Param('x') x: string, @Param('y') y: string): Promise<StreamableFile> {
    const [zoom, column, row] = [z, x, y.replace(/\.pbf$/i, '')].map(parseTileSegment);
    if (zoom === null || column === null || row === null) throw new BadRequestException('Invalid tile coordinates');
    const tile = await this.traffic.getFlowTile(zoom, column, row);
    return new StreamableFile(tile, { type: 'application/vnd.mapbox-vector-tile', length: tile.length });
  }
}
