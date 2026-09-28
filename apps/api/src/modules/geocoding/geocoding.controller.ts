import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators';
import { GeocodeQueryDto, ReverseGeocodeQueryDto } from './geocoding.dto';
import { GeocodingService } from './geocoding.service';

@ApiBearerAuth()
@ApiTags('geocoding')
@Controller('geocode')
export class GeocodingController {
  constructor(private readonly geocoding: GeocodingService) {}

  @Get()
  @RequirePermissions('gps:read')
  @ApiOperation({
    summary: 'Find a place by name, address or coordinates',
    description:
      'Coordinates such as "5.6, -0.18" are answered locally. Otherwise Photon is asked first and ' +
      'Nominatim (OpenStreetMap, 1 request/s for the whole deployment) only when Photon fails or ' +
      'finds nothing. `source` names who answered; `none` with no results means nobody could.',
  })
  search(@Query() query: GeocodeQueryDto) {
    return this.geocoding.search(query.q, query.limit ?? 5);
  }

  @Get('reverse')
  @RequirePermissions('gps:read')
  @ApiOperation({
    summary: 'Describe the place at a position',
    description:
      'Suburb-level description from Nominatim, cached per 0.01° cell (~1 km). `source: none` ' +
      'means Nominatim could not be reached; `nominatim` with null fields means it found nothing there.',
  })
  reverse(@Query() query: ReverseGeocodeQueryDto) {
    return this.geocoding.reverse(query.lat, query.lon);
  }
}
