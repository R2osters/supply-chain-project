import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission } from '@scip/shared';
import type { AuthenticatedUser } from '../types/authenticated-user';

export const IS_PUBLIC_KEY = 'scip:isPublic';
/** Marks a route as reachable without a valid access token. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const PERMISSIONS_KEY = 'scip:permissions';
/**
 * Requires *all* listed permissions. Business code never checks roles directly — the
 * role→permission mapping lives in @scip/shared so it stays one editable table.
 */
export const RequirePermissions = (...permissions: Permission[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export const ALLOW_PENDING_PASSWORD_CHANGE_KEY = 'scip:allowPendingPasswordChange';
/**
 * Keeps a route reachable for an account that still holds a temporary password (profile, the
 * password change itself, sign-out everywhere). Every other authenticated route answers
 * 403 `password-change-required` until the user has chosen their own password.
 */
export const AllowPendingPasswordChange = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_PENDING_PASSWORD_CHANGE_KEY, true);

export const AUDIT_KEY = 'scip:audit';
export interface AuditMeta {
  action: string;
  resource: string;
}
/** Records the call in `audit_logs` with a redacted diff of the request body. */
export const Audit = (action: string, resource: string): MethodDecorator =>
  SetMetadata(AUDIT_KEY, { action, resource } satisfies AuditMeta);

export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) return undefined;
    return data ? user[data] : user;
  },
);
