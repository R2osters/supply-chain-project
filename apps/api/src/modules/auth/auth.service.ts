import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, User } from '@prisma/client';
import type { UserRole } from '@scip/shared';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { PasswordService } from './password.service';
import { TokenService, type TokenContext } from './token.service';
import type {
  ChangePasswordDto,
  InviteUserDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
} from './dto/auth.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly auth: AppConfig['auth'];
  private readonly singleCompany: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    config: ConfigService<{ auth: AppConfig['auth']; runtime: AppConfig['runtime'] }, true>,
  ) {
    this.auth = config.get('auth', { infer: true });
    this.singleCompany = config.get('runtime', { infer: true }) === 'desktop';
  }

  // -------------------------------------------------------------------- register

  /**
   * Self-service signup. Creates the company and makes the signer-up its COMPANY_ADMIN.
   * Company creation and user creation are one transaction — a half-created tenant with no
   * administrator would be unrecoverable through the UI.
   */
  async register(dto: RegisterDto, context: TokenContext = {}) {
    // A desktop install holds one company. Its API is reachable from the LAN (drivers' phones),
    // so once set up, registration must not let a neighbour open a second tenant on this PC.
    if (this.singleCompany && (await this.prisma.company.count()) > 0) {
      throw new ForbiddenException('SCIP is already set up on this computer; ask an administrator for an invitation');
    }

    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await this.passwords.hash(dto.password);
    const slug = await this.uniqueCompanySlug(dto.companyName);

    const user = await this.prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          name: dto.companyName,
          slug,
          country: dto.companyCountry,
          contactEmail: dto.email,
        },
      });

      return tx.user.create({
        data: {
          companyId: company.id,
          email: dto.email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone ?? null,
          role: 'COMPANY_ADMIN',
        },
      });
    });

    await this.sendVerificationEmail(user);
    const issued = await this.tokens.issueForUser(user, context);
    return { ...issued, user: publicUser(user) };
  }

  private async uniqueCompanySlug(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .normalize('NFD')
        // strip combining diacritics left by NFD ("Café" -> "Cafe")
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'company';

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const taken = await this.prisma.company.findUnique({ where: { slug: candidate } });
      if (!taken) return candidate;
    }
    return `${base}-${randomBytes(4).toString('hex')}`;
  }

  // ----------------------------------------------------------------------- login

  async login(dto: LoginDto, context: TokenContext = {}) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });

    if (!user) {
      // Constant-time-ish: spend the same CPU as a real verification before failing.
      await this.passwords.verifyDecoy(dto.password);
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      throw new UnauthorizedException(`Account locked. Try again in ${minutes} minute(s).`);
    }

    const valid = await this.passwords.verify(user.passwordHash, dto.password);
    if (!valid) {
      await this.registerFailedLogin(user);
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account is disabled');
    }

    const refreshed = await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const issued = await this.tokens.issueForUser(refreshed, context);
    return { ...issued, user: publicUser(refreshed) };
  }

  /**
   * Progressive lockout. The counter is per-account rather than per-IP because an attacker can
   * rotate IPs trivially; rate limiting by IP is handled separately by the throttler.
   */
  private async registerFailedLogin(user: User): Promise<void> {
    const attempts = user.failedLoginCount + 1;
    const shouldLock = attempts >= this.auth.maxFailedLogins;
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: shouldLock ? 0 : attempts,
        lockedUntil: shouldLock ? new Date(Date.now() + this.auth.lockoutMinutes * 60000) : user.lockedUntil,
      },
    });
    if (shouldLock) {
      this.logger.warn(`Account ${user.email} locked after ${attempts} failed attempts`);
    }
  }

  async refresh(refreshToken: string, context: TokenContext = {}) {
    return this.tokens.rotate(refreshToken, context);
  }

  async logout(refreshToken: string): Promise<{ success: true }> {
    await this.tokens.revoke(refreshToken);
    return { success: true };
  }

  async logoutAll(userId: string): Promise<{ sessionsRevoked: number }> {
    return { sessionsRevoked: await this.tokens.revokeAllForUser(userId) };
  }

  // ------------------------------------------------------------- password reset

  /**
   * Always reports success. Telling an anonymous caller whether an address is registered is an
   * account-enumeration oracle, and the extra "helpfulness" buys the legitimate user nothing.
   */
  async forgotPassword(email: string): Promise<{ success: true }> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) return { success: true };

    const token = randomBytes(32).toString('base64url');
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + this.auth.passwordResetTtlMinutes * 60000),
      },
    });

    await this.mail.send({
      to: user.email,
      subject: 'Reset your SCIP password',
      text: [
        `Hello ${user.firstName},`,
        '',
        'Use the token below to reset your password. It expires in ' +
          `${this.auth.passwordResetTtlMinutes} minutes.`,
        '',
        token,
        '',
        'If you did not request this, you can ignore this message — your password is unchanged.',
      ].join('\n'),
    });

    return { success: true };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ success: true }> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256(dto.token) },
      include: { user: true },
    });

    if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('This reset link is invalid or has expired');
    }

    const passwordHash = await this.passwords.hash(dto.password);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      // A reset is a credential change: every existing session must die with the old password.
      this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    return { success: true };
  }

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<{ success: true }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const valid = await this.passwords.verify(user.passwordHash, dto.currentPassword);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('New password must differ from the current one');
    }

    const passwordHash = await this.passwords.hash(dto.newPassword);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    await this.tokens.revokeAllForUser(userId);

    return { success: true };
  }

  // --------------------------------------------------------- email verification

  async sendVerificationEmail(user: User): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      },
    });

    await this.mail.send({
      to: user.email,
      subject: 'Verify your SCIP email address',
      text: [
        `Hello ${user.firstName},`,
        '',
        'Confirm your email address with the token below. It expires in 24 hours.',
        '',
        token,
      ].join('\n'),
    });
  }

  async verifyEmail(token: string): Promise<{ success: true }> {
    const record = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash: sha256(token) },
    });

    if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('This verification link is invalid or has expired');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date() },
      }),
      this.prisma.emailVerificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);

    return { success: true };
  }

  async resendVerification(userId: string): Promise<{ success: true }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.emailVerifiedAt) throw new BadRequestException('Email is already verified');
    await this.sendVerificationEmail(user);
    return { success: true };
  }

  // ---------------------------------------------------------------- invitations

  /**
   * Creates a company member with a random password and mails them a reset token, so an
   * administrator never handles a colleague's credentials.
   */
  async inviteUser(companyId: string, dto: InviteUserDto, invitedByRole: UserRole) {
    if (dto.role === 'SUPER_ADMIN' && invitedByRole !== 'SUPER_ADMIN') {
      throw new BadRequestException('Only a SUPER_ADMIN can create another SUPER_ADMIN');
    }
    if (dto.role === 'SUPPLIER' && !dto.linkedSupplierId) {
      throw new BadRequestException('linkedSupplierId is required for a SUPPLIER portal account');
    }
    if (dto.role === 'CUSTOMER' && !dto.linkedCustomerId) {
      throw new BadRequestException('linkedCustomerId is required for a CUSTOMER portal account');
    }

    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('An account with this email already exists');

    await this.assertPartyBelongsToCompany(companyId, dto);

    const temporaryPassword = randomBytes(24).toString('base64url');
    const passwordHash = await this.passwords.hash(temporaryPassword);

    const user = await this.prisma.user.create({
      data: {
        companyId,
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: dto.role as Prisma.UserCreateInput['role'],
        linkedSupplierId: dto.linkedSupplierId ?? null,
        linkedCustomerId: dto.linkedCustomerId ?? null,
      },
    });

    await this.forgotPassword(user.email);
    return publicUser(user);
  }

  private async assertPartyBelongsToCompany(companyId: string, dto: InviteUserDto): Promise<void> {
    if (dto.linkedSupplierId) {
      const supplier = await this.prisma.supplier.findUnique({ where: { id: dto.linkedSupplierId } });
      if (!supplier || supplier.companyId !== companyId) {
        throw new BadRequestException('linkedSupplierId does not belong to your company');
      }
    }
    if (dto.linkedCustomerId) {
      const customer = await this.prisma.customer.findUnique({ where: { id: dto.linkedCustomerId } });
      if (!customer || customer.companyId !== companyId) {
        throw new BadRequestException('linkedCustomerId does not belong to your company');
      }
    }
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { company: { select: { id: true, name: true, slug: true, currency: true, timezone: true } } },
    });
    if (!user) throw new NotFoundException('User not found');
    return { ...publicUser(user), company: user.company };
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role as UserRole,
    companyId: user.companyId,
    emailVerified: user.emailVerifiedAt !== null,
  };
}
