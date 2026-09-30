import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, type Server, type Socket } from 'node:net';
import type { AppConfig } from '../../config/configuration';
import { DevicesService } from './devices.service';
import {
  Gt06ProtocolError,
  buildAck,
  decodeLocation,
  decodeLogin,
  decodeStatus,
  isLocationProtocol,
  readFrame,
  requiresAck,
  GT06_PROTOCOL,
} from './gt06-codec';

/**
 * TCP listener for hardware GPS trackers.
 *
 * These devices do not speak HTTP. They open a raw TCP socket to a host and port configured by
 * SMS, send a binary login packet, and then stream position packets — expecting the server to
 * acknowledge specific message types. That is why this is a separate server on its own port
 * rather than another route on the API.
 *
 * Three things about running a socket server that a request/response API never has to think about:
 *
 * **A session is per-connection.** The IMEI arrives once, in the login packet, and every
 * subsequent packet on that socket is implicitly from that device. Losing the association means
 * losing every position until the device reconnects, so it lives on the socket object.
 *
 * **TCP is a stream, not messages.** A packet arrives split across two reads, or two packets
 * arrive in one. Each socket therefore keeps a buffer and drains whole frames from it, and a
 * partial frame waits rather than being discarded.
 *
 * **An unauthenticated socket is a resource.** A device that connects and never logs in, or one
 * that floods, would otherwise hold a socket and a buffer forever. Both are bounded.
 */

/** Sockets that have not identified themselves are closed after this long. */
const LOGIN_TIMEOUT_MS = 30_000;

/** A device that goes quiet for this long has its socket reclaimed. */
const IDLE_TIMEOUT_MS = 10 * 60_000;

/**
 * A frame cannot exceed this. A device sending more than this without a valid terminator is
 * either broken or hostile, and either way the buffer must not grow without bound.
 */
const MAX_BUFFER_BYTES = 8 * 1024;

interface DeviceSession {
  imei: string | null;
  buffer: Buffer;
  packetsReceived: number;
  connectedAt: Date;
  loginTimer: NodeJS.Timeout | null;
}

@Injectable()
export class DeviceGatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeviceGatewayService.name);

  private server: Server | null = null;
  private readonly sessions = new Map<Socket, DeviceSession>();

  private readonly enabled: boolean;
  private readonly port: number;
  private readonly host: string;

  private packetsDecoded = 0;
  private packetsRejected = 0;
  private positionsStored = 0;

  constructor(
    private readonly devices: DevicesService,
    config: ConfigService<AppConfig, true>,
  ) {
    const gateway = config.get('deviceGateway', { infer: true });
    this.enabled = gateway.enabled;
    this.port = gateway.port;
    this.host = gateway.host;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Device gateway disabled (DEVICE_GATEWAY_ENABLED=false)');
      return;
    }

    this.server = createServer((socket) => this.handleConnection(socket));

    this.server.on('error', (error) => {
      this.logger.error(`Device gateway server error: ${error.message}`);
    });

    this.server.listen(this.port, this.host, () => {
      this.logger.log(
        `Device gateway listening on tcp/${this.port} — point a GT06 tracker here with ` +
          `SMS: server#<host>#${this.port}#`,
      );
    });
  }

  onModuleDestroy(): void {
    for (const [socket, session] of this.sessions) {
      if (session.loginTimer) clearTimeout(session.loginTimer);
      socket.destroy();
    }
    this.sessions.clear();
    this.server?.close();
  }

  /* ------------------------------------------------------------ connection */

  private handleConnection(socket: Socket): void {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    this.logger.debug(`Device connected from ${remote}`);

    const session: DeviceSession = {
      imei: null,
      buffer: Buffer.alloc(0),
      packetsReceived: 0,
      connectedAt: new Date(),
      loginTimer: setTimeout(() => {
        this.logger.warn(`${remote} never sent a login packet; closing`);
        socket.destroy();
      }, LOGIN_TIMEOUT_MS),
    };

    this.sessions.set(socket, session);
    socket.setTimeout(IDLE_TIMEOUT_MS);

    socket.on('data', (chunk) => void this.handleData(socket, session, chunk, remote));
    socket.on('timeout', () => {
      this.logger.debug(`${session.imei ?? remote} idle; closing`);
      socket.destroy();
    });
    socket.on('error', (error) => {
      // A tracker on a mobile network drops the connection constantly. That is normal, not an
      // incident, so it is logged at debug and the device simply reconnects.
      this.logger.debug(`${session.imei ?? remote} socket error: ${error.message}`);
    });
    socket.on('close', () => {
      if (session.loginTimer) clearTimeout(session.loginTimer);
      this.sessions.delete(socket);
      if (session.imei) void this.devices.markDisconnected(session.imei);
    });
  }

  private async handleData(
    socket: Socket,
    session: DeviceSession,
    chunk: Buffer,
    remote: string,
  ): Promise<void> {
    session.buffer = Buffer.concat([session.buffer, chunk]);

    if (session.buffer.length > MAX_BUFFER_BYTES) {
      this.logger.warn(`${session.imei ?? remote} exceeded the frame buffer limit; closing`);
      socket.destroy();
      return;
    }

    // Drain every complete frame currently in the buffer. More than one often arrives together
    // after a coverage gap, when the device flushes what it stored while offline.
    for (;;) {
      let frame;
      try {
        frame = readFrame(session.buffer);
      } catch (error) {
        // A desynchronised stream cannot be recovered by guessing where the next frame starts;
        // dropping the connection lets the device reconnect cleanly.
        this.packetsRejected += 1;
        this.logger.warn(
          `${session.imei ?? remote} sent an undecodable frame (${
            error instanceof Gt06ProtocolError ? error.message : String(error)
          }); closing`,
        );
        socket.destroy();
        return;
      }

      if (!frame) return; // wait for the rest
      session.buffer = session.buffer.subarray(frame.length);
      session.packetsReceived += 1;
      this.packetsDecoded += 1;

      try {
        await this.handleFrame(socket, session, frame, remote);
      } catch (error) {
        this.logger.warn(`Failed to handle frame from ${session.imei ?? remote}: ${error}`);
      }
    }
  }

  private async handleFrame(
    socket: Socket,
    session: DeviceSession,
    frame: { protocol: number; payload: Buffer; serial: number },
    remote: string,
  ): Promise<void> {
    // The acknowledgement goes out before the database work. A device waits a few seconds and
    // then assumes the server is dead; making it wait on a slow query is how a tracker ends up
    // reconnecting in a loop and burning its data allowance.
    if (requiresAck(frame.protocol)) {
      socket.write(buildAck(frame.protocol, frame.serial));
    }

    if (frame.protocol === GT06_PROTOCOL.LOGIN) {
      const imei = decodeLogin(frame.payload);
      session.imei = imei;
      if (session.loginTimer) {
        clearTimeout(session.loginTimer);
        session.loginTimer = null;
      }

      const known = await this.devices.registerConnection(imei, socket.remoteAddress ?? null);
      if (!known) {
        // An unknown IMEI is usually a device pointed at the wrong host, or one nobody has
        // enrolled yet. Closing is right — but the attempt is recorded so the operator can see
        // that a device *is* dialling in and just needs registering.
        this.logger.warn(`Unknown device IMEI ${imei} from ${remote}; closing`);
        socket.destroy();
        return;
      }

      this.logger.log(`Device ${imei} authenticated from ${remote}`);
      return;
    }

    if (!session.imei) {
      this.logger.warn(`${remote} sent protocol 0x${frame.protocol.toString(16)} before login`);
      socket.destroy();
      return;
    }

    if (isLocationProtocol(frame.protocol)) {
      const location = decodeLocation(frame.payload);

      // A device with no fix still transmits, carrying its last known position. Storing that as
      // if it were current would draw a truck sitting still while it is actually moving through
      // a tunnel — worse than a gap, because a gap is visibly a gap.
      if (!location.valid) {
        this.logger.debug(`${session.imei} reported an invalid fix; skipped`);
        await this.devices.recordRejected(session.imei);
        return;
      }

      const stored = await this.devices.recordPosition(session.imei, {
        latitude: location.latitude,
        longitude: location.longitude,
        speedKmh: location.speedKmh,
        headingDegrees: location.courseDegrees,
        recordedAt: location.recordedAt,
        satellites: location.satellites,
      });

      if (stored) this.positionsStored += 1;
      return;
    }

    if (frame.protocol === GT06_PROTOCOL.STATUS) {
      const status = decodeStatus(frame.payload);
      await this.devices.recordStatus(session.imei, {
        // GT06 reports battery on its own 0–6 scale, not a percentage.
        batteryPercent: Math.round((Math.min(status.batteryLevel, 6) / 6) * 100),
        ignitionOn: status.ignitionOn,
        alarm: status.alarm,
      });

      if (status.alarm) {
        this.logger.warn(`Device ${session.imei} raised alarm ${status.alarm}`);
        await this.devices.raiseDeviceAlarm(session.imei, status.alarm);
      }
    }
  }

  /* ---------------------------------------------------------------- status */

  status() {
    return {
      enabled: this.enabled,
      port: this.port,
      listening: this.server?.listening ?? false,
      openConnections: this.sessions.size,
      authenticatedConnections: [...this.sessions.values()].filter((s) => s.imei).length,
      packetsDecoded: this.packetsDecoded,
      packetsRejected: this.packetsRejected,
      positionsStored: this.positionsStored,
      protocol: 'GT06 / Concox',
      howToPointADeviceHere: this.enabled
        ? `Envoyez ce SMS à la balise : server#<votre-hôte-public>#${this.port}#`
        : 'Définissez DEVICE_GATEWAY_ENABLED=true et redémarrez l’API.',
    };
  }
}
