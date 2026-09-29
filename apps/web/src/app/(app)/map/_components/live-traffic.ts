import type maplibregl from 'maplibre-gl';
import type { Palette } from '@/lib/theme';

/**
 * Live air and sea traffic on the fleet map: aircraft from ADS-B (OpenSky / adsb.lol) and
 * vessels from AIS, both fetched by the API for the visible bounding box.
 *
 * Same approach as the situation map's layers: one GeoJSON source per feed and a symbol layer on
 * the GPU, not one DOM marker per aircraft — a regional view can hold several hundred of them.
 * The converters and formatters are pure so what reaches the map is testable without a browser.
 */

/* --------------------------------------------------------------------- contract */

export type AircraftSource = 'opensky' | 'adsb.lol' | 'none';

export interface Aircraft {
  /** ICAO 24-bit address, hex. */
  id: string;
  callsign: string | null;
  registration: string | null;
  type: string | null;
  latitude: number;
  longitude: number;
  altitudeM: number | null;
  speedKts: number | null;
  trackDeg: number | null;
  verticalRateMs: number | null;
  onGround: boolean;
  originCountry: string | null;
}

export interface AircraftResponse {
  source: AircraftSource;
  authenticated: boolean;
  stale: boolean;
  fetchedAt: string;
  attribution: string;
  aircraft: Aircraft[];
}

export interface Vessel {
  mmsi: string;
  name: string | null;
  latitude: number;
  longitude: number;
  speedKnots: number | null;
  courseDegrees: number | null;
  headingDegrees: number | null;
  navStatus: string | null;
  destination: string | null;
  /** A vessel SCIP follows for a voyage, not just one passing through the view. */
  tracked: boolean;
  lastSeenAt: string;
}

export interface VesselsResponse {
  source: string;
  isLive: boolean;
  howToGoLive: string | null;
  fetchedAt: string;
  vessels: Vessel[];
}

/* ------------------------------------------------------------------------- bbox */

export interface Bbox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** The subset of `LngLatBounds` the conversion needs, so tests can pass a plain object. */
export interface BoundsLike {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
/** Two decimals (~1 km): small pans reuse the same query key instead of refetching. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Map bounds → the API's bbox. Zoomed far out, MapLibre reports longitudes past ±180 (the world
 * repeats); the API wants a real box, so a view wider than the world becomes the whole world and
 * everything else is clamped. Latitude stops at ±85, where Web Mercator does.
 */
export function bboxFromBounds(bounds: BoundsLike): Bbox {
  const west = bounds.getWest();
  const east = bounds.getEast();
  const wraps = east - west >= 360;
  // Rounding outward keeps the requested box a superset of what is on screen.
  return {
    minLat: clamp(Math.floor(bounds.getSouth() * 100) / 100, -85, 85),
    maxLat: clamp(Math.ceil(bounds.getNorth() * 100) / 100, -85, 85),
    minLon: wraps ? -180 : clamp(Math.floor(west * 100) / 100, -180, 180),
    maxLon: wraps ? 180 : clamp(Math.ceil(east * 100) / 100, -180, 180),
  };
}

export function bboxQuery(bbox: Bbox): string {
  const params = new URLSearchParams({
    minLat: String(round2(bbox.minLat)),
    minLon: String(round2(bbox.minLon)),
    maxLat: String(round2(bbox.maxLat)),
    maxLon: String(round2(bbox.maxLon)),
  });
  return params.toString();
}

/* ---------------------------------------------------------------------- geojson */

type FeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Point, Record<string, unknown>>;

export const LIVE_SOURCE = {
  aircraft: 'live-aircraft',
  vessels: 'live-vessels',
} as const;

export const LIVE_ICON = {
  aircraft: 'live-icon-aircraft',
  aircraftGround: 'live-icon-aircraft-ground',
  vessel: 'live-icon-vessel',
  vesselTracked: 'live-icon-vessel-tracked',
  vesselIdle: 'live-icon-vessel-idle',
} as const;

export const EMPTY_COLLECTION: FeatureCollection = { type: 'FeatureCollection', features: [] };

function validPosition(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

/** Heading in [0, 360), or null when the feed has none. */
export function normaliseBearing(degrees: number | null | undefined): number | null {
  if (degrees === null || degrees === undefined || !Number.isFinite(degrees)) return null;
  return ((degrees % 360) + 360) % 360;
}

export function aircraftToGeoJson(aircraft: Aircraft[], selectedId: string | null = null): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: aircraft
      .filter((plane) => validPosition(plane.latitude, plane.longitude))
      .map((plane) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [plane.longitude, plane.latitude] },
        properties: {
          id: plane.id,
          icon: plane.onGround ? LIVE_ICON.aircraftGround : LIVE_ICON.aircraft,
          rotation: normaliseBearing(plane.trackDeg) ?? 0,
          selected: plane.id === selectedId,
          // Higher planes drawn on top: the one you see is the one overflying.
          sortKey: plane.altitudeM ?? 0,
        },
      })),
  };
}

/** AIS reports 511 for "no heading" and 360 for "no course"; both mean unknown. */
function aisBearing(value: number | null): number | null {
  if (value === null || value >= 360) return null;
  return normaliseBearing(value);
}

export function vesselBearing(vessel: Pick<Vessel, 'headingDegrees' | 'courseDegrees'>): number | null {
  // Heading is where the bow points; course is where it goes. The hull icon shows the bow.
  return aisBearing(vessel.headingDegrees) ?? aisBearing(vessel.courseDegrees);
}

/** Under half a knot a ship is moored or at anchor: a neutral mark, no direction implied. */
export function vesselIsUnderway(vessel: Pick<Vessel, 'speedKnots'>): boolean {
  return vessel.speedKnots !== null && vessel.speedKnots >= 0.5;
}

export function vesselsToGeoJson(vessels: Vessel[], selectedId: string | null = null): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: vessels
      .filter((vessel) => validPosition(vessel.latitude, vessel.longitude))
      .map((vessel) => {
        const bearing = vesselBearing(vessel);
        const underway = vesselIsUnderway(vessel) && bearing !== null;
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [vessel.longitude, vessel.latitude] },
          properties: {
            id: vessel.mmsi,
            icon: vessel.tracked
              ? LIVE_ICON.vesselTracked
              : underway
                ? LIVE_ICON.vessel
                : LIVE_ICON.vesselIdle,
            rotation: bearing ?? 0,
            selected: vessel.mmsi === selectedId,
            sortKey: vessel.tracked ? 1 : 0,
          },
        };
      }),
  };
}

/* ---------------------------------------------------------------- dead reckoning */

const EARTH_RADIUS_M = 6_371_000;
const KNOT_MS = 0.514444;

/**
 * Where something moving at `speedKts` on `trackDeg` is `seconds` later (great-circle).
 * Used to glide aircraft between two polls; the next fix always wins over the estimate.
 */
export function extrapolate(
  latitude: number,
  longitude: number,
  speedKts: number | null,
  trackDeg: number | null,
  seconds: number,
): { latitude: number; longitude: number } {
  if (!speedKts || trackDeg === null || seconds <= 0) return { latitude, longitude };
  const distance = speedKts * KNOT_MS * seconds;
  const angular = distance / EARTH_RADIUS_M;
  const bearing = (trackDeg * Math.PI) / 180;
  const lat1 = (latitude * Math.PI) / 180;
  const lon1 = (longitude * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );
  const wrapped = ((((lon2 * 180) / Math.PI + 540) % 360) + 360) % 360 - 180;
  return { latitude: (lat2 * 180) / Math.PI, longitude: wrapped };
}

/** Longest glide past a fix: beyond this an estimate is a guess, so the plane waits for data. */
export const MAX_EXTRAPOLATION_S = 45;

/** Every airborne aircraft moved forward by `seconds` since the fix; parked ones stay put. */
export function extrapolateAircraft(aircraft: Aircraft[], seconds: number): Aircraft[] {
  const span = Math.min(Math.max(0, seconds), MAX_EXTRAPOLATION_S);
  if (span === 0) return aircraft;
  return aircraft.map((plane) => {
    if (plane.onGround) return plane;
    const next = extrapolate(plane.latitude, plane.longitude, plane.speedKts, plane.trackDeg, span);
    return { ...plane, ...next };
  });
}

/* ------------------------------------------------------------------- formatting */

export const FEET_PER_METRE = 3.28084;

export function formatAltitude(altitudeM: number | null, onGround: boolean, locale: string): string | null {
  if (onGround) return null;
  if (altitudeM === null || !Number.isFinite(altitudeM)) return '—';
  const feet = Math.round((altitudeM * FEET_PER_METRE) / 100) * 100;
  const metres = Math.round(altitudeM);
  return `${feet.toLocaleString(locale)} ft · ${metres.toLocaleString(locale)} m`;
}

export function formatKnots(knots: number | null, locale: string): string {
  if (knots === null || !Number.isFinite(knots)) return '—';
  return `${Math.round(knots).toLocaleString(locale)} kn`;
}

export function formatBearing(degrees: number | null): string {
  const value = normaliseBearing(degrees);
  return value === null ? '—' : `${String(Math.round(value) % 360).padStart(3, '0')}°`;
}

/** Climb / descent in ft/min, the unit a pilot reads; level flight (< 64 ft/min) is null. */
export function formatVerticalRate(rateMs: number | null, locale: string): string | null {
  if (rateMs === null || !Number.isFinite(rateMs)) return null;
  const feetPerMinute = Math.round((rateMs * FEET_PER_METRE * 60) / 50) * 50;
  if (Math.abs(feetPerMinute) < 64) return null;
  return `${feetPerMinute > 0 ? '↑' : '↓'} ${Math.abs(feetPerMinute).toLocaleString(locale)} ft/min`;
}

/** The label a card leads with: callsign, else registration, else the ICAO address. */
export function aircraftTitle(plane: Pick<Aircraft, 'callsign' | 'registration' | 'id'>): string {
  return plane.callsign?.trim() || plane.registration?.trim() || plane.id.toUpperCase();
}

export function vesselTitle(vessel: Pick<Vessel, 'name' | 'mmsi'>): string {
  return vessel.name?.trim() || `MMSI ${vessel.mmsi}`;
}

/** Human name of the feed, for the credit line. The API's own attribution text wins when present. */
export function aircraftSourceLabel(response: Pick<AircraftResponse, 'source' | 'attribution'>): string {
  if (response.attribution.trim()) return response.attribution.trim();
  if (response.source === 'opensky') return 'OpenSky Network';
  if (response.source === 'adsb.lol') return 'adsb.lol (ODbL)';
  return '';
}

export function vesselSourceLabel(source: string): string {
  const lower = source.toLowerCase();
  if (lower.includes('aisstream')) return 'AISStream';
  if (lower.includes('marinetraffic')) return 'MarineTraffic';
  return source;
}

/* ----------------------------------------------------------------------- layers */

export const LIVE_LAYERS = [LIVE_SOURCE.aircraft, LIVE_SOURCE.vessels] as const;

/** Adds both sources and symbol layers once, empty and hidden, below `beforeId` if given. */
export function installLiveLayers(map: maplibregl.Map, beforeId?: string): void {
  const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  for (const id of LIVE_LAYERS) {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY_COLLECTION });
  }
  // Ships under planes: a plane crossing a port must stay clickable.
  if (!map.getLayer(LIVE_SOURCE.vessels)) {
    map.addLayer(
      {
        id: LIVE_SOURCE.vessels,
        type: 'symbol',
        source: LIVE_SOURCE.vessels,
        layout: {
          visibility: 'none',
          'icon-image': ['get', 'icon'],
          'icon-rotate': ['get', 'rotation'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'symbol-sort-key': ['get', 'sortKey'],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 8, 0.85, 12, 1.1],
        },
        paint: { 'icon-opacity': ['case', ['get', 'selected'], 1, 0.92] },
      },
      before,
    );
  }
  if (!map.getLayer(LIVE_SOURCE.aircraft)) {
    map.addLayer(
      {
        id: LIVE_SOURCE.aircraft,
        type: 'symbol',
        source: LIVE_SOURCE.aircraft,
        layout: {
          visibility: 'none',
          'icon-image': ['get', 'icon'],
          'icon-rotate': ['get', 'rotation'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'symbol-sort-key': ['get', 'sortKey'],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.65, 8, 0.9, 12, 1.15],
        },
        paint: { 'icon-opacity': ['case', ['get', 'selected'], 1, 0.95] },
      },
      before,
    );
  }
}

/* ------------------------------------------------------------------------ icons */

const ICON_PX = 44; // 22 css px on a 2× sprite

type Draw = (context: CanvasRenderingContext2D) => void;

/** A plane seen from above, nose up, on a 24-unit grid. */
const drawPlane: Draw = (context) => {
  context.beginPath();
  context.moveTo(12, 1.5);
  context.bezierCurveTo(13.1, 1.5, 13.4, 3, 13.4, 4.5);
  context.lineTo(13.4, 9);
  context.lineTo(21.5, 13.6);
  context.lineTo(21.5, 15.6);
  context.lineTo(13.4, 13.1);
  context.lineTo(13.1, 18.4);
  context.lineTo(15.6, 20.3);
  context.lineTo(15.6, 22);
  context.lineTo(12, 21);
  context.lineTo(8.4, 22);
  context.lineTo(8.4, 20.3);
  context.lineTo(10.9, 18.4);
  context.lineTo(10.6, 13.1);
  context.lineTo(2.5, 15.6);
  context.lineTo(2.5, 13.6);
  context.lineTo(10.6, 9);
  context.lineTo(10.6, 4.5);
  context.bezierCurveTo(10.6, 3, 10.9, 1.5, 12, 1.5);
  context.closePath();
};

/** A hull from above, bow up. */
const drawHull: Draw = (context) => {
  context.beginPath();
  context.moveTo(12, 2);
  context.bezierCurveTo(15, 5.5, 15.6, 9, 15.6, 12);
  context.lineTo(15.6, 20.5);
  context.bezierCurveTo(15.6, 21.4, 15, 22, 14.1, 22);
  context.lineTo(9.9, 22);
  context.bezierCurveTo(9, 22, 8.4, 21.4, 8.4, 20.5);
  context.lineTo(8.4, 12);
  context.bezierCurveTo(8.4, 9, 9, 5.5, 12, 2);
  context.closePath();
};

/** Moored / at anchor: a small diamond, no direction implied. */
const drawIdle: Draw = (context) => {
  context.beginPath();
  context.moveTo(12, 7);
  context.lineTo(17, 12);
  context.lineTo(12, 17);
  context.lineTo(7, 12);
  context.closePath();
};

function renderIcon(draw: Draw, fill: string, halo: string, ring?: string): ImageData | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = ICON_PX;
  canvas.height = ICON_PX;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.scale(ICON_PX / 24, ICON_PX / 24);
  if (ring) {
    // Tracked vessels get a ring: told apart by shape, not by hue alone.
    context.beginPath();
    context.arc(12, 12, 10.6, 0, Math.PI * 2);
    context.lineWidth = 1.4;
    context.strokeStyle = ring;
    context.stroke();
  }
  draw(context);
  context.lineJoin = 'round';
  context.lineWidth = 1.6;
  context.strokeStyle = halo; // a halo in the surface colour keeps the mark legible on any tile
  context.stroke();
  context.fillStyle = fill;
  context.fill();
  return context.getImageData(0, 0, ICON_PX, ICON_PX);
}

/**
 * Draws the five sprites in the palette's colours and registers them. Called again on a theme
 * switch: `updateImage` swaps the pixels in place, the layers keep their ids.
 */
export function installLiveIcons(map: maplibregl.Map, palette: Palette): void {
  const icons: Array<[string, ImageData | null]> = [
    [LIVE_ICON.aircraft, renderIcon(drawPlane, palette.ink, palette.surface2)],
    [LIVE_ICON.aircraftGround, renderIcon(drawPlane, palette.dim, palette.surface2)],
    [LIVE_ICON.vessel, renderIcon(drawHull, palette.ink, palette.surface2)],
    [LIVE_ICON.vesselTracked, renderIcon(drawHull, palette.accent, palette.surface2, palette.accent)],
    [LIVE_ICON.vesselIdle, renderIcon(drawIdle, palette.muted, palette.surface2)],
  ];
  for (const [id, image] of icons) {
    if (!image) continue;
    try {
      if (map.hasImage(id)) map.updateImage(id, image);
      else map.addImage(id, image, { pixelRatio: 2 });
    } catch {
      // The map was torn down between two frames; nothing left to draw on.
    }
  }
}
