import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  AllowPendingPasswordChange,
  Audit,
  CurrentUser,
  Public,
  RequirePermissions,
} from '../../common/decorators';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { requireCompanyId } from '../../common/tenancy/tenant-scope';
import { AuthService } from './auth.service';
import { LocalRecoveryGuard } from './local-recovery.guard';
import { LocalRecoveryService } from './local-recovery.service';
import {
  AuthTokensDto,
  ChangePasswordDto,
  ForgotPasswordDto,
  InviteUserDto,
  LocalRecoveryDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dto/auth.dto';

const context = (req: Request) => ({
  userAgent: req.get('user-agent') ?? undefined,
  ipAddress: req.ip ?? undefined,
});

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly recovery: LocalRecoveryService,
  ) {}

  @Public()
  // Signup is expensive (Argon2 + a transaction) and attractive to abuse; keep it tight.
  @Throttle({ default: { limit: 5, ttl: 3600_000 } })
  @Post('register')
  @ApiOperation({ summary: 'Create a company and its first administrator' })
  @ApiResponse({ status: 201, type: AuthTokensDto })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register(dto, context(req));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange credentials for an access + refresh token pair' })
  @ApiResponse({ status: 200, type: AuthTokensDto })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, context(req));
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate a refresh token',
    description:
      'Returns a new pair and revokes the presented token. Presenting an already-rotated token ' +
      'revokes the entire session family — that is the reuse-detection path, not a bug.',
  })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, context(req));
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke one refresh token (sign out on this device)' })
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @AllowPendingPasswordChange()
  @ApiOperation({ summary: 'Revoke every session for the current user' })
  logoutAll(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.logoutAll(user.id);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a password-reset token',
    description: 'Always returns success, whether or not the address is registered.',
  })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.email);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a new password using a reset token' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm an email address' })
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(dto.token);
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 900_000 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Send a fresh verification email' })
  resendVerification(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.resendVerification(user.id);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @AllowPendingPasswordChange()
  @Audit('CHANGE_PASSWORD', 'user')
  @ApiOperation({
    summary: 'Change your own password (revokes all sessions)',
    description: 'Also how an account leaves its temporary password: it clears mustChangePassword.',
  })
  changePassword(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.id, dto);
  }

  @Get('me')
  @ApiBearerAuth()
  @AllowPendingPasswordChange()
  @ApiOperation({ summary: 'Profile of the authenticated user' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user.id);
  }

  /**
   * Desktop-only "forgot password": the shell on this PC exchanges its local recovery token for
   * an administrator's temporary password (see LocalRecoveryService for why that is safe).
   * Not in Swagger: its only client is apps/desktop/src-tauri/src/recovery.rs.
   */
  @Public()
  @UseGuards(LocalRecoveryGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('local-recovery')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  localRecovery(@Body() dto: LocalRecoveryDto, @Req() req: Request) {
    return this.recovery.recover(dto.email, context(req));
  }

  @Post('invite')
  @ApiBearerAuth()
  @RequirePermissions('user:create')
  @Audit('INVITE_USER', 'user')
  @ApiOperation({
    summary: 'Create a company member',
    description:
      'The invitee receives a password-reset token by email; no administrator ever sees their password.',
  })
  invite(@CurrentUser() user: AuthenticatedUser, @Body() dto: InviteUserDto) {
    return this.auth.inviteUser(requireCompanyId(user), dto, user.role);
  }
}
