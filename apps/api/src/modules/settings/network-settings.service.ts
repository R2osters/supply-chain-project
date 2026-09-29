import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from '../auth/password.service';

/** The demo seed's administrator and the password printed in its docs and on the login screen. */
const DEMO_ADMIN_EMAIL = 'admin@demo-scip.com';
const DEMO_PASSWORD = 'DemoPassw0rd!2026';

export interface NetworkStatus {
  /** Saved choice: expose SCIP to the local network on next start. */
  lanAccess: boolean;
  /** What this running API actually does (it binds at start-up). */
  active: boolean;
  restartRequired: boolean;
  /** This PC's local IPv4 addresses, for the drivers' phones and the trackers. */
  addresses: string[];
  apiPort: number;
  gpsPort: number;
  /** The demo accounts still use their published password: exposing them is a real risk. */
  demoPasswordPublic: boolean;
}

/**
 * Whether SCIP listens to the local network.
 *
 * By default the API and the GPS tracker gateway listen on this PC only (127.0.0.1): nothing on
 * the Wi-Fi can reach them. Drivers' phones and GT06 trackers need the network, so an
 * administrator can switch it on here. The choice is saved in network.json next to the data; the
 * desktop supervisor reads it when it starts the API, so it applies after a restart of SCIP.
 *
 * With the demo data loaded, the demo accounts share a password that is printed on the login
 * screen. Exposing that to a classroom Wi-Fi hands the admin account to anyone on it, so turning
 * the network on then requires an explicit acknowledgement (or changing those passwords first).
 */
@Injectable()
export class NetworkSettingsService {
  private readonly logger = new Logger(NetworkSettingsService.name);
  private readonly file: string;
  private readonly active: boolean;
  private readonly apiPort: number;
  private readonly gpsPort: number;

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {
    const settings = config.get('settings', { infer: true });
    this.file = config.get('network', { infer: true }).settingsFile ?? join(dirname(settings.file), 'network.json');
    this.active = config.get('host', { infer: true }) !== '127.0.0.1';
    this.apiPort = config.get('port', { infer: true });
    this.gpsPort = config.get('deviceGateway', { infer: true }).port;
  }

  async status(): Promise<NetworkStatus> {
    const lanAccess = this.read();
    return {
      lanAccess,
      active: this.active,
      restartRequired: lanAccess !== this.active,
      addresses: localIpv4Addresses(),
      apiPort: this.apiPort,
      gpsPort: this.gpsPort,
      demoPasswordPublic: await this.demoPasswordIsPublic(),
    };
  }

  async update(lanAccess: boolean, acknowledgeDemoRisk = false): Promise<NetworkStatus> {
    if (lanAccess && !acknowledgeDemoRisk && (await this.demoPasswordIsPublic())) {
      throw new ConflictException({
        code: 'demo-password-public',
        message:
          'The demo accounts still use the published password: anyone on the network could sign in as ' +
          'administrator. Change their passwords, or confirm that you accept the risk.',
      });
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ lanAccess }, null, 2));
    renameSync(temporary, this.file);
    this.logger.log(`Local network access ${lanAccess ? 'enabled' : 'disabled'} (applies after restart)`);
    return this.status();
  }

  private read(): boolean {
    if (!existsSync(this.file)) return false;
    try {
      return (JSON.parse(readFileSync(this.file, 'utf8')) as { lanAccess?: unknown }).lanAccess === true;
    } catch {
      return false;
    }
  }

  private async demoPasswordIsPublic(): Promise<boolean> {
    const admin = await this.prisma.user.findUnique({
      where: { email: DEMO_ADMIN_EMAIL },
      select: { passwordHash: true },
    });
    if (!admin?.passwordHash) return false;
    return this.passwords.verify(admin.passwordHash, DEMO_PASSWORD);
  }
}

export function localIpv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry): entry is NonNullable<typeof entry> => !!entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}
