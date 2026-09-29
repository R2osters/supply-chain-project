import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';

const upper = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/** True for an IANA zone the runtime knows ("Africa/Accra"), false for "GMT+7" typos. */
export function isKnownTimezone(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function IsTimezone(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isTimezone',
      target: target.constructor,
      propertyName: propertyName as string,
      options: { message: 'timezone must be an IANA time zone such as Africa/Accra', ...options },
      validator: { validate: isKnownTimezone },
    });
  };
}

/** Omit a field to leave it unchanged. */
export class UpdateCompanyDto {
  @ApiPropertyOptional({ example: 'Acme Logistics' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: 'GHS', description: 'ISO 4217 code; amounts are shown in it.' })
  @IsOptional()
  @Transform(upper)
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a three-letter ISO 4217 code' })
  currency?: string;

  @ApiPropertyOptional({ example: 'Africa/Accra' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @IsTimezone()
  timezone?: string;
}
