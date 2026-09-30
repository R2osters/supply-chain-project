import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { roleHasPermission, type Permission } from '@scip/shared';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from '../decorators';
import type { AuthenticatedUser } from '../types/authenticated-user';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>().user;
    if (!user) throw new ForbiddenException('Authentification requise');

    const missing = required.filter((permission) => !roleHasPermission(user.role, permission));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Le rôle ${user.role} n’a pas ${missing.length > 1 ? 'les autorisations requises' : 'l’autorisation requise'} : ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
