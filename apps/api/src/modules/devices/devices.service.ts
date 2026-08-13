import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { Prisma } from '@prisma/client';
import { haversineKm } from '@scip/shared';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { companyFilter, requireCompanyId } from '../../common/tenancy/tenant-scope';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { TrackingGateway } from '../gps/tracking.gateway';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Everything a position has to survive between arriving and being trusted.
 *
 * Shared by all three intake paths — the TCP gateway, the driver's phone, and manual entry — so a
 * fix from a €15 tracker is validated exactly as hard as one from the API, and every one of them
 * carries the device it came from.
 */

/** Fixes implying this speed between consecutive points are not physically possible by road. */
const IMPLAUSIBLE_SPEED_KMH = 250;

/** Clock skew beyond this means the device's clock is wrong; the fix is not trustworthy. */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/** Below this movement, a fix is parked-vehicle jitter and adds noise without information. */
const MIN_FIX_SEPARATION_M = 8;

export interface IncomingFix {
  latitude: number;
  longitude: number;
  speedKmh?: number | null;
  headingDegrees?: number | null;
  accuracyM?: number | null;
  batteryPercent?: number | null;
  recordedAt: Date;
  satellites?: number | null;
}

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: TrackingGateway,
    private readonly notifications: NotificationsService,
  ) {}

  /* ==================================================================== CRUD */

  async list(user: AuthenticatedUser) {
    const devices = await this.prisma.trackingDevice.findMany({
      where: companyFilter(user),
      include: { vehicle: { select: { id: true, plateNumber: true, label: true } } },
      orderBy: { lastSeenAt: { sort: 'desc', nulls: 'last' } },
    });

    return devices.map((device) => {
      const silentSeconds = device.lastSeenAt
        ? (Date.now() - device.lastSeenAt.getTime()) / 1000
        : null;

      return {
        ...device,
        // A phone at 30 s and a parked tracker at 3600 s are both healthy at very different
        // silences, so "late" is measured against the device's own expected interval — with
        // three intervals of slack, because one missed report on a mobile network is routine.
        isReportingLate:
          silentSeconds !== null && silentSeconds > device.reportIntervalSeconds * 3,
        silentSeconds: silentSeconds === null ? null : Math.round(silentSeconds),
      };
    });
  }

  /**
   * Enrols a device.
   *
   * A phone gets a pairing secret it can present instead of a user session: a driver's access
   * token expires in fifteen minutes, and a phone in a coverage gap cannot refresh it — so
   * without this, tracking would stop exactly where it matters most. The secret is returned once
   * and stored hashed.
   */
  async enrol(
    user: AuthenticatedUser,
    input: { kind: 'PHONE' | 'GT06' | 'TELTONIKA' | 'MANUAL'; identifier: string; vehicleId?: string; label?: string },
  ) {
    const companyId = requireCompanyId(user);

    if (input.kind === 'GT06' || input.kind === 'TELTONIKA') {
      if (!/^\d{15}$/.test(input.identifier)) {
        throw new BadRequestException(
          'A hardware tracker is identified by its 15-digit IMEI, printed on the device and on its box.',
        );
      }
    }

    if (input.vehicleId) {
      const vehicle = await this.prisma.vehicle.findFirst({
        where: { id: input.vehicleId, companyId },
      });
      if (!vehicle) throw new BadRequestException('Vehicle not found in your company');
    }

    const existing = await this.prisma.trackingDevice.findUnique({
      where: { identifier: input.identifier },
    });
    if (existing) {
      // An IMEI is globally unique. Two companies claiming one is a mistake worth blocking
      // loudly rather than silently splitting its positions between them.
      throw new BadRequestException(
        existing.companyId === companyId
          ? 'This device is already enrolled.'
          : 'This identifier is already registered to another company. Check the IMEI.',
      );
    }

    const secret = input.kind === 'PHONE' ? randomBytes(24).toString('base64url') : null;

    const device = await this.prisma.trackingDevice.create({
      data: {
        companyId,
        vehicleId: input.vehicleId ?? null,
        kind: input.kind as never,
        identifier: input.identifier,
        label: input.label ?? null,
        pairingSecretHash: secret
          ? await hash(secret, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })
          : null,
        pairedAt: secret ? new Date() : null,
        // A phone can afford 30 s; a battery tracker reporting that often lasts days, not months.
        reportIntervalSeconds: input.kind === 'PHONE' ? 30 : 60,
      },
    });

    return {
      device,
      /** Shown once. It is not recoverable — re-enrol the phone to issue a new one. */
      pairingSecret: secret,
      setupInstructions: this.setupInstructions(input.kind, input.identifier),
    };
  }

  /** What the operator must physically do to get this device reporting. */
  private setupInstructions(kind: string, identifier: string): string[] {
    switch (kind) {
      case 'PHONE':
        return [
          'Send the driver the pairing link below. It opens /drive with the identifier and secret ' +
            'already filled in, so nothing has to be typed.',
          'On the phone, tap “Add to home screen”. It then opens full-screen in one tap.',
          'Tap Start. The phone posts its position every 30 s and keeps recording through a ' +
            'coverage gap, sending the backlog when signal returns.',
          'The screen must stay on. A phone browser stops receiving positions once the page is ' +
            'hidden — this is a browser rule, not a setting, so plug the phone in and leave the ' +
            'page open.',
        ];
      case 'GT06':
        return [
          'Insert a data SIM with a small monthly bundle — 30 MB covers a month of tracking.',
          `Text the tracker: APN#<your operator APN>#  (ask the SIM provider for the APN).`,
          'Text the tracker: server#<your public host>#5023#',
          'Text the tracker: timer#30#  to set a 30-second reporting interval.',
          `The device will connect and identify itself as IMEI ${identifier}.`,
        ];
      case 'TELTONIKA':
        return [
          'Teltonika Codec 8 is not decoded yet — the enum reserves the value.',
          'Use the phone app or a GT06-compatible tracker for now.',
        ];
      default:
        return ['Positions for this device are entered manually through the API or the UI.'];
    }
  }

  async remove(user: AuthenticatedUser, id: string) {
    const device = await this.prisma.trackingDevice.findFirst({
      where: { id, ...companyFilter(user) },
    });
    if (!device) throw new NotFoundException('Device not found');

    await this.prisma.trackingDevice.update({
      where: { id },
      data: { status: 'DISABLED', vehicleId: null },
    });
    return { success: true };
  }

  /* ============================================================ gateway hooks */

  /** Called when a tracker completes its login handshake. Returns false for an unknown IMEI. */
  async registerConnection(identifier: string, ipAddress: string | null): Promise<boolean> {
    const device = await this.prisma.trackingDevice.findUnique({ where: { identifier } });
    if (!device || device.status === 'DISABLED') return false;

    await this.prisma.trackingDevice.update({
      where: { id: device.id },
      data: { status: 'ONLINE', lastSeenAt: new Date(), lastIpAddress: ipAddress },
    });
    return true;
  }

  async markDisconnected(identifier: string): Promise<void> {
    await this.prisma.trackingDevice
      .updateMany({ where: { identifier, status: 'ONLINE' }, data: { status: 'OFFLINE' } })
      .catch(() => undefined);
  }

  async recordRejected(identifier: string): Promise<void> {
    await this.prisma.trackingDevice
      .updateMany({ where: { identifier }, data: { positionsRejected: { increment: 1 } } })
      .catch(() => undefined);
  }

  /**
   * Validates and stores a fix, whatever it arrived on.
   *
   * Returns false when the fix was rejected. Rejections are counted rather than thrown, because
   * a tracker cannot act on an error — but an operator looking at a device whose rejected count
   * is climbing can.
   */
  async recordPosition(identifier: string, fix: IncomingFix): Promise<boolean> {
    const device = await this.prisma.trackingDevice.findUnique({
      where: { identifier },
      include: { vehicle: true },
    });

    if (!device || device.status === 'DISABLED') return false;

    if (!device.vehicleId || !device.vehicle) {
      // A device reporting before it is assigned to a vehicle is normal during setup: the
      // operator is testing it on a bench. Its heartbeat is recorded so they can see it works.
      await this.prisma.trackingDevice.update({
        where: { id: device.id },
        data: {
          lastSeenAt: new Date(),
          lastLatitude: fix.latitude,
          lastLongitude: fix.longitude,
          status: 'ONLINE',
        },
      });
      return false;
    }

    const rejection = this.rejectionReason(device, fix);
    if (rejection) {
      this.logger.debug(`Rejected fix from ${identifier}: ${rejection}`);
      await this.recordRejected(identifier);
      return false;
    }

    const shipment = await this.prisma.shipment.findFirst({
      where: {
        vehicleId: device.vehicleId,
        status: { in: ['LOADING', 'DEPARTED', 'IN_TRANSIT', 'DELAYED'] },
      },
      orderBy: { plannedDepartureAt: 'desc' },
      select: { id: true, companyId: true },
    });

    await this.prisma.gpsPosition.create({
      data: {
        vehicleId: device.vehicleId,
        shipmentId: shipment?.id ?? null,
        latitude: fix.latitude,
        longitude: fix.longitude,
        speedKmh: fix.speedKmh ?? null,
        headingDegrees: fix.headingDegrees ?? null,
        accuracyM: fix.accuracyM ?? null,
        isSimulated: false,
        recordedAt: fix.recordedAt,
      },
    });

    // Only ever move the denormalised position forward in time, so a batch flushed after a
    // coverage gap cannot drag the live map backwards.
    await this.prisma.vehicle.updateMany({
      where: {
        id: device.vehicleId,
        OR: [{ lastPositionAt: null }, { lastPositionAt: { lt: fix.recordedAt } }],
      },
      data: {
        lastLatitude: fix.latitude,
        lastLongitude: fix.longitude,
        lastSpeedKmh: fix.speedKmh ?? null,
        lastHeadingDegrees: fix.headingDegrees ?? null,
        lastPositionAt: fix.recordedAt,
      },
    });

    await this.prisma.trackingDevice.update({
      where: { id: device.id },
      data: {
        status: 'ONLINE',
        lastSeenAt: new Date(),
        lastLatitude: fix.latitude,
        lastLongitude: fix.longitude,
        lastBatteryPercent: fix.batteryPercent ?? device.lastBatteryPercent,
        positionsAccepted: { increment: 1 },
      },
    });

    this.gateway.emitPosition(device.companyId, shipment?.id ?? null, {
      vehicleId: device.vehicleId,
      shipmentId: shipment?.id ?? null,
      latitude: fix.latitude,
      longitude: fix.longitude,
      speedKmh: fix.speedKmh ?? null,
      headingDegrees: fix.headingDegrees ?? null,
      recordedAt: fix.recordedAt.toISOString(),
      isSimulated: false,
      deviceKind: device.kind,
    });

    return true;
  }

  /** Why a fix should not be stored, or null when it is fine. */
  private rejectionReason(
    device: {
      lastLatitude: number | null;
      lastLongitude: number | null;
      lastSeenAt: Date | null;
      vehicle: { lastLatitude: number | null; lastLongitude: number | null; lastPositionAt: Date | null } | null;
    },
    fix: IncomingFix,
  ): string | null {
    if (!Number.isFinite(fix.latitude) || Math.abs(fix.latitude) > 90) return 'latitude out of range';
    if (!Number.isFinite(fix.longitude) || Math.abs(fix.longitude) > 180) return 'longitude out of range';

    // 0,0 is in the Gulf of Guinea. It is also what a device with no fix emits, and — awkwardly
    // for this deployment — it is only a few hundred kilometres from Ghana, so it looks almost
    // plausible on the map. Rejected explicitly.
    if (Math.abs(fix.latitude) < 0.0001 && Math.abs(fix.longitude) < 0.0001) {
      return 'null island (0,0) — the device has no fix';
    }

    if (fix.recordedAt.getTime() > Date.now() + MAX_FUTURE_SKEW_MS) {
      return 'timestamp is in the future; the device clock is wrong';
    }

    const previous = device.vehicle;
    if (previous?.lastLatitude != null && previous.lastLongitude != null && previous.lastPositionAt) {
      const hours = (fix.recordedAt.getTime() - previous.lastPositionAt.getTime()) / 3_600_000;
      if (hours > 0) {
        const distanceKm = haversineKm(
          { latitude: previous.lastLatitude, longitude: previous.lastLongitude },
          { latitude: fix.latitude, longitude: fix.longitude },
        );
        if (distanceKm / hours > IMPLAUSIBLE_SPEED_KMH) {
          return `implied ${(distanceKm / hours).toFixed(0)} km/h from the previous fix`;
        }
        if (distanceKm * 1000 < MIN_FIX_SEPARATION_M && hours * 3600 < 30) {
          return 'below the minimum movement threshold';
        }
      }
    }

    return null;
  }

  async recordStatus(
    identifier: string,
    status: { batteryPercent: number; ignitionOn: boolean; alarm: string | null },
  ): Promise<void> {
    await this.prisma.trackingDevice
      .updateMany({
        where: { identifier },
        data: {
          status: 'ONLINE',
          lastSeenAt: new Date(),
          lastBatteryPercent: status.batteryPercent,
          lastIgnitionOn: status.ignitionOn,
        },
      })
      .catch(() => undefined);
  }

  /** An SOS or power-cut from a tracker is an operational event, not a log line. */
  async raiseDeviceAlarm(identifier: string, alarm: string): Promise<void> {
    const device = await this.prisma.trackingDevice.findUnique({
      where: { identifier },
      include: { vehicle: { select: { plateNumber: true } } },
    });
    if (!device) return;

    const label = device.vehicle?.plateNumber ?? device.label ?? identifier;
    const critical = alarm === 'SOS' || alarm === 'POWER_CUT';

    await this.notifications.notify({
      companyId: device.companyId,
      type: 'ANOMALY_DETECTED',
      severity: critical ? 'CRITICAL' : 'WARNING',
      title: `${alarm.replace(/_/g, ' ')} on ${label}`,
      body:
        alarm === 'SOS'
          ? 'The driver pressed the panic button on the tracker. Contact them now.'
          : alarm === 'POWER_CUT'
            ? 'The tracker lost vehicle power. Either the battery was disconnected or the device was removed.'
            : `The tracker reported ${alarm.replace(/_/g, ' ').toLowerCase()}.`,
      target: device.vehicleId ? { entity: 'vehicle', id: device.vehicleId } : {},
      channels: critical ? ['DASHBOARD', 'EMAIL'] : ['DASHBOARD'],
    });
  }

  /* ============================================================== phone path */

  /**
   * Authenticates a phone by its pairing secret.
   *
   * A driver's access token lasts fifteen minutes and their phone cannot refresh it inside a
   * coverage gap — which is exactly where tracking matters. The pairing secret is long-lived,
   * scoped to posting positions for one device, and revocable by disabling that device.
   */
  async authenticatePhone(identifier: string, secret: string): Promise<string | null> {
    const device = await this.prisma.trackingDevice.findUnique({ where: { identifier } });
    if (!device || device.kind !== 'PHONE' || !device.pairingSecretHash) return null;
    if (device.status === 'DISABLED') return null;

    try {
      const valid = await verify(device.pairingSecretHash, secret);
      return valid ? device.id : null;
    } catch {
      return null;
    }
  }

  /**
   * Accepts a batch from a phone.
   *
   * Batches, not single fixes, because a phone on a rural route loses signal for minutes at a
   * time and buffers. Reporting what was rejected and why is what lets a driver's app show
   * "12 sent, 12 accepted" rather than a silent success that may have stored nothing.
   */
  async ingestPhoneBatch(
    identifier: string,
    fixes: IncomingFix[],
  ): Promise<{ accepted: number; rejected: number }> {
    const ordered = [...fixes].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());

    let accepted = 0;
    for (const fix of ordered) {
      if (await this.recordPosition(identifier, fix)) accepted += 1;
    }

    return { accepted, rejected: ordered.length - accepted };
  }

  /* ================================================================== health */

  /** Devices that should be reporting and are not. Driven by the scheduler. */
  async sweepOffline(): Promise<number> {
    const devices = await this.prisma.trackingDevice.findMany({
      where: { status: 'ONLINE', lastSeenAt: { not: null } },
      select: { id: true, lastSeenAt: true, reportIntervalSeconds: true },
    });

    const stale = devices.filter(
      (device) =>
        Date.now() - device.lastSeenAt!.getTime() > device.reportIntervalSeconds * 1000 * 5,
    );

    if (stale.length > 0) {
      await this.prisma.trackingDevice.updateMany({
        where: { id: { in: stale.map((device) => device.id) } },
        data: { status: 'OFFLINE' },
      });
    }
    return stale.length;
  }
}
