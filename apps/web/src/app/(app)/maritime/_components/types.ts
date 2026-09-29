/* API shapes for the maritime screen (`/maritime/*`). */

export interface VesselPositionSummary {
  latitude: number;
  longitude: number;
  speedKnots: number | null;
  courseDegrees: number | null;
  recordedAt: string | null;
  source: string | null;
  ageMinutes: number | null;
}

export interface SearchResult {
  id: string;
  name: string;
  formerNames: string[];
  imoNumber: string | null;
  mmsi: string | null;
  callSign: string | null;
  type: string;
  flag: string | null;
  status: string;
  operator: string | null;
  capacityTeu: number | null;
  matchScore: number;
  isOwnFleet: boolean;
  isDemoData: boolean;
  position: VesselPositionSummary | null;
  currentVoyage: {
    id: string;
    voyageNumber: string;
    status: string;
    from: { locode: string; name: string };
    to: { locode: string; name: string };
    estimatedArrivalAt: string | null;
  } | null;
}

export interface SearchResponse {
  query: string;
  interpretedAs: string;
  count: number;
  results: SearchResult[];
}

export interface FleetVessel {
  vesselId: string;
  name: string;
  imoNumber: string | null;
  mmsi: string | null;
  type: string;
  flag: string | null;
  status: string;
  latitude: number;
  longitude: number;
  speedKnots: number | null;
  courseDegrees: number | null;
  lastPositionAt: string;
  positionSource: string | null;
  isDemoData: boolean;
  isOwnFleet: boolean;
  externalLinks: {
    marineTraffic: string | null;
    vesselFinder: string | null;
    identifierUsed: 'IMO' | 'MMSI' | 'NAME' | null;
  } | null;
  voyage: {
    id: string;
    voyageNumber: string;
    status: string;
    from: string;
    to: string;
    toLocode: string;
    estimatedArrivalAt: string | null;
    plannedTrack: Array<{ latitude: number; longitude: number }> | null;
    remainingNm: number | null;
  } | null;
}

export interface VoyageDetail {
  id: string;
  voyageNumber: string;
  status: string;
  scheduledDepartureAt: string;
  scheduledArrivalAt: string;
  estimatedArrivalAt: string | null;
  distanceNm: number | null;
  plannedTrack: Array<{ latitude: number; longitude: number }> | null;
  vessel: { id: string; name: string; imoNumber: string | null; type: string };
  originPort: { locode: string; name: string; country: string; latitude: number; longitude: number };
  destinationPort: { locode: string; name: string; country: string; latitude: number; longitude: number };
  progressPercent: number;
  remainingNm: number | null;
  coveredNm?: number;
  speedKnots?: number;
  computedEta: string | null;
  scheduleDeltaHours?: number;
  isBehindSchedule?: boolean;
  etaBasis: string;
  shipments: Array<{ id: string; trackingNumber: string; status: string }>;
}

export interface TrackResponse {
  positions: Array<{
    latitude: number;
    longitude: number;
    speedKnots: number | null;
    recordedAt: string;
    source: string;
  }>;
  positionsTotal: number;
  sampledEvery: number;
}

export interface MaritimeStatus {
  source: string;
  isLive: boolean;
  detail: string;
  fixesRecorded: number;
  fixesForUntrackedVessels: number;
  howToGoLive: string | null;
}

/** Row of `GET /maritime/voyages` — only what the page reads to compute schedule deltas. */
export interface VoyageListRow {
  id: string;
  status: string;
  scheduledArrivalAt: string;
  estimatedArrivalAt: string | null;
}
