import { Logger } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';
import { mapNavStatus, type VesselFix, type VesselProvider } from './vessel-provider';

/**
 * MarineTraffic as a position source.
 *
 * Worth being precise about what MarineTraffic is and is not, because it is easy to assume it
 * replaces the AIS feed and it does not:
 *
 *   * **Their API is paid**, priced per credit. There is no free tier. That is a legitimate
 *     business model — they run receiver infrastructure and buy satellite AIS — but it means this
 *     provider only activates when somebody has paid for a key.
 *   * **Their coverage is better than a raw terrestrial feed.** Terrestrial AIS reaches roughly
 *     40–60 nautical miles offshore; mid-ocean a ship simply vanishes from it. MarineTraffic
 *     fuses satellite AIS, so a vessel in the middle of the Atlantic still reports. For a
 *     trans-ocean voyage that gap is the difference between a track and two disconnected ends.
 *   * **It returns data, unlike their embed.** The iframe on the vessel screen is a picture. This
 *     is JSON that lands in `vessel_positions`, so the ETA engine, the anomaly detector and the
 *     shipment join can all use it. Anything that has to *reason* about a position needs this
 *     path, not the embed.
 *
 * Polling, not streaming: the API is request/response, so this pulls on an interval rather than
 * holding a socket. That is also why it is a poor fit for a large watched fleet on a small credit
 * budget — each poll costs credits per vessel — and why the interval is configurable.
 */

/** MarineTraffic PS01 (single vessel) / PS07 (fleet) response row, in their positional format. */
interface MarineTrafficRow {
  MMSI: string;
  IMO?: string;
  STATUS?: string;
  SPEED?: string;
  LON: string;
  LAT: string;
  COURSE?: string;
  HEADING?: string;
  TIMESTAMP: string;
  SHIPNAME?: string;
  DRAUGHT?: string;
}

export class MarineTrafficProvider implements VesselProvider {
  readonly name = 'MARINE_TRAFFIC';
  readonly isLive = true;

  private readonly logger = new Logger(MarineTrafficProvider.name);
  private readonly http: AxiosInstance;

  private timer: NodeJS.Timeout | null = null;
  private pollsCompleted = 0;
  private lastPollAt: Date | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly onFix: (fix: VesselFix) => void,
    /** How often to poll, in seconds. Each poll costs credits, so this is not a free knob. */
    private readonly pollSeconds: number,
    /** Resolves the MMSIs currently worth spending credits on. */
    private readonly trackedMmsi: () => Promise<string[]>,
  ) {
    this.http = axios.create({
      baseURL: 'https://services.marinetraffic.com/api',
      timeout: 20_000,
    });
  }

  describe(): string {
    return (
      `polling every ${this.pollSeconds}s, ${this.pollsCompleted} poll(s)` +
      (this.lastPollAt ? `, last ${this.lastPollAt.toISOString()}` : '') +
      (this.lastError ? `, last error: ${this.lastError}` : '')
    );
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollSeconds * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    let mmsiList: string[];
    try {
      mmsiList = await this.trackedMmsi();
    } catch (error) {
      this.lastError = `could not resolve tracked vessels: ${error}`;
      return;
    }

    if (mmsiList.length === 0) return;

    try {
      // PS01 with `timespan` returns the last known position for the vessels on the account's
      // fleet. `protocol=jsono` asks for named JSON rather than their positional array format,
      // which is far less error-prone to parse.
      const response = await this.http.get<MarineTrafficRow[]>(
        `/exportvessels/v:8/${this.apiKey}/protocol:jsono/timespan:60`,
      );

      const wanted = new Set(mmsiList);
      let matched = 0;

      for (const row of response.data ?? []) {
        if (!wanted.has(String(row.MMSI))) continue;

        const latitude = Number.parseFloat(row.LAT);
        const longitude = Number.parseFloat(row.LON);
        if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) continue;
        if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) continue;

        // Speed arrives in tenths of a knot.
        const speedTenths = row.SPEED === undefined ? null : Number.parseFloat(row.SPEED);
        const courseTenths = row.COURSE === undefined ? null : Number.parseFloat(row.COURSE);

        this.onFix({
          mmsi: String(row.MMSI),
          imoNumber: row.IMO || null,
          name: row.SHIPNAME?.trim() || null,
          latitude,
          longitude,
          speedKnots:
            speedTenths !== null && Number.isFinite(speedTenths) ? speedTenths / 10 : null,
          courseDegrees:
            courseTenths !== null && Number.isFinite(courseTenths) ? courseTenths / 10 : null,
          headingDegrees:
            row.HEADING !== undefined && Number.isFinite(Number(row.HEADING))
              ? Number(row.HEADING)
              : null,
          draughtM:
            row.DRAUGHT !== undefined && Number.isFinite(Number(row.DRAUGHT))
              ? Number(row.DRAUGHT) / 10
              : null,
          navStatus: mapNavStatus(row.STATUS === undefined ? null : Number(row.STATUS)),
          recordedAt: row.TIMESTAMP ? new Date(row.TIMESTAMP) : new Date(),
          source: 'MARINE_TRAFFIC',
        });
        matched += 1;
      }

      this.pollsCompleted += 1;
      this.lastPollAt = new Date();
      this.lastError = null;
      this.logger.debug(`MarineTraffic poll matched ${matched} of ${mmsiList.length} vessels`);
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? `${error.response?.status ?? ''} ${error.message}`.trim()
        : String(error);
      this.lastError = message;
      // A 429 here means the credit budget is spent. Logged rather than retried immediately,
      // because retrying a credit-exhausted account just burns the next allocation too.
      this.logger.warn(`MarineTraffic poll failed: ${message}`);
    }
  }
}

/* ========================================================================== */
/*  Deep links — free, no key, no terms to accept.                            */
/* ========================================================================== */

/**
 * Public links to third-party vessel trackers.
 *
 * These are ordinary hyperlinks to public pages. They need no API key, cost nothing and carry no
 * licensing question — following a link is what links are for. They are genuinely useful even
 * when a paid feed is configured: an operator who wants a second opinion, a photograph of the
 * hull, or the port-call history that this system does not store gets it in one click.
 *
 * IMO is preferred over MMSI wherever both exist. IMO is permanent for the life of the hull;
 * MMSI is issued by the flag state and changes on reflagging, so an MMSI link can silently point
 * at a different ship after a sale.
 */
export interface VesselExternalLinks {
  marineTraffic: string | null;
  vesselFinder: string | null;
  /** What the link was built from, so the UI can say why it might be missing. */
  identifierUsed: 'IMO' | 'MMSI' | 'NAME' | null;
}

export function buildExternalLinks(vessel: {
  name: string;
  imoNumber?: string | null;
  mmsi?: string | null;
}): VesselExternalLinks {
  if (vessel.imoNumber) {
    return {
      marineTraffic: `https://www.marinetraffic.com/en/ais/details/ships/imo:${vessel.imoNumber}`,
      vesselFinder: `https://www.vesselfinder.com/vessels/details/${vessel.imoNumber}`,
      identifierUsed: 'IMO',
    };
  }

  if (vessel.mmsi) {
    return {
      marineTraffic: `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${vessel.mmsi}`,
      // VesselFinder's detail route is IMO-keyed, so an MMSI-only vessel goes to search instead
      // of a URL that would 404.
      vesselFinder: `https://www.vesselfinder.com/vessels?name=${encodeURIComponent(vessel.name)}`,
      identifierUsed: 'MMSI',
    };
  }

  if (vessel.name) {
    return {
      marineTraffic: `https://www.marinetraffic.com/en/ais/index/search/all?keyword=${encodeURIComponent(vessel.name)}`,
      vesselFinder: `https://www.vesselfinder.com/vessels?name=${encodeURIComponent(vessel.name)}`,
      identifierUsed: 'NAME',
    };
  }

  return { marineTraffic: null, vesselFinder: null, identifierUsed: null };
}

/**
 * MarineTraffic's embeddable live map, centred on one vessel.
 *
 * Returns `null` unless `MARINETRAFFIC_EMBED_ENABLED` is set, and that default is deliberate.
 * Embedding a third party's map in your product is a question about *their* terms of service, not
 * about your code — MarineTraffic's terms govern how their map may be displayed, and whether your
 * use qualifies depends on your deployment and your agreement with them. That is a decision for
 * whoever operates this system, so it is an explicit opt-in with the reason written next to it
 * rather than something that silently starts calling their servers.
 *
 * The deep links above have no such question and are always available.
 */
export function buildEmbedUrl(
  vessel: { mmsi?: string | null; imoNumber?: string | null; latitude?: number; longitude?: number },
  enabled: boolean,
): string | null {
  if (!enabled) return null;
  if (!vessel.mmsi && !vessel.imoNumber) return null;

  const parameters = [
    'zoom:8',
    'maptype:4',
    'shownames:true',
    'trackvessel:1',
    vessel.mmsi ? `mmsi:${vessel.mmsi}` : `imo:${vessel.imoNumber}`,
  ];

  if (Number.isFinite(vessel.latitude) && Number.isFinite(vessel.longitude)) {
    parameters.push(`centery:${vessel.latitude!.toFixed(4)}`, `centerx:${vessel.longitude!.toFixed(4)}`);
  }

  return `https://www.marinetraffic.com/en/ais/embed/${parameters.join('/')}`;
}
