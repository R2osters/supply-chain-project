import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../../config/configuration';
import type { PrismaService } from '../../prisma/prisma.service';
import { SetupService } from './setup.service';

function scriptThatExits(code: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'scip-seed-'));
  const path = join(dir, 'seed.js');
  writeFileSync(path, `process.exit(${code});`);
  return path;
}

function makeService(companies: number, seedScript: string | null): SetupService {
  const prisma = {
    company: { count: jest.fn().mockResolvedValue(companies) },
    user: { count: jest.fn().mockResolvedValue(0) },
  } as unknown as PrismaService;
  const config = {
    get: () => ({ demoSeedScript: seedScript }),
  } as unknown as ConfigService<AppConfig, true>;
  return new SetupService(prisma, config);
}

describe('SetupService', () => {
  it('reports an empty install as needing setup', async () => {
    await expect(makeService(0, null).status()).resolves.toEqual({
      needsSetup: true,
      demoAvailable: false,
      demoAccounts: false,
    });
  });

  it('only offers the demo when the seed ships with the build', async () => {
    await expect(makeService(0, scriptThatExits(0)).status()).resolves.toMatchObject({ demoAvailable: true });
    await expect(makeService(0, join(tmpdir(), 'missing-seed.js')).status()).resolves.toMatchObject({
      demoAvailable: false,
    });
  });

  it('loads the demo on an empty install', async () => {
    await expect(makeService(0, scriptThatExits(0)).loadDemo()).resolves.toBeUndefined();
  });

  it('refuses to seed once a company exists, since the seed starts by deleting data', async () => {
    await expect(makeService(1, scriptThatExits(0)).loadDemo()).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses when the build has no demo data', async () => {
    await expect(makeService(0, null).loadDemo()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('surfaces a failed seed', async () => {
    await expect(makeService(0, scriptThatExits(3)).loadDemo()).rejects.toThrow('code 3');
  });
});
