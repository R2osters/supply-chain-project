import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_PENDING_PASSWORD_CHANGE_KEY, IS_PUBLIC_KEY } from '../decorators';
import type { AuthenticatedUser } from '../types/authenticated-user';

/** Machine-readable reason, so a client can open its "choose your password" screen. */
export const PASSWORD_CHANGE_REQUIRED = 'password-change-required';

/**
 * Global guard, registered right after JwtAuthGuard (it needs `request.user`).
 *
 * A temporary password was chosen by someone else — an administrator, or the desktop's local
 * recovery — so until the account holder replaces it, the only things it may do are read its
 * profile, change the password and sign out. Enforced here rather than only in the UI because a
 * UI check is a suggestion: any HTTP client could otherwise keep using the temporary password.
 *
 * Public routes (login, refresh, logout) pass untouched: there is no user on them yet.
 */
@Injectable()
export class PasswordChangeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const user = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>().user;
    if (!user?.mustChangePassword) return true;
    if (this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD_CHANGE_KEY, targets)) return true;

    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      code: PASSWORD_CHANGE_REQUIRED,
      message: 'Choose a new password before continuing: this account still uses a temporary one',
    });
  }
}
