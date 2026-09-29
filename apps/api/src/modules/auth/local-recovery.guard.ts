import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { AppConfig } from '../../config/configuration';

/** Header the desktop shell sends its recovery token in (see apps/desktop/src-tauri/src/recovery.rs). */
export const LOCAL_RECOVERY_HEADER = 'x-local-recovery-token';

/** Anything shorter is not a generated secret; the desktop shell sends 64 characters. */
export const MIN_LOCAL_RECOVERY_TOKEN_LENGTH = 32;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(address: string | null | undefined): boolean {
  return typeof address === 'string' && LOOPBACK.has(address.toLowerCase());
}

/**
 * Whether a request comes from this computer. The socket's peer address is the ground truth —
 * headers such as X-Forwarded-For are written by the client. `req.ip` must agree as well, so that
 * turning on `trust proxy` one day cannot make a LAN request relayed by a local proxy (loopback
 * socket, remote client) pass for a local one.
 */
export function isLoopbackRequest(request: Pick<Request, 'ip' | 'socket'>): boolean {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
  return request.ip === undefined || isLoopbackAddress(request.ip);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Gate of POST /auth/local-recovery, checked before the body is even validated:
 * 1. no token configured (any non-desktop install) → 404, exactly as if the route did not exist;
 * 2. not from this computer → 403 — the API may listen on the LAN for drivers' phones;
 * 3. missing or wrong `x-local-recovery-token` → 403, compared in constant time.
 * The loopback check comes first so a machine on the network never gets to try tokens at all.
 */
@Injectable()
export class LocalRecoveryGuard implements CanActivate {
  private readonly logger = new Logger(LocalRecoveryGuard.name);
  private readonly expected: Buffer | null;

  constructor(config: ConfigService<{ auth: AppConfig['auth'] }, true>) {
    const token = config.get('auth', { infer: true }).localRecoveryToken;
    if (token && token.length < MIN_LOCAL_RECOVERY_TOKEN_LENGTH) {
      this.logger.warn(
        `LOCAL_RECOVERY_TOKEN is shorter than ${MIN_LOCAL_RECOVERY_TOKEN_LENGTH} characters; local recovery stays disabled`,
      );
    }
    this.expected = token && token.length >= MIN_LOCAL_RECOVERY_TOKEN_LENGTH ? digest(token) : null;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (!this.expected) {
      throw new NotFoundException(`Cannot ${request.method} ${request.originalUrl ?? request.url}`);
    }
    if (!isLoopbackRequest(request)) {
      throw new ForbiddenException('Password recovery is only available from SCIP on this computer');
    }
    const presented = request.headers[LOCAL_RECOVERY_HEADER];
    // Hashing both sides gives equal-length buffers, so timingSafeEqual cannot throw and the
    // comparison leaks neither the token's content nor its length.
    if (typeof presented !== 'string' || !timingSafeEqual(digest(presented), this.expected)) {
      throw new ForbiddenException('Invalid local recovery token');
    }
    return true;
  }
}
