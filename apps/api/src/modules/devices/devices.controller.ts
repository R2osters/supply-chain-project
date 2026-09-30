import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Audit, CurrentUser, Public, RequirePermissions } from '../../common/decorators';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { DeviceGatewayService } from './device-gateway.service';
import { DevicesService } from './devices.service';

/* ------------------------------------------------------------------------ DTOs */

export class EnrolDeviceDto {
  @ApiProperty({
    enum: ['PHONE', 'GT06', 'TELTONIKA', 'MANUAL'],
    description:
      'PHONE = the driver’s own smartphone, no hardware. GT06 = a €15–50 hardwired tracker.',
  })
  @IsIn(['PHONE', 'GT06', 'TELTONIKA', 'MANUAL'])
  kind!: 'PHONE' | 'GT06' | 'TELTONIKA' | 'MANUAL';

  @ApiProperty({
    description: 'IMEI for a hardware tracker (15 digits, printed on the device). Any stable id for a phone.',
    example: '860123456789012',
  })
  @IsString()
  @MaxLength(64)
  identifier!: string;

  @ApiPropertyOptional({ description: 'The vehicle this device travels with.' })
  @IsOptional()
  @IsString()
  vehicleId?: string;

  @ApiPropertyOptional({ example: 'Kwame’s phone' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}

export class PhoneFixDto {
  @ApiProperty()
  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsLongitude()
  longitude!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(400)
  speedKmh?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(359.999)
  headingDegrees?: number;

  @ApiPropertyOptional({ description: 'Reported horizontal accuracy in metres.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  accuracyM?: number;

  @ApiPropertyOptional({ description: 'Phone battery, 0–100. Lets dispatch see a phone about to die.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  batteryPercent?: number;

  @ApiProperty()
  @IsDateString()
  recordedAt!: string;
}

export class PhoneBatchDto {
  @ApiProperty({ description: 'The device identifier issued at enrolment.' })
  @IsString()
  @MaxLength(64)
  identifier!: string;

  @ApiProperty({ description: 'The pairing secret shown once at enrolment.' })
  @IsString()
  @MaxLength(128)
  secret!: string;

  @ApiProperty({
    type: [PhoneFixDto],
    description:
      'Up to 500 fixes. A phone on a rural route buffers while it has no signal and flushes when it returns.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PhoneFixDto)
  fixes!: PhoneFixDto[];
}

/* ------------------------------------------------------------------ controller */

@ApiTags('devices')
@Controller('devices')
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly gateway: DeviceGatewayService,
  ) {}

  @Get()
  @ApiBearerAuth()
  @RequirePermissions('vehicle:read')
  @ApiOperation({
    summary: 'List tracking devices with their health',
    description:
      '`isReportingLate` is measured against each device’s own expected interval — a phone at ' +
      '30 s and a parked tracker at an hour are both healthy at very different silences.',
  })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.devices.list(user);
  }

  @Get('gateway/status')
  @ApiBearerAuth()
  @RequirePermissions('vehicle:read')
  @ApiOperation({
    summary: 'Is the hardware-tracker listener up, and what has it seen',
    description: 'Includes the exact SMS to send a tracker to point it at this server.',
  })
  gatewayStatus() {
    return this.gateway.status();
  }

  @Post()
  @ApiBearerAuth()
  @RequirePermissions('vehicle:create')
  @Audit('ENROL', 'device')
  @ApiOperation({
    summary: 'Enrol a device',
    description:
      'Returns step-by-step setup instructions for the device kind. A PHONE also receives a ' +
      'pairing secret, shown once: a driver’s access token expires in 15 minutes and a phone in ' +
      'a coverage gap cannot refresh it, which is exactly where tracking matters most.',
  })
  enrol(@CurrentUser() user: AuthenticatedUser, @Body() dto: EnrolDeviceDto) {
    return this.devices.enrol(user, dto);
  }

  @Delete(':id')
  @ApiBearerAuth()
  @RequirePermissions('vehicle:delete')
  @Audit('DISABLE', 'device')
  @ApiOperation({ summary: 'Disable a device and unbind it from its vehicle' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.devices.remove(user, id);
  }

  /* ------------------------------------------------------------ phone ingest */

  @Public()
  @Post('phone/positions')
  // A phone posts a batch every 30 s; a flushed backlog is one request, not many. This ceiling is
  // generous for a fleet and finite for anything else.
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Post a batch of positions from a driver’s phone',
    description:
      'Authenticated by the device identifier and pairing secret rather than a user session, ' +
      'because a phone in a coverage gap cannot refresh an expired access token. The response ' +
      'reports how many fixes were accepted and how many were rejected, so the driver’s app can ' +
      'show progress instead of a silent success that stored nothing.',
  })
  async ingestPhone(@Body() dto: PhoneBatchDto) {
    const deviceId = await this.devices.authenticatePhone(dto.identifier, dto.secret);
    if (!deviceId) {
      // Deliberately vague: a precise reason tells someone probing which half to fix.
      return { accepted: 0, rejected: dto.fixes.length, error: 'Balise non reconnue' };
    }

    const result = await this.devices.ingestPhoneBatch(
      dto.identifier,
      dto.fixes.map((fix) => ({
        latitude: fix.latitude,
        longitude: fix.longitude,
        speedKmh: fix.speedKmh ?? null,
        headingDegrees: fix.headingDegrees ?? null,
        accuracyM: fix.accuracyM ?? null,
        batteryPercent: fix.batteryPercent ?? null,
        recordedAt: new Date(fix.recordedAt),
      })),
    );

    return {
      ...result,
      /** How long the phone should wait before the next batch. */
      nextIntervalSeconds: 30,
    };
  }
}
