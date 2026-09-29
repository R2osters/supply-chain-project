import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { AUDIT_KEY, type AuditMeta } from '../decorators';
import type { AuthenticatedUser } from '../types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';

const REDACTED = '[redacted]';
const SENSITIVE_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'passwordconfirmation',
  'token',
  'refreshtoken',
  'accesstoken',
  'secret',
  'apikey',
  'authorization',
  'signature',
]);

/**
 * Exact names, plus any field that *ends* in one of them: `aisStreamApiKey` and
 * `openskyClientSecret` are credentials too, and an exact-match list would log them in clear.
 */
function isSensitive(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lower)) return true;
  for (const suffix of SENSITIVE_KEYS) if (lower.endsWith(suffix)) return true;
  return false;
}

/** Recursively strips credentials so an audit trail never becomes a password dump. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitive(key) ? REDACTED : redact(val, depth + 1);
  }
  return out;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<AuditMeta>(AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!meta) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: AuthenticatedUser }>();
    const response = http.getResponse<Response>();
    const user = request.user;

    const write = (statusCode: number, resourceId?: string): void => {
      // Audit writing must never break the request it is auditing.
      void this.prisma.auditLog
        .create({
          data: {
            companyId: user?.companyId ?? null,
            userId: user?.id ?? null,
            action: meta.action,
            resource: meta.resource,
            resourceId: resourceId ?? (request.params as Record<string, string>)?.id ?? null,
            changes: {
              body: redact(request.body),
              query: redact(request.query),
            } as never,
            ipAddress: request.ip ?? null,
            userAgent: request.get('user-agent') ?? null,
            statusCode,
          },
        })
        .catch(() => undefined);
    };

    return next.handle().pipe(
      tap((result) => {
        const id =
          result && typeof result === 'object' && 'id' in result
            ? String((result as { id: unknown }).id)
            : undefined;
        write(response.statusCode, id);
      }),
      catchError((err) => {
        write(typeof err?.status === 'number' ? err.status : 500);
        return throwError(() => err);
      }),
    );
  }
}
