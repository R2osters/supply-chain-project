import type { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from './all-exceptions.filter';

function statusFor(exception: unknown): { status: number; body: Record<string, unknown> } {
  let status = 0;
  let body: Record<string, unknown> = {};
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      body = payload;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ method: 'GET', url: '/x' }) }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { status, body };
}

describe('AllExceptionsFilter', () => {
  it('answers 413, not 500, when a body exceeds the parser limit', () => {
    const error = Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413 });
    expect(statusFor(error)).toMatchObject({ status: 413, body: { message: 'Request body too large' } });
  });

  it('answers 400 for a malformed JSON body', () => {
    const error = Object.assign(new SyntaxError('Unexpected token'), { type: 'entity.parse.failed', status: 400 });
    expect(statusFor(error).status).toBe(400);
  });

  it('answers 400 for input Postgres rejects, without leaking the database message', () => {
    const error = new Prisma.PrismaClientUnknownRequestError('invalid byte sequence for encoding "UTF8": 0x00', {
      clientVersion: 'test',
    });
    const { status, body } = statusFor(error);
    expect(status).toBe(400);
    expect(JSON.stringify(body)).not.toContain('0x00');
  });

  it('still hides unexpected errors behind a generic 500', () => {
    expect(statusFor(new Error('secret internals'))).toMatchObject({
      status: 500,
      body: { message: 'An unexpected error occurred' },
    });
  });
});
