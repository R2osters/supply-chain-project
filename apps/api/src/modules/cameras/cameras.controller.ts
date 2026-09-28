import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { RequirePermissions } from '../../common/decorators';
import { CameraBoundingBoxQueryDto, CameraNearQueryDto } from './cameras.dto';
import { CamerasService } from './cameras.service';

@ApiBearerAuth()
@ApiTags('cameras')
@RequirePermissions('gps:read')
@Controller('cameras')
export class CamerasController {
  constructor(private readonly service: CamerasService) {}

  @Get()
  @ApiOperation({
    summary: 'Public traffic cameras inside a bounding box',
    description:
      'Omit the box to get every loaded camera (up to `limit`). When the limit truncates, the ' +
      'cameras nearest the centre of the box are kept. `packs` reports each source as OK, STALE ' +
      '(last good catalogue, provider currently failing) or UNAVAILABLE.',
  })
  list(@Query() query: CameraBoundingBoxQueryDto) {
    return this.service.listInBoundingBox(query);
  }

  // Declared before `:id` so "near" is never read as a camera id.
  @Get('near')
  @ApiOperation({
    summary: 'Public traffic cameras nearest a point, closest first',
    description: 'Typically called with a stopped truck’s last position. Each camera carries `distanceKm`.',
  })
  near(@Query() query: CameraNearQueryDto) {
    return this.service.listNear(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One camera' })
  @ApiParam({ name: 'id', description: '`<pack>:<upstreamId>`, URL-encoded (e.g. `tfl%3A00001.01251`)' })
  getOne(@Param('id') id: string) {
    return this.service.getCamera(id);
  }

  @Get(':id/frame')
  // An open camera panel polls about every 10 s; several panels per operator is normal.
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Latest still frame from the camera',
    description:
      'Relayed from the provider as served, never stored. The upstream URL is resolved server-side ' +
      'from the camera id; there is no way to pass a URL.',
  })
  @ApiParam({ name: 'id', description: '`<pack>:<upstreamId>`, URL-encoded' })
  @ApiProduces('image/jpeg', 'image/png')
  async frame(@Param('id') id: string, @Res() res: Response): Promise<void> {
    // Resolved before any header is written, so a 404/502 still goes through the JSON error filter.
    const frame = await this.service.getFrame(id);
    res.setHeader('Content-Type', frame.contentType);
    res.setHeader('Content-Length', String(frame.bytes.length));
    res.setHeader('Cache-Control', 'private, max-age=10');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(frame.bytes);
  }
}
