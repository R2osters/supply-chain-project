import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { USER_ROLES, type UserRole } from '@scip/shared';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { lower } from '../auth/dto/auth.dto';
import { STRONG_PASSWORD, STRONG_PASSWORD_MESSAGE } from '../auth/password-policy';

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

/** A blank string means "no value": clearing a form field erases the stored one. */
const trimOrNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  return text === '' ? null : text;
};

export class UserQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: USER_ROLES })
  @IsOptional()
  @IsIn(USER_ROLES)
  role?: UserRole;
}

export class CreateUserDto {
  @ApiProperty({ example: 'kofi.asante@acme-logistics.com' })
  @IsEmail()
  @MaxLength(254)
  @Transform(lower)
  email!: string;

  @ApiProperty({ example: 'Kofi' })
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @ApiProperty({ example: 'Asante' })
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;

  @ApiPropertyOptional({ example: '+233201234567' })
  @IsOptional()
  @IsString()
  @Transform(trimOrNull)
  @MaxLength(30)
  phone?: string | null;

  @ApiProperty({ enum: USER_ROLES, description: 'SUPER_ADMIN is never accepted.' })
  @IsIn(USER_ROLES)
  role!: UserRole;

  @ApiPropertyOptional({
    description:
      'Optional. Without it the API generates a 16-character one. Either way it is returned once ' +
      'and must be changed at the first sign-in.',
    minLength: 12,
  })
  @IsOptional()
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  @Matches(STRONG_PASSWORD, { message: `temporary ${STRONG_PASSWORD_MESSAGE}` })
  temporaryPassword?: string;

  @ApiPropertyOptional({ description: 'DRIVER only: the driver profile this account reports for.' })
  @IsOptional()
  @IsString()
  driverId?: string;

  @ApiPropertyOptional({ description: 'Required when role = SUPPLIER.' })
  @IsOptional()
  @IsString()
  linkedSupplierId?: string;

  @ApiPropertyOptional({ description: 'Required when role = CUSTOMER.' })
  @IsOptional()
  @IsString()
  linkedCustomerId?: string;

  @ApiPropertyOptional({ description: 'SUPER_ADMIN only; everyone else creates in their own company.' })
  @IsOptional()
  @IsString()
  companyId?: string;
}

/**
 * Every field optional; `null` clears the nullable ones (phone, links). E-mail is not editable:
 * it is the sign-in name, and changing it silently would lock the person out.
 */
export class UpdateUserDto {
  @ApiPropertyOptional()
  @ValidateIf((dto: UpdateUserDto) => dto.firstName !== undefined)
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(80)
  firstName?: string;

  @ApiPropertyOptional()
  @ValidateIf((dto: UpdateUserDto) => dto.lastName !== undefined)
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(80)
  lastName?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @Transform(trimOrNull)
  @MaxLength(30)
  phone?: string | null;

  @ApiPropertyOptional({ enum: USER_ROLES })
  @ValidateIf((dto: UpdateUserDto) => dto.role !== undefined)
  @IsIn(USER_ROLES)
  role?: UserRole;

  @ApiPropertyOptional()
  @ValidateIf((dto: UpdateUserDto) => dto.isActive !== undefined)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'Links (id) or unlinks (null) a driver profile. DRIVER only.' })
  @IsOptional()
  @IsString()
  driverId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  linkedSupplierId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  linkedCustomerId?: string | null;
}
