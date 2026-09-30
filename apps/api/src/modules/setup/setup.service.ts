import { ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';

export interface SetupStatus {
  /** No company exists yet: the first screen must create one. */
  needsSetup: boolean;
  /** The demo seed ships with this build and can populate an empty install. */
  demoAvailable: boolean;
  /** The demo accounts exist, so the login screen may offer them. */
  demoAccounts: boolean;
}

/** The seed's administrator; its presence means the demo data set is loaded. */
export const DEMO_ADMIN_EMAIL = 'admin@demo-scip.com';

/**
 * First run of a desktop install. The database starts empty, so the first person to open the
 * app either creates their company (through /auth/register) or loads the demo data set.
 *
 * Both are one-shot: once a company exists they are refused. The API listens on the LAN for
 * drivers' phones, and without that rule anyone on the network could register a tenant or, far
 * worse, re-run the seed, which starts by deleting everything.
 */
@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);
  private readonly seedScript: string | null;
  private seeding: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<AppConfig, true>,
  ) {
    const script = config.get('setup', { infer: true }).demoSeedScript;
    this.seedScript = script && existsSync(script) ? script : null;
  }

  async status(): Promise<SetupStatus> {
    const [needsSetup, demoAdmins] = await Promise.all([
      this.isEmpty(),
      this.prisma.user.count({ where: { email: DEMO_ADMIN_EMAIL } }),
    ]);
    return { needsSetup, demoAvailable: this.seedScript !== null, demoAccounts: demoAdmins > 0 };
  }

  async isEmpty(): Promise<boolean> {
    return (await this.prisma.company.count()) === 0;
  }

  async loadDemo(): Promise<void> {
    if (!this.seedScript) throw new ServiceUnavailableException('Demo data is not part of this build');
    // Concurrent clicks share one run instead of racing two seeds against each other.
    if (this.seeding) return this.seeding;
    if (!(await this.isEmpty())) throw new ConflictException('SCIP is already set up');

    this.seeding = this.runSeed(this.seedScript).finally(() => {
      this.seeding = null;
    });
    return this.seeding;
  }

  private runSeed(script: string): Promise<void> {
    this.logger.log('Loading the demo data set');
    return new Promise((resolve, reject) => {
      // A separate process: the seed owns its PrismaClient and exits when done, and a crash in it
      // cannot take the API down.
      const child = fork(script, [], { env: process.env, stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) {
          this.logger.log('Demo data loaded');
          resolve();
        } else {
          reject(new Error(`Demo seed exited with code ${code}`));
        }
      });
    });
  }
}
