import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AppConfig } from '../../config/configuration';
import {
  greatCircleNauticalMiles,
  greatCircleTrack,
  knotsToKmh,
  type LatLng,
} from '@scip/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { paginated, type PaginationQueryDto } from '../../common/dto/pagination.dto';
import { companyFilter, requireCompanyId } from '../../common/tenancy/tenant-scope';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { TrackingGateway } from '../gps/tracking.gateway';
import type {
  CreatePortDto,
  CreateVesselDto,
  CreateVoyageDto,
  ReportVesselPositionDto,
  VesselQueryDto,
  VesselSearchDto,
} from './maritime.dto';
import type { VesselFix } from './vessel-provider';
import { buildEmbedUrl, buildExternalLinks } from './marinetraffic.provider';

/** Typical service speed by vessel class, in knots. Used to derive an ETA before AIS reports one. */
const SERVICE_SPEED_KNOTS: Record<string, number> = {
  CONTAINER: 18,
  FEEDER: 15,
  BULK_CARRIER: 13,
  TANKER: 13,
  GENERAL_CARGO: 14,
  RORO: 18,
  REEFER: 19,
  OTHER: 14,
};

/** Distance from the destination port at which a voyage counts as approaching, in nautical miles. */
const APPROACHING_NM = 50;

/** Distance at which a vessel is treated as berthed. */
const BERTHED_NM = 2;

@Injectable()
export class MaritimeService {
  private readonly logger = new Logger(MaritimeService.name);

  private readonly embedEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: TrackingGateway,
    config: ConfigService<AppConfig, true>,
  ) {
    this.embedEnabled = config.get('maritime', { infer: true }).marineTrafficEmbedEnabled;
  }

  /* ==================================================================== search */

  /**
   * Find a vessel from whatever identifier the user has.
   *
   * The user's actual request is "I have a ship, I want to type its name and find it". They do
   * not know whether the string on their paperwork is an IMO, an MMSI or a call sign, and they
   * should not have to pick a field. So one box: the shape of the input decides how it is
   * matched, and an exact identifier match is returned ahead of a fuzzy name match, because
   * someone who typed 9811000 wants *that* hull, not every ship whose name contains 9811000.
   *
   * Former names are searched too. Ships are renamed constantly on sale, and a bill of lading
   * raised last year carries the old name — a search that only knows the current one fails
   * exactly when the paperwork is oldest and the user is most stuck.
   */
  async search(user: AuthenticatedUser, dto: VesselSearchDto) {
    const term = dto.q.trim();
    const limit = dto.limit ?? 20;
    const includeUntracked = dto.includeUntracked === 'true';

    // A company's own fleet always matches; public AIS vessels (companyId null) are included
    // unless the caller asked to stay inside their own fleet.
    const ownership: Prisma.VesselWhereInput = includeUntracked
      ? { OR: [{ companyId: user.companyId ?? undefined }, { companyId: null }] }
      : { OR: [{ companyId: user.companyId ?? undefined }, { companyId: null }] };

    const isImo = /^\d{7}$/.test(term);
    const isMmsi = /^\d{9}$/.test(term);

    const clauses: Prisma.VesselWhereInput[] = [
      { name: { contains: term, mode: 'insensitive' } },
      { formerNames: { has: term } },
      { callSign: { equals: term, mode: 'insensitive' } },
    ];
    if (isImo) clauses.push({ imoNumber: term });
    if (isMmsi) clauses.push({ mmsi: term });
    // A short numeric string is neither a valid IMO nor MMSI, but it is a plausible prefix of
    // one — someone reading a number aloud gets cut off. Prefix-match rather than return nothing.
    if (/^\d{3,8}$/.test(term)) {
      clauses.push({ imoNumber: { startsWith: term } }, { mmsi: { startsWith: term } });
    }

    const vessels = await this.prisma.vessel.findMany({
      where: { AND: [ownership, { OR: clauses }] },
      take: limit,
      include: {
        voyages: {
          where: { status: { in: ['LOADING', 'AT_SEA', 'APPROACHING', 'BERTHED', 'DISCHARGING'] } },
          orderBy: { scheduledDepartureAt: 'desc' },
          take: 1,
          include: {
            originPort: { select: { locode: true, name: true, country: true } },
            destinationPort: { select: { locode: true, name: true, country: true } },
          },
        },
      },
    });

    const scored = vessels
      .map((vessel) => ({ vessel, score: this.matchScore(vessel, term, isImo, isMmsi) }))
      .sort((a, b) => b.score - a.score);

    return {
      query: term,
      interpretedAs: isImo
        ? 'numéro IMO'
        : isMmsi
          ? 'MMSI'
          : /^\d+$/.test(term)
            ? 'identifiant partiel'
            : 'nom ou indicatif',
      count: scored.length,
      results: scored.map(({ vessel, score }) => ({
        id: vessel.id,
        name: vessel.name,
        formerNames: vessel.formerNames,
        imoNumber: vessel.imoNumber,
        mmsi: vessel.mmsi,
        callSign: vessel.callSign,
        type: vessel.type,
        flag: vessel.flag,
        status: vessel.status,
        operator: vessel.operator,
        capacityTeu: vessel.capacityTeu,
        matchScore: score,
        isOwnFleet: vessel.companyId !== null,
        isDemoData: vessel.isDemoData,
        externalLinks: buildExternalLinks(vessel),
        position:
          vessel.lastLatitude === null || vessel.lastLongitude === null
            ? null
            : {
                latitude: vessel.lastLatitude,
                longitude: vessel.lastLongitude,
                speedKnots: vessel.lastSpeedKnots,
                courseDegrees: vessel.lastCourseDegrees,
                recordedAt: vessel.lastPositionAt,
                source: vessel.positionSource,
                ageMinutes: vessel.lastPositionAt
                  ? Math.round((Date.now() - vessel.lastPositionAt.getTime()) / 60_000)
                  : null,
              },
        currentVoyage: vessel.voyages[0]
          ? {
              id: vessel.voyages[0].id,
              voyageNumber: vessel.voyages[0].voyageNumber,
              status: vessel.voyages[0].status,
              from: vessel.voyages[0].originPort,
              to: vessel.voyages[0].destinationPort,
              estimatedArrivalAt: vessel.voyages[0].estimatedArrivalAt,
            }
          : null,
      })),
    };
  }

  /** Exact identifier beats exact name beats prefix beats substring. */
  private matchScore(
    vessel: { name: string; imoNumber: string | null; mmsi: string | null; callSign: string | null; formerNames: string[] },
    term: string,
    isImo: boolean,
    isMmsi: boolean,
  ): number {
    const lower = term.toLowerCase();
    if (isImo && vessel.imoNumber === term) return 100;
    if (isMmsi && vessel.mmsi === term) return 100;
    if (vessel.callSign?.toLowerCase() === lower) return 95;
    if (vessel.name.toLowerCase() === lower) return 90;
    if (vessel.name.toLowerCase().startsWith(lower)) return 70;
    if (vessel.formerNames.some((name) => name.toLowerCase() === lower)) return 60;
    if (vessel.name.toLowerCase().includes(lower)) return 50;
    return 10;
  }

  /* ==================================================================== vessels */

  async listVessels(user: AuthenticatedUser, query: VesselQueryDto) {
    const where: Prisma.VesselWhereInput = {
      OR: [{ companyId: user.companyId ?? undefined }, { companyId: null }],
      ...(query.type ? { type: query.type as never } : {}),
      ...(query.reportingOnly === 'true'
        ? { lastPositionAt: { gte: new Date(Date.now() - 3_600_000) } }
        : {}),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.vessel.findMany({
        where,
        orderBy: { lastPositionAt: { sort: 'desc', nulls: 'last' } },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.vessel.count({ where }),
    ]);

    return paginated(data, total, query);
  }

  async getVessel(user: AuthenticatedUser, id: string) {
    const vessel = await this.prisma.vessel.findFirst({
      where: {
        id,
        OR: [{ companyId: user.companyId ?? undefined }, { companyId: null }],
      },
      include: {
        voyages: {
          orderBy: { scheduledDepartureAt: 'desc' },
          take: 10,
          include: {
            originPort: true,
            destinationPort: true,
            _count: { select: { shipments: true } },
          },
        },
      },
    });
    if (!vessel) throw new NotFoundException('Navire introuvable');

    return {
      ...vessel,
      // Free deep links to the public trackers. Useful even with a paid feed configured: an
      // operator wanting a second opinion, a photograph of the hull, or the port-call history
      // this system does not store gets it in one click.
      externalLinks: buildExternalLinks(vessel),
      embedUrl: buildEmbedUrl(
        {
          mmsi: vessel.mmsi,
          imoNumber: vessel.imoNumber,
          latitude: vessel.lastLatitude ?? undefined,
          longitude: vessel.lastLongitude ?? undefined,
        },
        this.embedEnabled,
      ),
    };
  }

  /**
   * The vessel's track, downsampled server-side.
   *
   * An ocean crossing at one AIS report a minute is tens of thousands of points. No map needs
   * them and no browser enjoys them.
   */
  async getVesselTrack(user: AuthenticatedUser, id: string, maxPoints = 600) {
    await this.getVessel(user, id);

    const total = await this.prisma.vesselPosition.count({ where: { vesselId: id } });
    const stride = Math.max(1, Math.ceil(total / maxPoints));

    const positions = await this.prisma.$queryRaw<
      Array<{
        latitude: number;
        longitude: number;
        speedKnots: number | null;
        courseDegrees: number | null;
        navStatus: string | null;
        source: string;
        recordedAt: Date;
      }>
    >`
      SELECT latitude, longitude, "speedKnots", "courseDegrees", "navStatus", source, "recordedAt"
        FROM (
          SELECT latitude, longitude, "speedKnots", "courseDegrees", "navStatus", source,
                 "recordedAt", ROW_NUMBER() OVER (ORDER BY "recordedAt") AS rn
            FROM "vessel_positions"
           WHERE "vesselId" = ${id}
        ) numbered
       WHERE rn % ${stride} = 0 OR rn = 1
       ORDER BY "recordedAt"
    `;

    return { vesselId: id, positions, positionsTotal: total, sampledEvery: stride };
  }

  async createVessel(user: AuthenticatedUser, dto: CreateVesselDto) {
    const companyId = requireCompanyId(user);
    if (!dto.imoNumber && !dto.mmsi) {
      throw new BadRequestException(
        'Un navire doit avoir au moins un numéro IMO ou un MMSI : sans l’un des deux, il ne peut être rattaché à aucun flux de positions.',
      );
    }
    return this.prisma.vessel.create({ data: { ...dto, companyId, type: (dto.type ?? 'CONTAINER') as never } });
  }

  /* ====================================================================== ports */

  listPorts(query: PaginationQueryDto) {
    const where: Prisma.PortWhereInput = query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { locode: { startsWith: query.search.toUpperCase() } },
            { country: { equals: query.search.toUpperCase() } },
          ],
        }
      : {};

    return this.prisma.port.findMany({ where, orderBy: { name: 'asc' }, take: query.limit });
  }

  createPort(dto: CreatePortDto) {
    return this.prisma.port.create({ data: { ...dto, locode: dto.locode.toUpperCase() } });
  }

  /* ==================================================================== voyages */

  async listVoyages(user: AuthenticatedUser, query: PaginationQueryDto, status?: string) {
    const where: Prisma.VoyageWhereInput = {
      ...companyFilter(user),
      ...(status ? { status: status as never } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.voyage.findMany({
        where,
        include: {
          vessel: { select: { id: true, name: true, imoNumber: true, mmsi: true, type: true } },
          originPort: { select: { locode: true, name: true, country: true } },
          destinationPort: { select: { locode: true, name: true, country: true } },
          _count: { select: { shipments: true } },
        },
        orderBy: { scheduledDepartureAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.voyage.count({ where }),
    ]);

    return paginated(data, total, query);
  }

  /**
   * Plans a voyage: great-circle track, distance, and a scheduled arrival derived from the
   * vessel's service speed when the caller does not supply one.
   */
  async createVoyage(user: AuthenticatedUser, dto: CreateVoyageDto) {
    const companyId = requireCompanyId(user);

    const [vessel, origin, destination] = await Promise.all([
      this.prisma.vessel.findUnique({ where: { id: dto.vesselId } }),
      this.prisma.port.findUnique({ where: { id: dto.originPortId } }),
      this.prisma.port.findUnique({ where: { id: dto.destinationPortId } }),
    ]);

    if (!vessel) throw new NotFoundException('Navire introuvable');
    if (!origin) throw new NotFoundException('Port de départ introuvable');
    if (!destination) throw new NotFoundException('Port d’arrivée introuvable');
    if (origin.id === destination.id) {
      throw new BadRequestException('Les ports de départ et d’arrivée doivent être différents');
    }

    const from: LatLng = { latitude: origin.latitude, longitude: origin.longitude };
    const to: LatLng = { latitude: destination.latitude, longitude: destination.longitude };

    const distanceNm = greatCircleNauticalMiles(from, to);
    const speedKnots = SERVICE_SPEED_KNOTS[vessel.type] ?? 14;

    const scheduledDepartureAt = new Date(dto.scheduledDepartureAt);
    const scheduledArrivalAt = dto.scheduledArrivalAt
      ? new Date(dto.scheduledArrivalAt)
      : new Date(scheduledDepartureAt.getTime() + (distanceNm / speedKnots) * 3_600_000);

    if (scheduledArrivalAt <= scheduledDepartureAt) {
      throw new BadRequestException('L’arrivée prévue doit être postérieure au départ');
    }

    return this.prisma.voyage.create({
      data: {
        companyId,
        vesselId: dto.vesselId,
        originPortId: dto.originPortId,
        destinationPortId: dto.destinationPortId,
        voyageNumber: dto.voyageNumber,
        status: 'SCHEDULED',
        scheduledDepartureAt,
        scheduledArrivalAt,
        estimatedArrivalAt: scheduledArrivalAt,
        // 64 samples: enough that the drawn track follows the great circle rather than cutting
        // a straight line across a Mercator projection.
        plannedTrack: greatCircleTrack(from, to, 64) as unknown as Prisma.InputJsonValue,
        distanceNm: Math.round(distanceNm * 10) / 10,
        isDemoData: vessel.isDemoData,
      },
      include: { vessel: true, originPort: true, destinationPort: true },
    });
  }

  async getVoyage(user: AuthenticatedUser, id: string) {
    const voyage = await this.prisma.voyage.findFirst({
      where: { id, ...companyFilter(user) },
      include: {
        vessel: true,
        originPort: true,
        destinationPort: true,
        shipments: {
          select: { id: true, trackingNumber: true, status: true, totalUnits: true, cargoValue: true },
        },
      },
    });
    if (!voyage) throw new NotFoundException('Traversée introuvable');

    const progress = this.voyageProgress(voyage);
    return { ...voyage, ...progress };
  }

  /**
   * How far along a voyage is, and when it will arrive.
   *
   * ETA is computed from the *remaining* great-circle distance and the vessel's observed speed
   * over ground, falling back to its class service speed. Using observed speed matters: a ship
   * slow-steaming at 12 knots to save bunker fuel arrives days later than the schedule assumed,
   * and that is exactly the delay a shipper needs to know about a week early rather than on the
   * day.
   */
  private voyageProgress(voyage: {
    vessel: {
      lastLatitude: number | null;
      lastLongitude: number | null;
      lastSpeedKnots: number | null;
      type: string;
    };
    originPort: { latitude: number; longitude: number };
    destinationPort: { latitude: number; longitude: number };
    distanceNm: number | null;
    scheduledArrivalAt: Date;
    status: string;
  }) {
    const { vessel, originPort, destinationPort } = voyage;

    if (vessel.lastLatitude === null || vessel.lastLongitude === null) {
      return {
        progressPercent: 0,
        remainingNm: voyage.distanceNm,
        computedEta: null,
        etaBasis: 'aucune position signalée pour ce navire pour l’instant',
      };
    }

    const current: LatLng = { latitude: vessel.lastLatitude, longitude: vessel.lastLongitude };
    const to: LatLng = { latitude: destinationPort.latitude, longitude: destinationPort.longitude };
    const from: LatLng = { latitude: originPort.latitude, longitude: originPort.longitude };

    const remainingNm = greatCircleNauticalMiles(current, to);
    const coveredNm = greatCircleNauticalMiles(from, current);
    const totalNm = voyage.distanceNm ?? coveredNm + remainingNm;

    // Speed over ground below 1 knot is a stopped ship, not a slow one; using it would produce
    // an ETA measured in years.
    const observed = vessel.lastSpeedKnots ?? 0;
    const usable = observed >= 1;
    const speedKnots = usable ? observed : SERVICE_SPEED_KNOTS[vessel.type] ?? 14;

    const computedEta = new Date(Date.now() + (remainingNm / speedKnots) * 3_600_000);
    const scheduleDeltaHours =
      (computedEta.getTime() - voyage.scheduledArrivalAt.getTime()) / 3_600_000;

    return {
      progressPercent: totalNm > 0 ? Math.min(100, Math.round((coveredNm / totalNm) * 100)) : 0,
      remainingNm: Math.round(remainingNm * 10) / 10,
      coveredNm: Math.round(coveredNm * 10) / 10,
      speedKnots: Math.round(speedKnots * 10) / 10,
      computedEta,
      scheduleDeltaHours: Math.round(scheduleDeltaHours * 10) / 10,
      isBehindSchedule: scheduleDeltaHours > 6,
      etaBasis: usable
        ? `${remainingNm.toFixed(0)} nm restants à la vitesse observée du navire, ${speedKnots.toFixed(1)} nœuds`
        : `${remainingNm.toFixed(0)} nm restants à la vitesse de service d’un navire ${vessel.type} (${speedKnots} nœuds) : le navire ne fait actuellement pas route`,
    };
  }

  /* =================================================================== positions */

  /**
   * Records a position and keeps everything derived from it in step.
   *
   * Shared by the AIS listener, the simulator and the manual endpoint, so all three land in the
   * same place with the same side effects — and the `source` column keeps them distinguishable
   * forever.
   */
  async recordFix(fix: VesselFix): Promise<{ vesselId: string; matched: boolean }> {
    const vessel = await this.prisma.vessel.findFirst({
      where: {
        OR: [
          ...(fix.mmsi ? [{ mmsi: fix.mmsi }] : []),
          ...(fix.imoNumber ? [{ imoNumber: fix.imoNumber }] : []),
        ],
      },
    });

    // An unknown MMSI on a public feed is normal — there are ~100 000 vessels at sea and this
    // company cares about a handful. Dropping it is correct; creating a row for every ship that
    // sails through the bounding box is not.
    if (!vessel) return { vesselId: '', matched: false };

    const active = await this.prisma.voyage.findFirst({
      where: {
        vesselId: vessel.id,
        status: { in: ['LOADING', 'AT_SEA', 'APPROACHING', 'BERTHED', 'DISCHARGING'] },
      },
      orderBy: { scheduledDepartureAt: 'desc' },
      include: { destinationPort: true },
    });

    await this.prisma.vesselPosition.create({
      data: {
        vesselId: vessel.id,
        voyageId: active?.id ?? null,
        latitude: fix.latitude,
        longitude: fix.longitude,
        speedKnots: fix.speedKnots,
        courseDegrees: fix.courseDegrees,
        headingDegrees: fix.headingDegrees,
        draughtM: fix.draughtM,
        navStatus: fix.navStatus,
        source: fix.source,
        recordedAt: fix.recordedAt,
      },
    });

    // Only ever move the denormalised position forward in time, so a late-arriving batch of
    // buffered reports cannot drag the live map backwards.
    await this.prisma.vessel.updateMany({
      where: {
        id: vessel.id,
        OR: [{ lastPositionAt: null }, { lastPositionAt: { lt: fix.recordedAt } }],
      },
      data: {
        lastLatitude: fix.latitude,
        lastLongitude: fix.longitude,
        lastSpeedKnots: fix.speedKnots,
        lastCourseDegrees: fix.courseDegrees,
        lastHeadingDegrees: fix.headingDegrees,
        lastDraughtM: fix.draughtM,
        lastPositionAt: fix.recordedAt,
        positionSource: fix.source,
        status: (fix.navStatus === 'UNDERWAY'
          ? 'UNDERWAY'
          : fix.navStatus === 'AT_ANCHOR'
            ? 'AT_ANCHOR'
            : fix.navStatus === 'MOORED'
              ? 'MOORED'
              : 'UNKNOWN') as never,
      },
    });

    if (active) {
      await this.advanceVoyage(active, fix);
    }

    if (vessel.companyId) {
      this.gateway.emitVesselPosition(vessel.companyId, {
        vesselId: vessel.id,
        name: vessel.name,
        imoNumber: vessel.imoNumber,
        mmsi: vessel.mmsi,
        voyageId: active?.id ?? null,
        latitude: fix.latitude,
        longitude: fix.longitude,
        speedKnots: fix.speedKnots,
        courseDegrees: fix.courseDegrees,
        recordedAt: fix.recordedAt.toISOString(),
        source: fix.source,
      });
    }

    return { vesselId: vessel.id, matched: true };
  }

  /** Moves a voyage through its statuses based on distance to the destination. */
  private async advanceVoyage(
    voyage: { id: string; status: string; destinationPort: { latitude: number; longitude: number } },
    fix: VesselFix,
  ): Promise<void> {
    const remainingNm = greatCircleNauticalMiles(
      { latitude: fix.latitude, longitude: fix.longitude },
      { latitude: voyage.destinationPort.latitude, longitude: voyage.destinationPort.longitude },
    );

    let next = voyage.status;
    if (remainingNm <= BERTHED_NM) next = 'BERTHED';
    else if (remainingNm <= APPROACHING_NM) next = 'APPROACHING';
    else if (voyage.status === 'SCHEDULED' || voyage.status === 'LOADING') next = 'AT_SEA';

    const data: Prisma.VoyageUpdateInput = {};
    if (next !== voyage.status) {
      data.status = next as never;
      if (next === 'AT_SEA') data.actualDepartureAt = fix.recordedAt;
      if (next === 'BERTHED') data.actualArrivalAt = fix.recordedAt;
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.voyage.update({ where: { id: voyage.id }, data });
    }
  }

  async reportPosition(user: AuthenticatedUser, vesselId: string, dto: ReportVesselPositionDto) {
    const vessel = await this.getVessel(user, vesselId);
    if (!vessel.mmsi && !vessel.imoNumber) {
      throw new BadRequestException('Ce navire n’a ni MMSI ni numéro IMO auquel rattacher une position');
    }

    return this.recordFix({
      mmsi: vessel.mmsi ?? '',
      imoNumber: vessel.imoNumber,
      latitude: dto.latitude,
      longitude: dto.longitude,
      speedKnots: dto.speedKnots ?? null,
      courseDegrees: dto.courseDegrees ?? null,
      headingDegrees: dto.courseDegrees ?? null,
      draughtM: dto.draughtM ?? null,
      navStatus: (dto.speedKnots ?? 0) > 0.5 ? 'UNDERWAY' : 'MOORED',
      recordedAt: dto.recordedAt ? new Date(dto.recordedAt) : new Date(),
      source: 'MANUAL',
    });
  }

  /* ======================================================================= map */

  /** Everything to draw on the maritime map in one query. */
  async fleetSnapshot(user: AuthenticatedUser) {
    const vessels = await this.prisma.vessel.findMany({
      where: {
        OR: [{ companyId: user.companyId ?? undefined }, { companyId: null }],
        lastPositionAt: { not: null },
      },
      include: {
        voyages: {
          where: { status: { in: ['LOADING', 'AT_SEA', 'APPROACHING', 'BERTHED', 'DISCHARGING'] } },
          orderBy: { scheduledDepartureAt: 'desc' },
          take: 1,
          include: {
            originPort: { select: { locode: true, name: true } },
            destinationPort: { select: { locode: true, name: true, latitude: true, longitude: true } },
          },
        },
      },
      take: 500,
    });

    return vessels.map((vessel) => {
      const voyage = vessel.voyages[0];
      const remainingNm =
        voyage && vessel.lastLatitude !== null && vessel.lastLongitude !== null
          ? greatCircleNauticalMiles(
              { latitude: vessel.lastLatitude, longitude: vessel.lastLongitude },
              {
                latitude: voyage.destinationPort.latitude,
                longitude: voyage.destinationPort.longitude,
              },
            )
          : null;

      return {
        vesselId: vessel.id,
        name: vessel.name,
        imoNumber: vessel.imoNumber,
        mmsi: vessel.mmsi,
        type: vessel.type,
        flag: vessel.flag,
        status: vessel.status,
        latitude: vessel.lastLatitude!,
        longitude: vessel.lastLongitude!,
        speedKnots: vessel.lastSpeedKnots,
        courseDegrees: vessel.lastCourseDegrees,
        lastPositionAt: vessel.lastPositionAt,
        positionSource: vessel.positionSource,
        isDemoData: vessel.isDemoData,
        isOwnFleet: vessel.companyId !== null,
        externalLinks: buildExternalLinks(vessel),
        voyage: voyage
          ? {
              id: voyage.id,
              voyageNumber: voyage.voyageNumber,
              status: voyage.status,
              from: voyage.originPort.name,
              to: voyage.destinationPort.name,
              toLocode: voyage.destinationPort.locode,
              estimatedArrivalAt: voyage.estimatedArrivalAt,
              plannedTrack: voyage.plannedTrack,
              remainingNm: remainingNm === null ? null : Math.round(remainingNm),
            }
          : null,
      };
    });
  }

  async ports() {
    return this.prisma.port.findMany({ orderBy: { name: 'asc' } });
  }
}
