import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { NotificationChannel, NotificationType, UserRole } from '@scip/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { paginated, type PaginationQueryDto } from '../../common/dto/pagination.dto';
import { companyFilter, requireCompanyId } from '../../common/tenancy/tenant-scope';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { MailService } from '../mail/mail.service';
import { TrackingGateway } from '../gps/tracking.gateway';

export interface NotifyInput {
  companyId: string;
  type: NotificationType;
  title: string;
  body: string;
  severity?: 'INFO' | 'WARNING' | 'CRITICAL';
  /** Deep link, e.g. `{ entity: 'shipment', id: '...' }`. */
  target?: Record<string, unknown>;
  /** Explicit recipients. When omitted, `roles` decides who is told. */
  userIds?: string[];
  /** Roles that should hear about this. */
  roles?: UserRole[];
  channels?: NotificationChannel[];
  isDemoData?: boolean;
}

/**
 * Alerting.
 *
 * Routing is by **role**, not by hard-coded user list: "a shipment is late" goes to whoever holds
 * the logistics role today, and adding a colleague to that role is enough to include them. The
 * alternative — subscription lists per user — is the thing that always drifts out of date and
 * ends with the one person who left the company still being the only recipient.
 *
 * Delivery is best-effort per channel and recorded per channel. The dashboard row is written
 * first and always; email is attempted after and its failure is stored on the row rather than
 * thrown, because an SMTP outage must not roll back the business event that caused the alert.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly gateway: TrackingGateway,
  ) {}

  /** Which roles hear about which event, when the caller does not say. */
  private static readonly DEFAULT_AUDIENCE: Record<string, UserRole[]> = {
    SHIPMENT_DELAYED: ['LOGISTICS_MANAGER', 'SUPPLY_CHAIN_MANAGER', 'COMPANY_ADMIN'],
    SHIPMENT_ARRIVING: ['LOGISTICS_MANAGER', 'WAREHOUSE_MANAGER'],
    SHIPMENT_DELIVERED: ['LOGISTICS_MANAGER'],
    VEHICLE_STOPPED: ['LOGISTICS_MANAGER'],
    ROUTE_DEVIATION: ['LOGISTICS_MANAGER', 'COMPANY_ADMIN'],
    ANOMALY_DETECTED: ['LOGISTICS_MANAGER', 'COMPANY_ADMIN'],
    LOW_STOCK: ['WAREHOUSE_MANAGER', 'PROCUREMENT_MANAGER', 'SUPPLY_CHAIN_MANAGER'],
    OUT_OF_STOCK: ['WAREHOUSE_MANAGER', 'PROCUREMENT_MANAGER', 'SUPPLY_CHAIN_MANAGER', 'COMPANY_ADMIN'],
    EXPIRING_SOON: ['WAREHOUSE_MANAGER'],
    INCIDENT_CREATED: ['LOGISTICS_MANAGER', 'COMPANY_ADMIN'],
    INCIDENT_RESOLVED: ['LOGISTICS_MANAGER'],
    PO_CONFIRMED: ['PROCUREMENT_MANAGER'],
    RECOMMENDATION_CREATED: ['SUPPLY_CHAIN_MANAGER', 'PROCUREMENT_MANAGER'],
  };

  /** Fans a single event out to everyone who should hear it. */
  async notify(input: NotifyInput): Promise<{ recipients: number; emailed: number }> {
    const roles = input.roles ?? NotificationsService.DEFAULT_AUDIENCE[input.type] ?? ['COMPANY_ADMIN'];

    const recipients = input.userIds?.length
      ? await this.prisma.user.findMany({
          where: { id: { in: input.userIds }, isActive: true },
          select: { id: true, email: true, firstName: true },
        })
      : await this.prisma.user.findMany({
          where: { companyId: input.companyId, role: { in: roles as never[] }, isActive: true },
          select: { id: true, email: true, firstName: true },
        });

    if (recipients.length === 0) {
      this.logger.warn(
        `No active recipient for ${input.type} in company ${input.companyId} (roles: ${roles.join(', ')})`,
      );
      return { recipients: 0, emailed: 0 };
    }

    const channels = input.channels ?? ['DASHBOARD'];
    const severity = input.severity ?? 'INFO';

    await this.prisma.notification.createMany({
      data: recipients.map((recipient) => ({
        companyId: input.companyId,
        userId: recipient.id,
        type: input.type,
        channel: 'DASHBOARD',
        severity,
        title: input.title,
        body: input.body,
        target: (input.target ?? {}) as Prisma.InputJsonValue,
        isDemoData: input.isDemoData ?? false,
      })),
    });

    // Push to any connected dashboard immediately; the stored row is what a user who was
    // offline will see when they return.
    this.gateway.emitAlert(input.companyId, {
      type: input.type,
      severity,
      title: input.title,
      body: input.body,
      target: input.target ?? {},
      createdAt: new Date().toISOString(),
    });

    let emailed = 0;
    if (channels.includes('EMAIL')) {
      for (const recipient of recipients) {
        const result = await this.mail.send({
          to: recipient.email,
          subject: `[SCIP${severity === 'CRITICAL' ? ' — URGENT' : ''}] ${input.title}`,
          text: `${recipient.firstName},\n\n${input.body}\n\n— SCIP`,
        });
        if (result.sent) {
          emailed += 1;
        } else {
          await this.prisma.notification.updateMany({
            where: { userId: recipient.id, type: input.type, sentAt: null },
            data: { deliveryError: result.error?.slice(0, 500) ?? 'unknown error' },
          });
        }
      }
    }

    if (channels.includes('SMS')) {
      // No SMS provider is configured. Logged rather than silently dropped, so the gap is
      // visible in operations instead of being discovered when an alert never arrives.
      this.logger.warn(
        `SMS channel requested for ${input.type} but no provider is configured; ${recipients.length} message(s) not sent`,
      );
    }

    return { recipients: recipients.length, emailed };
  }

  async list(user: AuthenticatedUser, query: PaginationQueryDto, unreadOnly = false) {
    const where: Prisma.NotificationWhereInput = {
      userId: user.id,
      ...(unreadOnly ? { readAt: null } : {}),
    };

    const [data, total, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    ]);

    return { ...paginated(data, total, query), unreadCount: unread };
  }

  async markRead(user: AuthenticatedUser, id: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id, userId: user.id },
    });
    if (!notification) throw new NotFoundException('Notification not found');

    return this.prisma.notification.update({
      where: { id },
      data: { readAt: notification.readAt ?? new Date() },
    });
  }

  async markAllRead(user: AuthenticatedUser) {
    const result = await this.prisma.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return { marked: result.count };
  }

  async unreadCount(user: AuthenticatedUser) {
    return {
      unread: await this.prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    };
  }

  /** Removes read notifications older than the retention window. */
  async purgeOld(days = 90): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const result = await this.prisma.notification.deleteMany({
      where: { readAt: { not: null, lt: cutoff } },
    });
    return result.count;
  }
}
