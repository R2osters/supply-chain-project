import { HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, type AxiosInstance } from 'axios';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * HTTP client for the Python AI service.
 *
 * Three behaviours worth knowing about:
 *
 * **Failures degrade, they do not cascade.** TRACK must keep working when OPTIMIZE is down —
 * a warehouse cannot stop receiving goods because a forecasting container crashed. Callers get
 * a 503 with a clear message, and the health endpoint lists exactly which features are affected.
 *
 * **A circuit breaker sits in front.** After a run of failures the client stops dialling for a
 * cool-down. Without it, every request would sit through the full timeout while the service is
 * down, and the API's own latency would collapse along with it.
 *
 * **Every call is recorded.** Input, output, latency and model version land in `ai_predictions`,
 * which is what makes prediction accuracy measurable later: once the truth is known, the stored
 * prediction can be scored against it.
 */

const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 30_000;

export interface AiCallOptions {
  /** Persist this call to `ai_predictions`. Off for high-frequency internal calls. */
  record?: {
    companyId: string;
    task: string;
    subjectType: string;
    subjectId: string;
  };
  timeoutMs?: number;
}

@Injectable()
export class AiClientService {
  private readonly logger = new Logger(AiClientService.name);
  private readonly http: AxiosInstance;

  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<AppConfig, true>,
  ) {
    const ai = config.get('ai', { infer: true });
    this.http = axios.create({
      baseURL: ai.url,
      timeout: ai.timeoutMs,
      headers: {
        Authorization: `Bearer ${ai.token}`,
        'Content-Type': 'application/json',
      },
    });
  }

  get isCircuitOpen(): boolean {
    return Date.now() < this.circuitOpenUntil;
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
      this.logger.error(
        `AI service failed ${this.consecutiveFailures} times in a row; pausing calls for ${
          CIRCUIT_COOLDOWN_MS / 1000
        }s`,
      );
    }
  }

  /** POSTs to the AI service, records the exchange, and translates failures into 503s. */
  async post<TResponse>(
    path: string,
    body: unknown,
    options: AiCallOptions = {},
  ): Promise<TResponse> {
    if (this.isCircuitOpen) {
      throw new ServiceUnavailableException(
        'Le service IA est injoignable et ses appels sont suspendus. Le suivi, les achats et les ' +
          'stocks ne sont pas affectés ; les prévisions et l’optimisation reprendront automatiquement.',
      );
    }

    const started = Date.now();

    try {
      const response = await this.http.post<TResponse>(path, body, {
        timeout: options.timeoutMs,
      });
      this.recordSuccess();
      const latencyMs = Date.now() - started;

      if (options.record) {
        await this.persist(options.record, path, body, response.data, latencyMs);
      }

      return response.data;
    } catch (error) {
      const latencyMs = Date.now() - started;
      const axiosError = error as AxiosError;

      // A 4xx is the caller's fault and says nothing about service health — it must not trip
      // the breaker, or one malformed request from one user would blind the whole tenant.
      const status = axiosError.response?.status;
      if (status && status >= 400 && status < 500) {
        this.recordSuccess();
        const detail = (axiosError.response?.data as { detail?: unknown })?.detail;
        throw new HttpException(
          {
            message: 'Le service IA a refusé la demande',
            detail: detail ?? axiosError.message,
          },
          status,
        );
      }

      this.recordFailure();
      this.logger.error(
        `AI call ${path} failed after ${latencyMs}ms: ${axiosError.message}`,
      );
      throw new ServiceUnavailableException(
        `Le service IA n’a pas répondu (${axiosError.code ?? axiosError.message}). ` +
          'Le suivi, les achats et les stocks ne sont pas affectés.',
      );
    }
  }

  private async persist(
    record: NonNullable<AiCallOptions['record']>,
    path: string,
    input: unknown,
    output: unknown,
    latencyMs: number,
  ): Promise<void> {
    const model = (output as { model?: { name?: string; version?: string } })?.model;
    const confidence =
      (output as { confidenceScore?: number })?.confidenceScore ??
      (output as { delayProbability?: number })?.delayProbability ??
      null;

    // Never let bookkeeping break a successful prediction.
    await this.prisma.aiPrediction
      .create({
        data: {
          companyId: record.companyId,
          task: record.task,
          subjectType: record.subjectType,
          subjectId: record.subjectId,
          input: input as never,
          output: output as never,
          modelName: model?.name ?? path.replace(/^\//, ''),
          modelVersion: model?.version ?? null,
          confidence,
          latencyMs,
        },
      })
      .catch((error) => {
        this.logger.warn(`Could not record AI prediction: ${error}`);
      });
  }

  async health(): Promise<{ reachable: boolean; detail: string; engines?: string[] }> {
    try {
      const response = await this.http.get<{ version: string; engines: string[] }>('/health', {
        timeout: 3000,
      });
      return {
        reachable: true,
        detail: `v${response.data.version}`,
        engines: response.data.engines,
      };
    } catch (error) {
      return {
        reachable: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
