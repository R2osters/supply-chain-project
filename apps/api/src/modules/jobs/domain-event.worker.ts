import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { UserRole } from '@scip/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { DOMAIN_EVENTS, DomainEventsService } from '../events/domain-events.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * The worker that closes the loop.
 *
 *   TRACK observes   →  shipment SHP-… is late
 *        ↓ domain event
 *   OPTIMIZE reacts  →  recompute risk, regenerate recommendations
 *        ↓
 *   a human decides  →  accept the recommendation
 *        ↓
 *   TRACK executes   →  a real purchase order exists and is tracked
 *
 * Two design points worth stating:
 *
 * **Reactions are debounced per company.** A convoy of five late shipments produces five events;
 * regenerating recommendations five times in a row would be five expensive analyses that all
 * reach the same conclusion. Instead the worker marks the company dirty and runs one analysis per
 * cycle. That is the difference between an event bus that helps and one that melts the AI service.
 *
 * **Failures are retried, not lost.** Each event carries an attempt count; a handler that throws
 * leaves the event unprocessed with the error stored, and it is picked up again next cycle until
 * the attempt limit, after which it appears in the dead-letter list rather than disappearing.
 */
@Injectable()
export class DomainEventWorker {
  private readonly logger = new Logger(DomainEventWorker.name);

  /** Companies whose advice needs regenerating at the end of this cycle. */
  private readonly dirtyCompanies = new Set<string>();

  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEventsService,
    private readonly ai: AiService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * A synthetic principal for background work.
   *
   * Given the COMPANY_ADMIN role and pinned to one company, so the same tenant-scoping code that
   * guards HTTP requests also guards the worker. Bypassing the scoping helpers "because it is
   * internal" is how cross-tenant leaks get written.
   */
  private systemUser(companyId: string): AuthenticatedUser {
    return {
      id: 'system',
      email: 'system@scip.local',
      role: 'COMPANY_ADMIN' as UserRole,
      companyId,
      linkedSupplierId: null,
      linkedCustomerId: null,
    };
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async processPending(): Promise<void> {
    // Overlapping runs would double-handle events that the previous cycle already claimed.
    if (this.running) return;
    this.running = true;

    try {
      const claimed = await this.events.claim(50);
      if (claimed.length === 0) return;

      this.logger.log(`Processing ${claimed.length} domain event(s)`);

      for (const event of claimed) {
        try {
          await this.handle(event);
          await this.events.markProcessed(event.id);
        } catch (error) {
          await this.events.markFailed(event.id, error);
        }
      }

      await this.flushDirtyCompanies();
    } catch (error) {
      this.logger.error(`Domain event cycle failed: ${error}`);
    } finally {
      this.running = false;
    }
  }

  private async handle(event: {
    id: string;
    companyId: string;
    type: string;
    subjectType: string;
    subjectId: string;
    payload: unknown;
  }): Promise<void> {
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    switch (event.type) {
      case DOMAIN_EVENTS.SHIPMENT_DELAYED: {
        await this.notifications.notify({
          companyId: event.companyId,
          type: 'SHIPMENT_DELAYED',
          severity: 'WARNING',
          title: `Shipment ${payload.trackingNumber ?? ''} is running late`,
          body:
            `Projected ${Number(payload.minutesLate ?? 0).toFixed(0)} minutes past the promised ` +
            'arrival. Stock cover for the products on board is being reassessed.',
          target: { entity: 'shipment', id: event.subjectId },
          channels: ['DASHBOARD', 'EMAIL'],
        });
        // A late shipment changes the stock picture, so the advice is stale.
        this.dirtyCompanies.add(event.companyId);
        break;
      }

      case DOMAIN_EVENTS.SHIPMENT_ANOMALY: {
        const types = (payload.types as string[] | undefined) ?? [];
        await this.notifications.notify({
          companyId: event.companyId,
          type: 'ANOMALY_DETECTED',
          severity: 'WARNING',
          title: `Anomaly on shipment ${payload.trackingNumber ?? ''}`,
          body: `Detected: ${types.join(', ') || 'unspecified'}. Review the shipment's track.`,
          target: { entity: 'shipment', id: event.subjectId },
        });
        break;
      }

      case DOMAIN_EVENTS.SHIPMENT_DELIVERED: {
        // Delivery consumes incoming stock and updates supplier behaviour: both feed the advice.
        this.dirtyCompanies.add(event.companyId);
        break;
      }

      case DOMAIN_EVENTS.PO_RECEIVED: {
        // Receiving changes both the stock position and the supplier's measured performance.
        const supplierId = payload.supplierId as string | undefined;
        if (supplierId) {
          await this.recomputeSupplier(event.companyId, supplierId);
        }
        this.dirtyCompanies.add(event.companyId);
        break;
      }

      case DOMAIN_EVENTS.PO_CANCELLED: {
        const supplierId = payload.supplierId as string | undefined;
        if (supplierId) await this.recomputeSupplier(event.companyId, supplierId);
        this.dirtyCompanies.add(event.companyId);
        break;
      }

      case DOMAIN_EVENTS.STOCK_OUT:
      case DOMAIN_EVENTS.STOCK_BELOW_REORDER: {
        const isOut = event.type === DOMAIN_EVENTS.STOCK_OUT;
        await this.notifications.notify({
          companyId: event.companyId,
          type: isOut ? 'OUT_OF_STOCK' : 'LOW_STOCK',
          severity: isOut ? 'CRITICAL' : 'WARNING',
          title: isOut
            ? `${payload.sku ?? 'A product'} is out of stock`
            : `${payload.sku ?? 'A product'} has fallen below its reorder point`,
          body: isOut
            ? 'Sellable stock has reached zero. Any demand from now on is a lost sale.'
            : `Available ${payload.available ?? '?'} against a reorder point of ` +
              `${payload.reorderPoint ?? '?'}. An order recommendation is being prepared.`,
          target: { entity: 'product', id: event.subjectId },
          channels: isOut ? ['DASHBOARD', 'EMAIL'] : ['DASHBOARD'],
        });
        this.dirtyCompanies.add(event.companyId);
        break;
      }

      case DOMAIN_EVENTS.PO_CONFIRMED: {
        await this.notifications.notify({
          companyId: event.companyId,
          type: 'PO_CONFIRMED',
          title: `Purchase order ${payload.orderNumber ?? ''} confirmed`,
          body: 'The supplier has confirmed. The quantity now counts as incoming stock.',
          target: { entity: 'purchase_order', id: event.subjectId },
        });
        break;
      }

      case DOMAIN_EVENTS.FORECAST_UPDATED: {
        this.dirtyCompanies.add(event.companyId);
        break;
      }

      default:
        this.logger.debug(`No handler for domain event ${event.type}; marking processed`);
    }
  }

  private async recomputeSupplier(companyId: string, supplierId: string): Promise<void> {
    // Imported lazily rather than injected: SuppliersService pulls in the whole master-data
    // graph, and the worker only needs this one call.
    const { computeSupplierReliability } = await import('../suppliers/supplier-scoring');
    const { summariseOrders } = await import('../suppliers/suppliers.service');

    const orders = await this.prisma.purchaseOrder.findMany({
      where: { supplierId, createdAt: { gte: new Date(Date.now() - 365 * 86_400_000) } },
      include: { items: true },
    });

    const result = computeSupplierReliability(summariseOrders(orders));

    await this.prisma.supplier.update({
      where: { id: supplierId },
      data: {
        onTimeDeliveryRate: result.onTimeDeliveryRate,
        qualityAcceptanceRate: result.qualityAcceptanceRate,
        fillRate: result.fillRate,
        cancellationRate: result.cancellationRate,
        observedLeadTimeDays: result.observedLeadTimeDays || undefined,
        observedLeadTimeStdDays: result.observedLeadTimeStdDays,
        reliabilityScore: result.reliabilityScore,
        performanceUpdatedAt: new Date(),
      },
    });

    await this.events.publishStandalone({
      companyId,
      type: DOMAIN_EVENTS.SUPPLIER_PERFORMANCE_CHANGED,
      subjectType: 'SUPPLIER',
      subjectId: supplierId,
      payload: { reliabilityScore: result.reliabilityScore },
    });
  }

  /** One risk analysis and one recommendation run per dirty company, per cycle. */
  private async flushDirtyCompanies(): Promise<void> {
    if (this.dirtyCompanies.size === 0) return;

    const companies = [...this.dirtyCompanies];
    this.dirtyCompanies.clear();

    for (const companyId of companies) {
      const user = this.systemUser(companyId);
      try {
        await this.ai.analyseRisk(user);
        const result = await this.ai.generateRecommendations(user);

        if (result.newRecommendations > 0) {
          await this.notifications.notify({
            companyId,
            type: 'RECOMMENDATION_CREATED',
            title: `${result.newRecommendations} new recommendation(s)`,
            body:
              result.explanation?.summary ??
              'New supply-chain recommendations are waiting for review.',
            target: { entity: 'recommendations' },
          });
        }
      } catch (error) {
        // The AI service being down must not stop event processing; the next cycle retries.
        this.logger.warn(
          `Could not refresh advice for company ${companyId}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }
}
