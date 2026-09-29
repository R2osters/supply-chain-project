import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { Audit, RequirePermissions } from '../../common/decorators';
import { FeedSettingsService } from './feed-settings.service';

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

@ApiBearerAuth()
@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly feeds: FeedSettingsService) {}

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
