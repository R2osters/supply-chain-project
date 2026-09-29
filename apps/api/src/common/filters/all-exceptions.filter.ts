import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
  /** Correlates a client-visible error with the server log line that has the stack. */
  traceId?: string;
  /**
   * Stable machine-readable reason when the thrown HttpException carries one (for example
   * `password-change-required`), so a client can react without parsing the English message.
   */
  code?: string;
}

/**
 * Turns every thrown value into a consistent JSON envelope, and — importantly — makes sure a
 * Prisma error never reaches the client with table names, SQL or connection strings in it.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, error, message, code } = this.normalize(exception);
    const traceId = Math.random().toString(36).slice(2, 10);

    if (status >= 500) {
      this.logger.error(
        `[${traceId}] ${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`[${traceId}] ${request.method} ${request.url} -> ${status}: ${JSON.stringify(message)}`);
    }

    const body: ErrorBody = {
      statusCode: status,
      error,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
      traceId,
      ...(code ? { code } : {}),
    };
    response.status(status).json(body);
  }

  private normalize(exception: unknown): {
    status: number;
    error: string;
    message: string | string[];
    code?: string;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        return { status, error: exception.name, message: payload };
      }
      const obj = payload as { message?: string | string[]; error?: string; code?: unknown };
      return {
        status,
        error: obj.error ?? exception.name,
        message: obj.message ?? exception.message,
        // Only a short token-like string: never an object that could smuggle internals out.
        ...(typeof obj.code === 'string' && /^[a-z0-9-]{1,64}$/.test(obj.code) ? { code: obj.code } : {}),
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002': {
          const target = (exception.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
          return {
            status: HttpStatus.CONFLICT,
            error: 'Conflict',
            message: `A record with this ${target} already exists`,
          };
        }
        case 'P2025':
          return { status: HttpStatus.NOT_FOUND, error: 'Not Found', message: 'Record not found' };
        case 'P2003':
          return {
            status: HttpStatus.BAD_REQUEST,
            error: 'Bad Request',
            message: 'Referenced record does not exist',
          };
        default:
          return {
            status: HttpStatus.BAD_REQUEST,
            error: 'Bad Request',
            message: 'Database constraint violation',
          };
      }
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return { status: HttpStatus.BAD_REQUEST, error: 'Bad Request', message: 'Invalid query payload' };
    }

    // Postgres rejects some input outright (a NUL byte in a search string, for instance); that is
    // the client's input, not a server fault.
    if (exception instanceof Prisma.PrismaClientUnknownRequestError) {
      return { status: HttpStatus.BAD_REQUEST, error: 'Bad Request', message: 'Invalid request' };
    }

    // body-parser errors carry their own status and a `type` such as entity.too.large.
    const parserError = exception as { type?: unknown; status?: unknown };
    if (typeof parserError?.type === 'string' && parserError.type.startsWith('entity.')) {
      if (parserError.type === 'entity.too.large') {
        return { status: HttpStatus.PAYLOAD_TOO_LARGE, error: 'Payload Too Large', message: 'Request body too large' };
      }
      return { status: HttpStatus.BAD_REQUEST, error: 'Bad Request', message: 'Malformed request body' };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
    };
  }
}
