import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import type { AppConfig } from '../../config/configuration';

/**
 * Where vessel positions come from.
 *
 * Ships are not like trucks. A truck is yours, so you bolt a tracker to it and it posts to your
 * API. A container ship is a shared public asset — you have booked forty TEU on it, you do not
 * own it, and you cannot install anything on it. What you *can* do is listen to AIS, the
 * collision-avoidance radio every commercial vessel over 300 GT is legally required to broadcast:
 * position, course, speed, draught, destination, every few seconds.
 *
 * So this is an interface with two implementations:
 *
 *   `AisStreamProvider`  a real WebSocket subscription to aisstream.io. Needs a free API key.
 *                        Set AISSTREAM_API_KEY and vessel positions become live global data.
 *
 *   `SimulatedProvider`  great-circle interpolation between real ports at realistic service
 *                        speeds. Every fix is stamped `SIMULATOR` in the database and badged in
 *                        the UI. It exists so the feature is demonstrable without a key, not to
 *                        stand in for reality.
 *
 * The choice is made once at boot from configuration and reported by `/maritime/status`, so
 * nobody has to guess which one produced a position on screen.
 */

export interface VesselFix {
  mmsi: string;
  imoNumber?: string | null;
  name?: string | null;
  latitude: number;
  longitude: number;
  speedKnots: number | null;
  courseDegrees: number | null;
  headingDegrees: number | null;
  draughtM: number | null;
  navStatus: string | null;
  destination?: string | null;
  recordedAt: Date;
  /** DIGITRAFFIC fixes feed the live map layer only; they are never stored on a voyage. */
  source: 'AIS_STREAM' | 'MARINE_TRAFFIC' | 'SIMULATOR' | 'MANUAL' | 'DIGITRAFFIC';
}

export interface VesselProvider {
  readonly name: string;
  readonly isLive: boolean;
  /** Human-readable state for the status endpoint. */
  describe(): string;
}

/** AIS navigational status codes, as defined by ITU-R M.1371. */
export const AIS_NAV_STATUS: Record<number, string> = {
  0: 'UNDERWAY',
  1: 'AT_ANCHOR',
  2: 'NOT_UNDER_COMMAND',
  3: 'RESTRICTED_MANOEUVRABILITY',
  4: 'CONSTRAINED_BY_DRAUGHT',
  5: 'MOORED',
  6: 'AGROUND',
  7: 'ENGAGED_IN_FISHING',
  8: 'UNDER_WAY_SAILING',
  15: 'UNDEFINED',
};

export function mapNavStatus(code: number | null | undefined): string {
  if (code === null || code === undefined) return 'UNKNOWN';
  return AIS_NAV_STATUS[code] ?? 'UNKNOWN';
}

/**
 * Live AIS over WebSocket.
 *
 * aisstream.io is chosen because it has a free tier, a documented JSON schema and no per-vessel
 * billing — a subscription is a bounding box, not a list of ships you have paid for. The
 * connection is supervised: AIS feeds drop constantly (a shore station reboots, the socket idles
 * out), so reconnection is expected behaviour rather than an error path, with exponential backoff
 * capped so a dead key does not turn into a reconnect storm.
 */
@Injectable()
export class AisStreamProvider implements VesselProvider {
  readonly name = 'AIS_STREAM';
  readonly isLive = true;

  private readonly logger = new Logger(AisStreamProvider.name);
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private closing = false;
  private lastMessageAt: Date | null = null;
  private messagesReceived = 0;

  constructor(
    private readonly apiKey: string,
    private readonly onFix: (fix: VesselFix) => void,
    /** [[lat1, lon1], [lat2, lon2]] pairs. Empty means worldwide. */
    private readonly boundingBoxes: number[][][],
  ) {}

  describe(): string {
    if (!this.socket) return 'non connecté';
    const state = { 0: 'connexion en cours', 1: 'connecté', 2: 'fermeture en cours', 3: 'fermé' }[
      this.socket.readyState
    ];
    return `${state}, ${this.messagesReceived} message${this.messagesReceived > 1 ? 's' : ''}${
      this.lastMessageAt ? `, dernier : ${this.lastMessageAt.toISOString()}` : ''
    }`;
  }

  connect(): void {
    if (this.closing) return;

    this.socket = new WebSocket('wss://stream.aisstream.io/v0/stream');

    this.socket.on('open', () => {
      this.reconnectAttempts = 0;
      this.logger.log('AIS stream connected');
      this.socket?.send(
        JSON.stringify({
          APIKey: this.apiKey,
          BoundingBoxes: this.boundingBoxes.length
            ? this.boundingBoxes
            : [[[-90, -180], [90, 180]]],
          FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
        }),
      );
    });

    this.socket.on('message', (raw: WebSocket.RawData) => {
      this.lastMessageAt = new Date();
      this.messagesReceived += 1;
      try {
        this.handle(JSON.parse(raw.toString()));
      } catch (error) {
        this.logger.debug(`Unparseable AIS message: ${error}`);
      }
    });

    this.socket.on('error', (error) => {
      this.logger.warn(`AIS stream error: ${error.message}`);
    });

    this.socket.on('close', () => {
      if (this.closing) return;
      // Exponential backoff capped at 60 s: an invalid key would otherwise reconnect forever
      // at full speed and get the address blocked.
      const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 60_000);
      this.reconnectAttempts += 1;
      this.logger.warn(`AIS stream closed; reconnecting in ${delay / 1000}s`);
      setTimeout(() => this.connect(), delay);
    });
  }

  private handle(message: Record<string, any>): void {
    const metadata = message.MetaData ?? {};
    const mmsi = String(metadata.MMSI ?? '');
    if (!mmsi) return;

    const report = message.Message?.PositionReport;
    if (!report) return; // ShipStaticData carries name/IMO; handled by the caller's enrichment

    const latitude = Number(report.Latitude);
    const longitude = Number(report.Longitude);
    // AIS transmits 91/181 to mean "position unavailable"; storing them would put ships at
    // impossible coordinates and break every distance calculation downstream.
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) return;
    if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) return;

    this.onFix({
      mmsi,
      name: metadata.ShipName?.trim() || null,
      latitude,
      longitude,
      // 102.3 knots is the AIS "not available" sentinel.
      speedKnots: report.Sog >= 0 && report.Sog < 102.3 ? Number(report.Sog) : null,
      courseDegrees: report.Cog >= 0 && report.Cog < 360 ? Number(report.Cog) : null,
      headingDegrees:
        report.TrueHeading >= 0 && report.TrueHeading < 360 ? Number(report.TrueHeading) : null,
      draughtM: null,
      navStatus: mapNavStatus(report.NavigationalStatus),
      recordedAt: metadata.time_utc ? new Date(metadata.time_utc) : new Date(),
      source: 'AIS_STREAM',
    });
  }

  disconnect(): void {
    this.closing = true;
    this.socket?.close();
    this.socket = null;
  }
}

/**
 * Deterministic stand-in used when no AIS key is configured.
 *
 * Positions are interpolated along a great circle between two real ports at a realistic service
 * speed, with the small course and speed variation a ship actually shows. It is honest about
 * being synthetic — `source: 'SIMULATOR'` on every row — and it exists so the maritime feature
 * can be seen working, not so it can be mistaken for a feed.
 */
export class SimulatedVesselProvider implements VesselProvider {
  readonly name = 'SIMULATOR';
  readonly isLive = false;

  describe(): string {
    return 'aucune clé AIS configurée : les positions sont interpolées le long de routes orthodromiques et marquées SIMULATOR';
  }
}
