import { Injectable } from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from './password.service';
import { generateTemporaryPassword } from './password-policy';

export interface TemporaryPasswordResult {
  user: User;
  /** Plain text, handed to the caller once. Only its Argon2id hash is ever stored or logged. */
  temporaryPassword: string;
}

/**
 * Temporary passwords: what replaces the e-mailed reset link on an install that has no mail
 * server. An administrator (Users screen) or the desktop shell (local recovery) receives the
 * password once and passes it on; the holder must replace it at their next sign-in.
 */
@Injectable()
export class TemporaryPasswordService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  /** A temporary password (the one given, else a generated one) and its hash. */
  async prepare(given?: string): Promise<{ temporaryPassword: string; passwordHash: string }> {
    const temporaryPassword = given ?? generateTemporaryPassword();
    return { temporaryPassword, passwordHash: await this.passwords.hash(temporaryPassword) };
  }

  /**
   * Replaces a user's password with a fresh temporary one, in a single transaction:
   * - `mustChangePassword` is set, so PasswordChangeGuard lets them do nothing but change it;
   * - the lockout is cleared — being locked out is usually why someone asked for a reset;
   * - every refresh token is revoked: whoever held the old password loses their sessions;
   * - the optional audit row is written in the same transaction, so it cannot go missing.
   */
  async reset(
    userId: string,
    audit?: Prisma.AuditLogUncheckedCreateInput,
  ): Promise<TemporaryPasswordResult> {
    const { temporaryPassword, passwordHash } = await this.prepare();
    const now = new Date();
    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
      });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      if (audit) await tx.auditLog.create({ data: audit });
      return updated;
    });
    return { user, temporaryPassword };
  }
}
