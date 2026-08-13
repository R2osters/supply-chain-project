import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { UserRole } from '@scip/shared';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser, JwtAccessPayload } from '../../common/types/authenticated-user';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService<{ auth: AppConfig['auth'] }, true>,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('auth', { infer: true }).accessSecret,
    });
  }

  /**
   * The token is cryptographically valid at this point; this step confirms the *account* is
   * still valid. Without it a deactivated user, or one whose role was downgraded, would keep
   * their old privileges until the access token expired.
   */
  async validate(payload: JwtAccessPayload): Promise<AuthenticatedUser> {
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Wrong token type');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        companyId: true,
        isActive: true,
        linkedSupplierId: true,
        linkedCustomerId: true,
        lockedUntil: true,
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Account is disabled or no longer exists');
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new UnauthorizedException('Account is temporarily locked');
    }

    return {
      id: user.id,
      email: user.email,
      role: user.role as UserRole,
      companyId: user.companyId,
      linkedSupplierId: user.linkedSupplierId,
      linkedCustomerId: user.linkedCustomerId,
    };
  }
}
