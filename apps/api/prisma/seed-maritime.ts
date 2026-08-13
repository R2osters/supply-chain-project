/**
 * Maritime DEMO DATA: ports, vessels and voyages.
 *
 * Ports are real, with real UN/LOCODEs and real coordinates, because a demo that puts Rotterdam
 * in the wrong place teaches the user a wrong thing and breaks every distance calculation.
 *
 * Vessels are **fictional**. Their names, IMO numbers and MMSIs are format-valid but deliberately
 * not those of real ships: putting a real IMO on a synthetic vessel would mean that the moment
 * somebody sets `AISSTREAM_API_KEY`, live broadcasts from an actual hull would start merging into
 * a made-up voyage. Fictional identifiers simply never match, which is the correct failure.
 *
 * IMO check digits are computed properly (weights 7…2, mod 10), so the numbers validate against
 * the real algorithm — the format is honest even though the ship is not.
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { greatCircleNauticalMiles, greatCircleTrack, type LatLng } from '@scip/shared';

/** Real ports, real coordinates. The West Africa ↔ Europe/Asia trade the demo company runs. */
export const PORTS = [
  { locode: 'GHTEM', name: 'Tema', country: 'GH', latitude: 5.6304, longitude: 0.0169 },
  { locode: 'GHTKD', name: 'Takoradi', country: 'GH', latitude: 4.8845, longitude: -1.7554 },
  { locode: 'CIABJ', name: 'Abidjan', country: 'CI', latitude: 5.2758, longitude: -4.0092 },
  { locode: 'NGLOS', name: 'Lagos (Apapa)', country: 'NG', latitude: 6.4415, longitude: 3.3708 },
  { locode: 'SNDKR', name: 'Dakar', country: 'SN', latitude: 14.6802, longitude: -17.4188 },
  { locode: 'MACAS', name: 'Casablanca', country: 'MA', latitude: 33.6008, longitude: -7.6167 },
  { locode: 'ESALG', name: 'Algeciras', country: 'ES', latitude: 36.1275, longitude: -5.4361 },
  { locode: 'NLRTM', name: 'Rotterdam', country: 'NL', latitude: 51.9494, longitude: 4.1372 },
  { locode: 'BEANR', name: 'Antwerp', country: 'BE', latitude: 51.2603, longitude: 4.3947 },
  { locode: 'FRLEH', name: 'Le Havre', country: 'FR', latitude: 49.4831, longitude: 0.1064 },
  { locode: 'GBFXT', name: 'Felixstowe', country: 'GB', latitude: 51.9539, longitude: 1.3211 },
  { locode: 'DEHAM', name: 'Hamburg', country: 'DE', latitude: 53.5403, longitude: 9.9314 },
  { locode: 'CNSHA', name: 'Shanghai', country: 'CN', latitude: 31.2304, longitude: 121.4737 },
  { locode: 'SGSIN', name: 'Singapore', country: 'SG', latitude: 1.2644, longitude: 103.8223 },
  { locode: 'AEJEA', name: 'Jebel Ali', country: 'AE', latitude: 25.0111, longitude: 55.0614 },
  { locode: 'BRSSZ', name: 'Santos', country: 'BR', latitude: -23.9819, longitude: -46.2994 },
  { locode: 'USNYC', name: 'New York', country: 'US', latitude: 40.6688, longitude: -74.0451 },
  { locode: 'ZADUR', name: 'Durban', country: 'ZA', latitude: -29.8679, longitude: 31.0292 },
] as const;

/**
 * Computes the IMO check digit: multiply the six digits by weights 7,6,5,4,3,2 and take the sum
 * modulo 10. A number that fails this is not an IMO number, and anything reading these should be
 * able to prove they are well formed.
 */
function imoWithCheckDigit(sixDigits: string): string {
  const weights = [7, 6, 5, 4, 3, 2];
  const sum = sixDigits
    .split('')
    .reduce((total, digit, index) => total + Number(digit) * weights[index], 0);
  return `${sixDigits}${sum % 10}`;
}

/** Fictional vessels on plausible West Africa services. */
const VESSELS = [
  { name: 'Gulf Sentinel',     imo6: '941201', mmsi: '636019001', type: 'CONTAINER',     flag: 'LR', teu: 4600, operator: 'Atlantic Gulf Lines' },
  { name: 'Volta Trader',      imo6: '941202', mmsi: '636019002', type: 'CONTAINER',     flag: 'PA', teu: 2800, operator: 'Atlantic Gulf Lines' },
  { name: 'Accra Star',        imo6: '941203', mmsi: '636019003', type: 'FEEDER',        flag: 'GH', teu: 1100, operator: 'Gold Coast Feeder Co' },
  { name: 'Sahel Carrier',     imo6: '941204', mmsi: '636019004', type: 'BULK_CARRIER',  flag: 'MT', dwt: 58000, operator: 'Sahel Bulk' },
  { name: 'Benguela Reefer',   imo6: '941205', mmsi: '636019005', type: 'REEFER',        flag: 'PA', teu: 900,  operator: 'Cold Atlantic' },
  { name: 'Ashanti Bridge',    imo6: '941206', mmsi: '636019006', type: 'CONTAINER',     flag: 'SG', teu: 8200, operator: 'Ashanti Maritime' },
  { name: 'Kwame Endeavour',   imo6: '941207', mmsi: '636019007', type: 'GENERAL_CARGO', flag: 'GH', dwt: 21000, operator: 'Ashanti Maritime' },
  { name: 'Atlantic Meridian', imo6: '941208', mmsi: '636019008', type: 'CONTAINER',     flag: 'LR', teu: 11000, operator: 'Meridian Container Line' },
] as const;

/** Services the demo runs. Each becomes a voyage at a different point in its passage. */
const SERVICES = [
  { vessel: 'Gulf Sentinel',     from: 'GHTEM', to: 'NLRTM', voyage: '084W', elapsedFraction: 0.42 },
  { vessel: 'Volta Trader',      from: 'CIABJ', to: 'ESALG', voyage: '112N', elapsedFraction: 0.68 },
  { vessel: 'Accra Star',        from: 'GHTKD', to: 'NGLOS', voyage: '221E', elapsedFraction: 0.31 },
  { vessel: 'Sahel Carrier',     from: 'SNDKR', to: 'BRSSZ', voyage: '019S', elapsedFraction: 0.15 },
  { vessel: 'Benguela Reefer',   from: 'GHTEM', to: 'GBFXT', voyage: '077N', elapsedFraction: 0.55 },
  { vessel: 'Ashanti Bridge',    from: 'CNSHA', to: 'GHTEM', voyage: '308W', elapsedFraction: 0.73 },
  { vessel: 'Kwame Endeavour',   from: 'MACAS', to: 'GHTEM', voyage: '045S', elapsedFraction: 0.88 },
  { vessel: 'Atlantic Meridian', from: 'SGSIN', to: 'BEANR', voyage: '512W', elapsedFraction: 0.24 },
] as const;

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

export async function seedMaritime(
  prisma: PrismaClient,
  companyId: string,
  isDemoData = true,
): Promise<{ ports: number; vessels: number; voyages: number; positions: number }> {
  /* ------------------------------------------------------------------ ports */

  const ports = new Map<string, { id: string; latitude: number; longitude: number }>();
  for (const port of PORTS) {
    const row = await prisma.port.upsert({
      where: { locode: port.locode },
      create: { ...port, isDemoData },
      update: {},
    });
    ports.set(port.locode, { id: row.id, latitude: row.latitude, longitude: row.longitude });
  }

  /* ---------------------------------------------------------------- vessels */

  const vessels = new Map<string, { id: string; type: string }>();
  for (const vessel of VESSELS) {
    const row = await prisma.vessel.upsert({
      where: { imoNumber: imoWithCheckDigit(vessel.imo6) },
      create: {
        companyId,
        name: vessel.name,
        imoNumber: imoWithCheckDigit(vessel.imo6),
        mmsi: vessel.mmsi,
        callSign: `9H${vessel.mmsi.slice(-4)}`,
        type: vessel.type as never,
        flag: vessel.flag,
        capacityTeu: 'teu' in vessel ? vessel.teu : null,
        deadweightTonnes: 'dwt' in vessel ? vessel.dwt : null,
        operator: vessel.operator,
        builtYear: 2008 + (Number(vessel.imo6.slice(-2)) % 15),
        lengthM: 'teu' in vessel ? 150 + vessel.teu / 40 : 180,
        beamM: 'teu' in vessel ? 22 + vessel.teu / 900 : 28,
        isDemoData,
        isTracked: true,
      },
      update: {},
    });
    vessels.set(vessel.name, { id: row.id, type: row.type });
  }

  /* ---------------------------------------------------------------- voyages */

  let positionCount = 0;

  for (const service of SERVICES) {
    const vessel = vessels.get(service.vessel)!;
    const origin = ports.get(service.from)!;
    const destination = ports.get(service.to)!;

    const from: LatLng = { latitude: origin.latitude, longitude: origin.longitude };
    const to: LatLng = { latitude: destination.latitude, longitude: destination.longitude };

    const distanceNm = greatCircleNauticalMiles(from, to);
    const speedKnots = SERVICE_SPEED_KNOTS[vessel.type] ?? 14;
    const passageHours = distanceNm / speedKnots;

    // Depart in the past by exactly the elapsed fraction of the passage, so the vessel sits
    // where the simulator's clock-derived progress expects it to be. Anything else would make
    // the ship jump on the first tick.
    const departedHoursAgo = passageHours * service.elapsedFraction;
    const scheduledDepartureAt = new Date(Date.now() - departedHoursAgo * 3_600_000);
    const scheduledArrivalAt = new Date(scheduledDepartureAt.getTime() + passageHours * 3_600_000);

    const track = greatCircleTrack(from, to, 64);

    const existing = await prisma.voyage.findFirst({
      where: { vesselId: vessel.id, voyageNumber: service.voyage },
    });
    if (existing) continue;

    const voyage = await prisma.voyage.create({
      data: {
        companyId,
        vesselId: vessel.id,
        originPortId: origin.id,
        destinationPortId: destination.id,
        voyageNumber: service.voyage,
        status: service.elapsedFraction > 0.95 ? 'APPROACHING' : 'AT_SEA',
        scheduledDepartureAt,
        actualDepartureAt: scheduledDepartureAt,
        scheduledArrivalAt,
        estimatedArrivalAt: scheduledArrivalAt,
        plannedTrack: track as unknown as Prisma.InputJsonValue,
        distanceNm: Math.round(distanceNm * 10) / 10,
        travelledNm: Math.round(distanceNm * service.elapsedFraction * 10) / 10,
        isDemoData,
      },
    });

    // A short trail behind each ship, so the track is visible the moment the map opens rather
    // than only after the simulator has run for a while.
    const trailPoints = 24;
    for (let i = 0; i <= trailPoints; i += 1) {
      const fractionAlong = (service.elapsedFraction * i) / trailPoints;
      const index = Math.min(track.length - 1, Math.round(fractionAlong * (track.length - 1)));
      const point = track[index];
      const recordedAt = new Date(
        scheduledDepartureAt.getTime() + fractionAlong * passageHours * 3_600_000,
      );

      await prisma.vesselPosition.create({
        data: {
          vesselId: vessel.id,
          voyageId: voyage.id,
          latitude: point.latitude,
          longitude: point.longitude,
          speedKnots: Math.round(speedKnots * (0.9 + Math.random() * 0.2) * 10) / 10,
          courseDegrees: Math.round(Math.random() * 360),
          headingDegrees: null,
          navStatus: 'UNDERWAY',
          source: 'SIMULATOR',
          recordedAt,
        },
      });
      positionCount += 1;
    }

    const latest = track[
      Math.min(track.length - 1, Math.round(service.elapsedFraction * (track.length - 1)))
    ];
    await prisma.vessel.update({
      where: { id: vessel.id },
      data: {
        lastLatitude: latest.latitude,
        lastLongitude: latest.longitude,
        lastSpeedKnots: Math.round(speedKnots * 10) / 10,
        lastCourseDegrees: Math.round(Math.random() * 360),
        lastPositionAt: new Date(),
        positionSource: 'SIMULATOR',
        status: 'UNDERWAY',
      },
    });
  }

  return {
    ports: PORTS.length,
    vessels: VESSELS.length,
    voyages: SERVICES.length,
    positions: positionCount,
  };
}
