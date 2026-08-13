import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The seam between TRACK and OPTIMIZE.
 *
 * TRACK publishes facts ("shipment SHP-… is now DELAYED", "PO-… was received short"). OPTIMIZE
 * subscribes and decides what to recompute. Going through a durable table rather than an
 * in-process EventEmitter buys three things that matter for this system:
 *
 *   * a restart between "shipment delayed" and "risk recomputed" cannot lose the trigger;
 *   * the worker can retry, with the attempt count and last error visible in the database;
 *   * the event log doubles as an explanation of *why* a recommendation appeared, which the
 *     recommendation UI links back to.
 *
 * Events are claimed with `FOR UPDATE SKIP LOCKED`, so running more than one worker is safe.
 */
export const DOMAIN_EVENTS = {
  SHIPMENT_DELAYED: 'shipment.delayed',
  SHIPMENT_DELIVERED: 'shipment.delivered',
  SHIPMENT_ANOMALY: 'shipment.anomaly_detected',
  PO_CONFIRMED: 'purchase_order.confirmed',
  PO_RECEIVED: 'purchase_order.received',
  PO_CANCELLED: 'purchase_order.cancelled',
  STOCK_BELOW_REORDER: 'inventory.below_reorder_point',
  STOCK_OUT: 'inventory.out_of_stock',
  SUPPLIER_PERFORMANCE_CHANGED: 'supplier.performance_changed',
  FORECAST_UPDATED: 'forecast.updated',
} as const;

export type DomainEventType = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

export interface PublishInput {
  companyId: string;
  type: DomainEventType;
  subjectType: 'SHIPMENT' | 'PURCHASE_ORDER' | 'PRODUCT' | 'SUPPLIER' | 'INVENTORY';
  subjectId: string;
  payload?: Record<string, unknown>;
}

export interface ClaimedEvent {
  id: string;
  companyId: string;
  type: string;
  subjectType: string;
  subjectId: string;
  payload: Prisma.JsonValue;
  attempts: number;
}

@Injectable()
export class DomainEventsService {
  private readonly logger = new Logger(DomainEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Publishes inside an existing transaction so the fact and the event commit together. */
  async publish(tx: Prisma.TransactionClient, input: PublishInput): Promise<void> {
    await tx.domainEvent.create({
      data: {
        companyId: input.companyId,
        type: input.type,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async publishStandalone(input: PublishInput): Promise<void> {
    await this.prisma.domainEvent.create({
      data: {
        companyId: input.companyId,
        type: input.type,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Claims up to `limit` unprocessed events. `SKIP LOCKED` lets several workers pull disjoint
   * batches without blocking each other; without it they would serialise on the oldest row.
   */
  async claim(limit = 25, maxAttempts = 5): Promise<ClaimedEvent[]> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ClaimedEvent[]>`
        SELECT id, "companyId", type, "subjectType", "subjectId", payload, attempts
          FROM "domain_events"
         WHERE "processedAt" IS NULL
           AND attempts < ${maxAttempts}
         ORDER BY "createdAt"
         LIMIT ${limit}
           FOR UPDATE SKIP LOCKED
      `;

      if (rows.length > 0) {
        await tx.domainEvent.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: { attempts: { increment: 1 } },
        });
      }
      return rows;
    });
  }

  async markProcessed(eventId: string): Promise<void> {
    await this.prisma.domainEvent.update({
      where: { id: eventId },
      data: { processedAt: new Date(), processError: null },
    });
  }

  async markFailed(eventId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.prisma.domainEvent.update({
      where: { id: eventId },
      data: { processError: message.slice(0, 1000) },
    });
    this.logger.warn(`Domain event ${eventId} failed: ${message}`);
  }

  /** Events that exhausted their retries — surfaced on the ops dashboard rather than hidden. */
  async deadLetters(companyId: string, maxAttempts = 5) {
    return this.prisma.domainEvent.findMany({
      where: { companyId, processedAt: null, attempts: { gte: maxAttempts } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /** The audit trail behind a recommendation: what happened to this subject, and when. */
  async timeline(companyId: string, subjectType: string, subjectId: string) {
    return this.prisma.domainEvent.findMany({
      where: { companyId, subjectType, subjectId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}
