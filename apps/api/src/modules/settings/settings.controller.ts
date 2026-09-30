import { Body, Controller, Get, Put } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { Audit, RequirePermissions } from '../../common/decorators';
import type { AppConfig } from '../../config/configuration';
import { DEFAULT_DAILY_TILE_BUDGET } from '../traffic/traffic.service';
import { FeedSettingsService, MAX_TILE_BUDGET } from './feed-settings.service';
import { NetworkSettingsService } from './network-settings.service';

export class UpdateNetworkSettingsDto {
  @IsBoolean()
  lanAccess!: boolean;

  /** Required to expose SCIP while the demo accounts still use their published password. */
  @IsOptional()
  @IsBoolean()
  acknowledgeDemoRisk?: boolean;
}

/** Omit a field to leave it unchanged; send null or an empty string to clear it. */
export class UpdateFeedSettingsDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(512)
  aisStreamApiKey?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(512)
  marineTrafficApiKey?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(256)
  openskyClientId?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(512)
  openskyClientSecret?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(256)
  tomtomApiKey?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(256)
  firmsMapKey?: string | null;
}

/** `null` forgets the chosen budget (back to the default); 0 means unlimited. */
export class UpdateTrafficSettingsDto {
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(MAX_TILE_BUDGET)
  dailyTileBudget!: number | null;
}

@ApiBearerAuth()
@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly feeds: FeedSettingsService,
    private readonly network: NetworkSettingsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Get('network')
  @RequirePermissions('company:update')
  @ApiOperation({ summary: 'Whether SCIP listens to the local network (drivers phones, GPS trackers)' })
  getNetwork() {
    return this.network.status();
  }

  @Put('network')
  @RequirePermissions('company:update')
  @Audit('settings.network.update', 'settings')
  @ApiOperation({ summary: 'Enable or disable local network access; applies after SCIP restarts' })
  updateNetwork(@Body() dto: UpdateNetworkSettingsDto) {
    return this.network.update(dto.lanAccess, dto.acknowledgeDemoRisk === true);
  }

  @Get('feeds')
  @RequirePermissions('company:update')
  @ApiOperation({ summary: 'Which live-feed credentials are set (values are never returned)' })
  getFeeds() {
    return this.shape(this.feeds.describe());
  }

  @Put('feeds')
  @RequirePermissions('company:update')
  @Audit('settings.feeds.update', 'settings')
  @ApiOperation({ summary: 'Set or clear live-feed credentials; feeds reconnect immediately' })
  updateFeeds(@Body() dto: UpdateFeedSettingsDto) {
    return this.shape(this.feeds.update(dto));
  }

  @Get('traffic')
  @RequirePermissions('company:update')
  @ApiOperation({ summary: 'TomTom traffic tiles allowed per UTC day (0 = unlimited)' })
  getTraffic() {
    return this.trafficSettings();
  }

  @Put('traffic')
  @RequirePermissions('company:update')
  @Audit('settings.traffic.update', 'settings')
  @ApiOperation({
    summary: 'Set the TomTom daily tile budget; applies at once',
    description: '0 means unlimited: past the free allowance TomTom bills the tiles or refuses them. null restores the default.',
  })
  updateTraffic(@Body() dto: UpdateTrafficSettingsDto) {
    this.feeds.setTileBudget(dto.dailyTileBudget);
    return this.trafficSettings();
  }

  private trafficSettings() {
    const chosen = this.feeds.getTileBudget();
    return {
      dailyTileBudget: chosen ?? this.config.get('intel', { infer: true }).tomtomDailyTileBudget ?? DEFAULT_DAILY_TILE_BUDGET,
      from: chosen === null ? ('default' as const) : ('settings' as const),
    };
  }

  /** The screen groups keys by provider rather than by variable name. */
  private shape(state: ReturnType<FeedSettingsService['describe']>) {
    return {
      aisStream: state.aisStreamApiKey,
      marineTraffic: state.marineTrafficApiKey,
      openskyClientId: state.openskyClientId,
      openskyClientSecret: state.openskyClientSecret,
      tomtom: state.tomtomApiKey,
      firms: state.firmsMapKey,
    };
  }
}
