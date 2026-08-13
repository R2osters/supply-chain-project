import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { User } from '@prisma/client';
import type { UserRole } from '@scip/shared';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtAccessPayload } from '../../common/types/authenticated-user';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface TokenContext {
  userAgent?: string;
  ipAddress?: string;
}

/**
 * Access + refresh token lifecycle, with rotation and reuse detection.
 *
 * Each login starts a *family*. Every refresh rotates the token inside that family and marks the
 * old one revoked. If a token that is already revoked is presented again, the only explanations
 * are a replayed stolen token or a client bug — either way the whole family is revoked, forcing a
 * fresh login. This is the standard OAuth 2.0 BCP refresh-token-rotation defence and it is the
 * reason refresh tokens are opaque DB rows rather than self-contained JWTs.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly auth: AppConfig['auth'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<{ auth: AppConfig['auth'] }, true>,
  ) {
    this.auth = this.config.get('auth', { infer: true });
  }

  private static sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private signAccessToken(user: Pick<User, 'id' | 'email' | 'role' | 'companyId' | 'linkedSupplierId' | 'linkedCustomerId'>): string {
    const payload: JwtAccessPayload = {
      sub: user.id,
      email: user.email,
      role: user.role as UserRole,
      companyId: user.companyId,
      supplierId: user.linkedSupplierId,
      customerId: user.linkedCustomerId,
      type: 'access',
    };
    return this.jwt.sign(payload, {
      secret: this.auth.accessSecret,
      // Seconds rather than the raw "15m" string: @nestjs/jwt types `expiresIn` against the `ms`
      // library's StringValue union, which a plain `string` from config does not satisfy.
      expiresIn: TokenService.durationToSeconds(this.auth.accessTtl),
    });
  }

  /** Seconds represented by a duration string like `15m`, `7d`, `900`. */
  static durationToSeconds(duration: string): number {
    const match = /^(\d+)\s*([smhd])?$/.exec(duration.trim());
    if (!match) return 900;
    const value = Number.parseInt(match[1], 10);
    switch (match[2]) {
      case 'd':
        return value * 86400;
      case 'h':
        return value * 3600;
      case 'm':
        return value * 60;
      default:
        return value;
    }
  }

  /** Starts a new token family — used on login, register and password reset. */
  async issueForUser(user: User, context: TokenContext = {}): Promise<IssuedTokens> {
    return this.issue(user, randomUUID(), context);
  }

  private async issue(user: User, familyId: string, context: TokenContext): Promise<IssuedTokens> {
    const refreshToken = randomBytes(48).toString('base64url');
    const ttlSeconds = TokenService.durationToSeconds(this.auth.refreshTtl);

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: TokenService.sha256(refreshToken),
        familyId,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        userAgent: context.userAgent?.slice(0, 255) ?? null,
        ipAddress: context.ipAddress ?? null,
      },
    });

    return {
      accessToken: this.signAccessToken(user),
      refreshToken,
      expiresIn: TokenService.durationToSeconds(this.auth.accessTtl),
    };
  }

  /**
   * Rotates a refresh token. Throws 401 for anything suspicious, and revokes the whole family
   * when a revoked token is replayed.
   */
  async rotate(presentedToken: string, context: TokenContext = {}): Promise<IssuedTokens> {
    const tokenHash = TokenService.sha256(presentedToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (stored.revokedAt) {
      // Replay of an already-rotated token: assume compromise, burn the family.
      await this.revokeFamily(stored.familyId);
      this.logger.warn(
        `Refresh token reuse detected for user ${stored.userId}; family ${stored.familyId} revoked`,
      );
      throw new UnauthorizedException('Refresh token reuse detected — please sign in again');
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    if (!stored.user.isActive) {
      await this.revokeFamily(stored.familyId);
      throw new UnauthorizedException('Account is disabled');
    }

    const issued = await this.issue(stored.user, stored.familyId, context);

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: {
        revokedAt: new Date(),
        replacedById: TokenService.sha256(issued.refreshToken),
      },
    });

    return issued;
  }

  /** Revokes a single presented token (logout on this device). Idempotent. */
  async revoke(presentedToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: TokenService.sha256(presentedToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Logout everywhere — also used after a password change or reset. */
  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /** Housekeeping: drop rows that can no longer authenticate anything. */
  async purgeExpired(olderThanDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86400 * 1000);
    const result = await this.prisma.refreshToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: cutoff } }] },
    });
    return result.count;
  }
}
