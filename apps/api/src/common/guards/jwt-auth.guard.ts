import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators';

/**
 * Applied globally in AppModule. Routes opt out with `@Public()` rather than opting in,
 * so a newly added controller is protected by default instead of accidentally open.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  /**
   * Same rule as Passport's default (an error from the strategy wins, no user is a 401), but a
   * missing or unreadable token is explained in French instead of the bare "Unauthorized".
   */
  handleRequest<TUser>(err: unknown, user: TUser | false | null): TUser {
    if (err) throw err;
    if (!user) throw new UnauthorizedException('Authentification requise : connectez-vous pour continuer');
    return user;
  }
}
