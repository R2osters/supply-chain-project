import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MailService } from '../mail/mail.service';
import { AuthService } from './auth.service';
import type { PasswordService } from './password.service';
import type { TokenService } from './token.service';

const account: User = {
  id: 'u1',
  companyId: 'c1',
  email: 'kofi@acme.test',
  passwordHash: 'hash:Temp0rary-Pass',
  firstName: 'Kofi',
  lastName: 'Asante',
  phone: null,
  role: 'DRIVER',
  isActive: true,
  emailVerifiedAt: null,
  lastLoginAt: null,
  failedLoginCount: 0,
  lockedUntil: null,
  mustChangePassword: true,
  linkedSupplierId: null,
  linkedCustomerId: null,
  isDemoData: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function setup(row: User = account) {
  const stored = { ...row };
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({ ...stored, company: { id: 'c1', name: 'Acme' } })),
      update: jest.fn(async ({ data }: { data: Partial<User> }) => Object.assign(stored, data)),
    },
  };
  const passwords = {
    hash: jest.fn(async (plain: string) => `hash:${plain}`),
    verify: jest.fn(async (hash: string, plain: string) => hash === `hash:${plain}`),
    verifyDecoy: jest.fn(async () => false),
  };
  const tokens = {
    issueForUser: jest.fn(async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 })),
    revokeAllForUser: jest.fn(async () => 3),
  };
  const config = {
    get: (key: string) => (key === 'auth' ? { maxFailedLogins: 8, lockoutMinutes: 15 } : 'desktop'),
  };
  const service = new AuthService(
    prisma as unknown as PrismaService,
    passwords as unknown as PasswordService,
    tokens as unknown as TokenService,
    {} as MailService,
    config as unknown as ConfigService<never, true>,
  );
  return { service, prisma, tokens, stored };
}

describe('AuthService and temporary passwords', () => {
  it('tells the client at sign-in that the password must be changed', async () => {
    const { service } = setup();
    const result = await service.login({ email: 'kofi@acme.test', password: 'Temp0rary-Pass' });
    expect(result.user.mustChangePassword).toBe(true);
    await expect(service.me('u1')).resolves.toMatchObject({ mustChangePassword: true, company: { id: 'c1' } });
  });

  it('clears the flag when the holder chooses a new password, and ends the other sessions', async () => {
    const { service, stored, tokens } = setup();
    await service.changePassword('u1', { currentPassword: 'Temp0rary-Pass', newPassword: 'Mine-0nly-Now!' });
    expect(stored.mustChangePassword).toBe(false);
    expect(stored.passwordHash).toBe('hash:Mine-0nly-Now!');
    expect(tokens.revokeAllForUser).toHaveBeenCalledWith('u1');
  });

  it('keeps the flag when the change is refused', async () => {
    const { service, stored } = setup();
    await expect(
      service.changePassword('u1', { currentPassword: 'wrong', newPassword: 'Mine-0nly-Now!' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      service.changePassword('u1', { currentPassword: 'Temp0rary-Pass', newPassword: 'Temp0rary-Pass' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(stored.mustChangePassword).toBe(true);
  });
});
