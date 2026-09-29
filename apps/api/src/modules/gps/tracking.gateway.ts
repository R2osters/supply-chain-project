import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayInit,
} from '@nestjs/websockets';
import { roleHasPermission, type UserRole } from '@scip/shared';
import type { Server, Socket } from 'socket.io';
import type { AppConfig } from '../../config/configuration';
import { PASSWORD_CHANGE_REQUIRED } from '../../common/guards/password-change.guard';
import type { JwtAccessPayload } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';

/** Deliberately vague: a precise reason tells an attacker which half of the token to fix. */
const INVALID_TOKEN = 'Invalid or expired access token';

/**
 * Live tracking channel.
 *
 * Rooms are the whole access-control story here: a socket is put into `company:<id>` at
 * connection time based on its verified JWT, and every broadcast targets a company room. There
 * is no client-supplied room name anywhere, so a client cannot subscribe to another tenant's
 * fleet by asking nicely. Per-shipment rooms exist too, but joining one is checked against the
 * socket's company first.
 *
 * A valid signature is not enough, for the same reasons as on HTTP (JwtStrategy,
 * PasswordChangeGuard): the account must still be active and unlocked, must not be waiting to
 * replace a temporary password, and its role must be allowed to read the live fleet (`gps:read`,
 * the permission `GET /gps/fleet` asks for). A customer or supplier account would otherwise
 * receive every truck position of the company, which the HTTP API refuses it.
 *
 * The handshake token is read from `auth.token` rather than a query parameter, because query
 * strings end up in proxy and server access logs.
 */
@WebSocketGateway({
  namespace: '/tracking',
  cors: { origin: true, credentials: true },
})
export class TrackingGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TrackingGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
  ) {}

  afterInit(): void {
    this.logger.log('Tracking gateway ready on /tracking');
  }

  async handleConnection(client: Socket): Promise<void> {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      (client.handshake.headers.authorization?.replace(/^Bearer\s+/i, '') || undefined);

    if (!token) return this.refuse(client, 'Missing access token');

    let payload: JwtAccessPayload;
    try {
      payload = this.jwt.verify<JwtAccessPayload>(token, {
        secret: this.config.get('auth', { infer: true }).accessSecret,
        algorithms: ['HS256'],
      });
      if (payload.type !== 'access') throw new Error('wrong token type');
    } catch {
      return this.refuse(client, INVALID_TOKEN);
    }

    const account = await this.readAccount(payload.sub).catch((error: Error) => {
      this.logger.warn(`Tracking handshake could not read the account: ${error.message}`);
      return undefined;
    });
    if (account === undefined) {
      return this.refuse(client, 'Live tracking is unavailable, try again shortly');
    }
    if (!account?.isActive || (account.lockedUntil && account.lockedUntil.getTime() > Date.now())) {
      return this.refuse(client, INVALID_TOKEN);
    }
    if (account.mustChangePassword) {
      return this.refuse(client, 'Choose a new password before following the live fleet', PASSWORD_CHANGE_REQUIRED);
    }
    // The stored role, not the token's: a downgrade applies now, not when the token expires.
    const role = account.role as UserRole;
    if (!roleHasPermission(role, 'gps:read')) {
      return this.refuse(client, 'This account cannot follow the live fleet', 'forbidden');
    }
    // The browser may have left while the account was being read.
    if (client.disconnected) return;

    client.data.userId = payload.sub;
    client.data.companyId = account.companyId;
    client.data.role = role;
    client.data.verified = true;

    if (account.companyId) {
      await client.join(`company:${account.companyId}`);
    }
    client.emit('connected', { userId: payload.sub, companyId: account.companyId });
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Socket ${client.id} disconnected`);
  }

  /**
   * Opt into a single shipment's stream. Rejected unless the shipment belongs to the socket's
   * company (a platform super-admin may follow any shipment).
   */
  @SubscribeMessage('subscribe:shipment')
  async subscribeShipment(client: Socket, payload: { shipmentId?: string }) {
    // Messages can arrive while the handshake is still reading the account.
    if (client.data.verified !== true) {
      return { ok: false, error: 'Not authenticated' };
    }
    const shipmentId = typeof payload?.shipmentId === 'string' ? payload.shipmentId : '';
    if (!shipmentId) {
      return { ok: false, error: 'shipmentId is required' };
    }
    const companyId = client.data.companyId as string | null;
    const superAdmin = client.data.role === 'SUPER_ADMIN';
    if (!companyId && !superAdmin) {
      return { ok: false, error: 'Not attached to a company' };
    }
    const shipment = await this.prisma.shipment.findFirst({
      where: superAdmin ? { id: shipmentId } : { id: shipmentId, companyId: companyId as string },
      select: { id: true },
    });
    // Same answer for "does not exist" and "belongs to someone else": ids are not an oracle.
    if (!shipment) {
      return { ok: false, error: 'Shipment not found' };
    }
    await client.join(`shipment:${shipment.id}`);
    return { ok: true, room: `shipment:${shipment.id}` };
  }

  @SubscribeMessage('unsubscribe:shipment')
  unsubscribeShipment(client: Socket, payload: { shipmentId?: string }) {
    if (payload?.shipmentId) void client.leave(`shipment:${payload.shipmentId}`);
    return { ok: true };
  }

  /* ------------------------------------------------------------ broadcasts */

  emitPosition(companyId: string, shipmentId: string | null, position: unknown): void {
    this.server?.to(`company:${companyId}`).emit('position', position);
    if (shipmentId) {
      this.server?.to(`shipment:${shipmentId}`).emit('position', position);
    }
  }

  /** Vessel positions ride the same company room as vehicles; the payload shape distinguishes them. */
  emitVesselPosition(companyId: string, position: unknown): void {
    this.server?.to(`company:${companyId}`).emit('vessel:position', position);
  }

  emitShipmentUpdate(companyId: string, shipmentId: string, update: unknown): void {
    this.server?.to(`company:${companyId}`).emit('shipment:update', update);
    this.server?.to(`shipment:${shipmentId}`).emit('shipment:update', update);
  }

  emitAlert(companyId: string, alert: unknown): void {
    this.server?.to(`company:${companyId}`).emit('alert', alert);
  }

  emitAnomaly(companyId: string, shipmentId: string, anomaly: unknown): void {
    this.server?.to(`company:${companyId}`).emit('anomaly', anomaly);
    this.server?.to(`shipment:${shipmentId}`).emit('anomaly', anomaly);
  }

  /** Connected socket count, used by the health endpoint and the ops dashboard. */
  connectionCount(): number {
    return this.server?.sockets?.sockets?.size ?? 0;
  }

  /** `null` when the account no longer exists; the promise rejects when the database is down. */
  private readAccount(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { isActive: true, lockedUntil: true, mustChangePassword: true, role: true, companyId: true },
    });
  }

  /** Tells the client why, then closes: a refused socket joins no room and receives nothing. */
  private refuse(client: Socket, message: string, code?: string): void {
    client.emit('error', code ? { message, code } : { message });
    client.disconnect(true);
  }
}
