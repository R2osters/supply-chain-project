import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { PrismaService } from '../../prisma/prisma.service';
import { isKnownTimezone, UpdateCompanyDto } from './companies.dto';
import { CompaniesService } from './companies.service';

const admin: AuthenticatedUser = {
  id: 'u1',
  email: 'a@b.c',
  role: 'COMPANY_ADMIN',
  companyId: 'c1',
  linkedSupplierId: null,
  linkedCustomerId: null,
};

function makeService(existing = 1) {
  const prisma = {
    company: {
      count: jest.fn().mockResolvedValue(existing),
      findUnique: jest.fn().mockResolvedValue(existing ? { id: 'c1', name: 'Acme' } : null),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'c1', ...data })),
    },
  };
  return { service: new CompaniesService(prisma as unknown as PrismaService), prisma };
}

async function errorsFor(body: object): Promise<string[]> {
  const dto = plainToInstance(UpdateCompanyDto, body);
  return (await validate(dto)).map((e) => e.property);
}

describe('UpdateCompanyDto', () => {
  it('accepts an ISO currency and an IANA time zone', async () => {
    await expect(errorsFor({ currency: 'ghs', timezone: 'Africa/Accra' })).resolves.toEqual([]);
    expect(plainToInstance(UpdateCompanyDto, { currency: ' ghs ' }).currency).toBe('GHS');
  });

  it('rejects malformed values', async () => {
    await expect(errorsFor({ currency: 'CEDI' })).resolves.toEqual(['currency']);
    await expect(errorsFor({ timezone: 'Mars/Olympus' })).resolves.toEqual(['timezone']);
    await expect(errorsFor({ name: 'x' })).resolves.toEqual(['name']);
  });

  it('allows an empty body (nothing to change)', async () => {
    await expect(errorsFor({})).resolves.toEqual([]);
  });

  it('knows real time zones only', () => {
    expect(isKnownTimezone('Europe/Paris')).toBe(true);
    expect(isKnownTimezone('')).toBe(false);
    expect(isKnownTimezone(42)).toBe(false);
  });
});

describe('CompaniesService', () => {
  it("updates only the caller's company and only the fields sent", async () => {
    const { service, prisma } = makeService();
    const result = await service.updateCurrent(admin, { currency: 'GHS', timezone: 'Africa/Accra' });
    expect(prisma.company.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1' }, data: { currency: 'GHS', timezone: 'Africa/Accra' } }),
    );
    expect(result).toMatchObject({ currency: 'GHS', timezone: 'Africa/Accra' });
  });

  it('refuses a user without a company', async () => {
    const { service } = makeService();
    await expect(service.updateCurrent({ ...admin, companyId: null }, { currency: 'EUR' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('reports a missing company as not found', async () => {
    const { service } = makeService(0);
    await expect(service.updateCurrent(admin, { name: 'New name' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.current(admin)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the current company', async () => {
    const { service } = makeService();
    await expect(service.current(admin)).resolves.toMatchObject({ id: 'c1' });
  });
});
