import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { USER_ROLES, type UserRole } from '@scip/shared';

const lower = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * Password policy: 12+ chars with three of four character classes. Length is weighted more
 * heavily than symbol gymnastics because it is what actually resists offline cracking, and the
 * hash is Argon2id regardless.
 */
const STRONG_PASSWORD =
  /^(?:(?=.*[a-z])(?=.*[A-Z])(?=.*\d)|(?=.*[a-z])(?=.*[A-Z])(?=.*[^\w\s])|(?=.*[a-z])(?=.*\d)(?=.*[^\w\s])|(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s]))[\s\S]{12,}$/;

export class RegisterDto {
  @ApiProperty({ example: 'ops@acme-logistics.com' })
  @IsEmail()
  @Transform(lower)
  email!: string;

  @ApiProperty({ example: 'Str0ng-Passphrase!', minLength: 12 })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  @Matches(STRONG_PASSWORD, {
    message:
      'password must be at least 12 characters and combine at least three of: lowercase, uppercase, digit, symbol',
  })
  password!: string;

  @ApiProperty({ example: 'Ama' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @ApiProperty({ example: 'Mensah' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;

  @ApiProperty({ example: 'Acme Logistics', description: 'Creates a new company owned by this user.' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  companyName!: string;

  @ApiProperty({ example: 'GH' })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  companyCountry!: string;

  @ApiPropertyOptional({ example: '+233201234567' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'admin@demo-scip.com' })
  @IsEmail()
  @Transform(lower)
  email!: string;

  @ApiProperty({ example: 'DemoPassw0rd!2026' })
  @IsString()
  @MaxLength(128)
  password!: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  refreshToken!: string;
}

export class ForgotPasswordDto {
  @ApiProperty()
  @IsEmail()
  @Transform(lower)
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  token!: string;

  @ApiProperty({ minLength: 12 })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  @Matches(STRONG_PASSWORD, {
    message:
      'password must be at least 12 characters and combine at least three of: lowercase, uppercase, digit, symbol',
  })
  password!: string;
}

export class VerifyEmailDto {
  @ApiProperty()
  @IsString()
  token!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  currentPassword!: string;

  @ApiProperty({ minLength: 12 })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  @Matches(STRONG_PASSWORD, {
    message:
      'password must be at least 12 characters and combine at least three of: lowercase, uppercase, digit, symbol',
  })
  newPassword!: string;
}

export class InviteUserDto {
  @ApiProperty()
  @IsEmail()
  @Transform(lower)
  email!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(80)
  firstName!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(80)
  lastName!: string;

  @ApiProperty({ enum: USER_ROLES })
  @IsEnum(Object.fromEntries(USER_ROLES.map((r) => [r, r])))
  role!: UserRole;

  @ApiPropertyOptional({ description: 'Required when role = SUPPLIER.' })
  @IsOptional()
  @IsString()
  linkedSupplierId?: string;

  @ApiPropertyOptional({ description: 'Required when role = CUSTOMER.' })
  @IsOptional()
  @IsString()
  linkedCustomerId?: string;
}

export class AuthTokensDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({ example: 900, description: 'Access token lifetime in seconds.' })
  expiresIn!: number;

  @ApiProperty()
  user!: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: UserRole;
    companyId: string | null;
    emailVerified: boolean;
  };
}
