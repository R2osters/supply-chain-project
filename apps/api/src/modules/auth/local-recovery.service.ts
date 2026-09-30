import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TemporaryPasswordService } from './temporary-password.service';
import type { TokenContext } from './token.service';

export const LOCAL_RECOVERY_AUDIT_ACTION = 'auth.local-recovery';

export interface RecoveredAccount {
  email: string;
  /** Shown once by the desktop sign-in screen; the administrator must replace it at sign-in. */
  temporaryPassword: string;
}

/**
 * "Forgot password" for the desktop install, where no e-mail can be sent.
 *
 * Why this is not a new privilege: only the desktop shell on this PC holds the recovery token —
 * it is generated into the user's own config.json, next to the database password — and the
 * request must come from this computer. Whoever can do that can already open the database
 * itself, so the endpoint grants nothing that local access did not; it replaces the e-mailed
 * reset link a desktop install cannot send. The token, the loopback rule and the 404-when-unset
 * behaviour live in LocalRecoveryGuard; this service only resets the account.
 */
@Injectable()
export class LocalRecoveryService {
  private readonly logger = new Logger(LocalRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly temporaryPasswords: TemporaryPasswordService,
  ) {}

  /**
   * Gives an active COMPANY_ADMIN a temporary password: the one with this e-mail, or without an
   * e-mail the first administrator created on this install. Other roles ask their administrator,
   * who resets them from the Users screen.
   */
  async recover(email: string | undefined, context: TokenContext = {}): Promise<RecoveredAccount> {
    const admin = await this.prisma.user.findFirst({
      where: { role: 'COMPANY_ADMIN', isActive: true, ...(email ? { email } : {}) },
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, companyId: true },
    });
    if (!admin) {
      throw new NotFoundException(
        email ? 'Aucun administrateur actif n’a cette adresse e-mail' : 'Cette installation n’a aucun administrateur actif',
      );
    }

    const { temporaryPassword } = await this.temporaryPasswords.reset(admin.id, {
      companyId: admin.companyId,
      // The actor is whoever sits at this computer, not a signed-in user.
      userId: null,
      action: LOCAL_RECOVERY_AUDIT_ACTION,
      resource: 'user',
      resourceId: admin.id,
      changes: { email: admin.email, via: 'desktop-shell' },
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent?.slice(0, 255) ?? null,
      statusCode: 200,
    });

    // Never the password itself: logs outlive the moment it was needed.
    this.logger.warn(`Local recovery: temporary password issued for ${admin.email}`);
    return { email: admin.email, temporaryPassword };
  }
}
