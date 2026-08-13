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

    const { status, error, message } = this.normalize(exception);
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
    };
    response.status(status).json(body);
  }

  private normalize(exception: unknown): {
    status: number;
    error: string;
    message: string | string[];
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        return { status, error: exception.name, message: payload };
      }
      const obj = payload as { message?: string | string[]; error?: string };
      return {
        status,
        error: obj.error ?? exception.name,
        message: obj.message ?? exception.message,
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

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
    };
  }
}
