import type { UserRole } from '@scip/shared';

/** Shape attached to `request.user` by JwtStrategy after a token is validated. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  /** Null only for SUPER_ADMIN, who is not bound to a tenant. */
  companyId: string | null;
  linkedSupplierId: string | null;
  linkedCustomerId: string | null;
  /**
   * The account holds a temporary password. Read from the database on every request (not from
   * the token), so the flag clears the moment the password is changed. PasswordChangeGuard
   * refuses every route but the few needed to change it while this is true.
   */
  mustChangePassword?: boolean;
}

export interface JwtAccessPayload {
  sub: string;
  email: string;
  role: UserRole;
  companyId: string | null;
  supplierId: string | null;
  customerId: string | null;
  type: 'access';
}

/**
 * Refresh tokens are deliberately NOT JWTs. They are opaque 48-byte random strings stored as
 * SHA-256 hashes in `refresh_tokens`, which makes them revocable server-side — a stolen JWT
 * refresh token would stay valid until expiry no matter what the server decided.
 */
export type OpaqueRefreshToken = string;
