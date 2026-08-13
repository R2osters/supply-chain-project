import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import axios from 'axios';
import Redis from 'ioredis';
import { Public } from '../../common/decorators';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';

interface DependencyStatus {
  status: 'up' | 'down';
  latencyMs?: number;
  detail?: string;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness probe — process is up and serving' })
  live() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /**
   * Readiness. Reports each dependency separately instead of a single boolean, because
   * "AI service down" and "database down" call for completely different responses and an
   * operator should not have to read logs to tell them apart.
   */
  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — every dependency reachable' })
  async ready() {
    const [database, redis, ai, postgis] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkAiService(),
      this.checkPostgis(),
    ]);

    const dependencies = { database, redis, aiService: ai, postgis };
    // The AI service is intentionally not fatal: TRACK stays fully usable without OPTIMIZE.
    const ready = database.status === 'up' && redis.status === 'up';

    return {
      status: ready ? 'ready' : 'degraded',
      dependencies,
      degradedFeatures:
        ai.status === 'down'
          ? ['ETA prediction', 'delay prediction', 'forecasting', 'optimisation', 'recommendations']
          : [],
    };
  }

  private async timed(fn: () => Promise<string | void>): Promise<DependencyStatus> {
    const start = Date.now();
    try {
      const detail = await fn();
      return { status: 'up', latencyMs: Date.now() - start, detail: detail || undefined };
    } catch (error) {
      return {
        status: 'down',
        latencyMs: Date.now() - start,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private checkDatabase(): Promise<DependencyStatus> {
    return this.timed(async () => {
      await this.prisma.$queryRaw`SELECT 1`;
    });
  }

  private checkPostgis(): Promise<DependencyStatus> {
    return this.timed(async () => {
      const rows = await this.prisma.$queryRaw<Array<{ v: string }>>`SELECT postgis_version() AS v`;
      return rows[0]?.v ?? 'unknown';
    });
  }

  private checkRedis(): Promise<DependencyStatus> {
    return this.timed(async () => {
      const { host, port } = this.config.get('redis', { infer: true });
      const client = new Redis({ host, port, lazyConnect: true, maxRetriesPerRequest: 1 });
      try {
        await client.connect();
        await client.ping();
      } finally {
        client.disconnect();
      }
    });
  }

  private checkAiService(): Promise<DependencyStatus> {
    return this.timed(async () => {
      const { url } = this.config.get('ai', { infer: true });
      const response = await axios.get(`${url}/health`, { timeout: 3000 });
      return String(response.data?.version ?? 'ok');
    });
  }
}
