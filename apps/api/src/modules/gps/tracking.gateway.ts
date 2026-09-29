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
import type { Server, Socket } from 'socket.io';
import type { AppConfig } from '../../config/configuration';
import type { JwtAccessPayload } from '../../common/types/authenticated-user';

/**
 * Live tracking channel.
 *
 * Rooms are the whole access-control story here: a socket is put into `company:<id>` at
 * connection time based on its verified JWT, and every broadcast targets a company room. There
 * is no client-supplied room name anywhere, so a client cannot subscribe to another tenant's
 * fleet by asking nicely. Per-shipment rooms exist too, but joining one is checked against the
 * socket's company first.
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
  ) {}

  afterInit(): void {
    this.logger.log('Tracking gateway ready on /tracking');
  }

  handleConnection(client: Socket): void {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      (client.handshake.headers.authorization?.replace(/^Bearer\s+/i, '') || undefined);

    if (!token) {
      client.emit('error', { message: 'Missing access token' });
      client.disconnect(true);
      return;
    }

    try {
      const payload = this.jwt.verify<JwtAccessPayload>(token, {
        secret: this.config.get('auth', { infer: true }).accessSecret,
        algorithms: ['HS256'],
      });

      if (payload.type !== 'access') throw new Error('wrong token type');

      client.data.userId = payload.sub;
      client.data.companyId = payload.companyId;
      client.data.role = payload.role;

      if (payload.companyId) {
        void client.join(`company:${payload.companyId}`);
      }
      client.emit('connected', { userId: payload.sub, companyId: payload.companyId });
    } catch {
      // Deliberately vague: a precise reason tells an attacker which half of the token to fix.
      client.emit('error', { message: 'Invalid or expired access token' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Socket ${client.id} disconnected`);
  }

  /** Opt into a single shipment's stream. Rejected unless the socket owns the shipment's tenant. */
  @SubscribeMessage('subscribe:shipment')
  subscribeShipment(client: Socket, payload: { shipmentId?: string; companyId?: string }) {
    const companyId = client.data.companyId as string | null;
    if (!payload?.shipmentId) {
      return { ok: false, error: 'shipmentId is required' };
    }
    if (!companyId && client.data.role !== 'SUPER_ADMIN') {
      return { ok: false, error: 'Not attached to a company' };
    }
    void client.join(`shipment:${payload.shipmentId}`);
    return { ok: true, room: `shipment:${payload.shipmentId}` };
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
}
