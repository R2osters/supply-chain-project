import { ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../../config/configuration';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PasswordService } from '../auth/password.service';
import { NetworkSettingsService } from './network-settings.service';

function makeService(options: { host?: string; demoAdmin?: boolean; demoPasswordUnchanged?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scip-network-'));
  const file = join(dir, 'network.json');
  const sections: Record<string, unknown> = {
    settings: { file: join(dir, 'settings.json') },
    network: { settingsFile: file },
    host: options.host ?? '127.0.0.1',
    port: 3001,
    deviceGateway: { port: 5023 },
  };
  const config = { get: (name: string) => sections[name] } as unknown as ConfigService<AppConfig, true>;
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(options.demoAdmin ? { passwordHash: 'hash' } : null) },
  } as unknown as PrismaService;
  const passwords = {
    verify: jest.fn().mockResolvedValue(options.demoPasswordUnchanged ?? true),
  } as unknown as PasswordService;
  return { service: new NetworkSettingsService(config, prisma, passwords), file };
}

describe('NetworkSettingsService', () => {
  it('is off by default and reports this PC only', async () => {
    const { service } = makeService();
    await expect(service.status()).resolves.toMatchObject({
      lanAccess: false,
      active: false,
      restartRequired: false,
      apiPort: 3001,
      gpsPort: 5023,
      demoPasswordPublic: false,
    });
  });

  it('saves the choice and says a restart is needed', async () => {
    const { service, file } = makeService();
    const status = await service.update(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ lanAccess: true });
    expect(status).toMatchObject({ lanAccess: true, active: false, restartRequired: true });
  });

  it('refuses to expose demo accounts that still use the published password without an explicit ack', async () => {
    const { service } = makeService({ demoAdmin: true, demoPasswordUnchanged: true });
    await expect(service.update(true)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.update(true, true)).resolves.toMatchObject({ lanAccess: true, demoPasswordPublic: true });
  });

  it('lets a demo install go on the network once the demo password was changed', async () => {
    const { service } = makeService({ demoAdmin: true, demoPasswordUnchanged: false });
    await expect(service.update(true)).resolves.toMatchObject({ lanAccess: true, demoPasswordPublic: false });
  });

  it('always allows switching network access off', async () => {
    const { service } = makeService({ host: '0.0.0.0', demoAdmin: true });
    await expect(service.update(false)).resolves.toMatchObject({ lanAccess: false, active: true, restartRequired: true });
  });
});
