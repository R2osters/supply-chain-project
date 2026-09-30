'use client';

import { apiUrl as apiBaseUrl } from './runtime-config';

/**
 * Typed API client.
 *
 * Access tokens live in memory; only the refresh token is persisted. A refresh token in
 * `localStorage` is a real exposure, but it is a *revocable* one — the server can kill the
 * family — whereas an access token there would be a bearer credential the server cannot
 * withdraw before it expires. Keeping the short-lived one out of storage is the trade that
 * matters.
 *
 * A 401 triggers exactly one refresh, and concurrent 401s share that single attempt instead of
 * stampeding the endpoint — five parallel dashboard queries expiring together must not fire
 * five rotations, four of which would then look like token reuse and revoke the session.
 */

const REFRESH_KEY = 'scip.refresh';

let accessToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;
let onUnauthenticated: (() => void) | null = null;
let onPasswordChange: (() => void) | null = null;

/**
 * `code` of the API's 403 while the account still holds a temporary password: every route but
 * the password change answers it until the holder has chosen their own.
 */
export const PASSWORD_CHANGE_REQUIRED = 'password-change-required';

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setRefreshToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem(REFRESH_KEY, token);
  else window.localStorage.removeItem(REFRESH_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(REFRESH_KEY);
}

export function onSessionLost(handler: () => void): void {
  onUnauthenticated = handler;
}

/**
 * Called when any request meets the "choose your password first" refusal, so the app shows its
 * password screen once instead of every screen reporting its own error.
 */
export function onPasswordChangeRequired(handler: (() => void) | null): void {
  onPasswordChange = handler;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The API's machine-readable reason, when it gave one (`password-change-required`…). */
  get code(): string | undefined {
    const code = (this.detail as { code?: unknown } | undefined)?.code;
    return typeof code === 'string' ? code : undefined;
  }
}

async function refreshSession(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  try {
    const response = await fetch(`${apiBaseUrl()}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) {
      setRefreshToken(null);
      return false;
    }
    const data = (await response.json()) as { accessToken: string; refreshToken: string };
    accessToken = data.accessToken;
    setRefreshToken(data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Internal: prevents an infinite refresh loop. */
  retried?: boolean;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * Binary GET with the same auth and refresh behaviour as `api` — for camera frames, which an
 * `<img src>` cannot fetch because it has no way to send a bearer token.
 */
export async function apiBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  const response = await send(path, { signal });
  return response.blob();
}

/** Absolute URL of an API path, for consumers that fetch on their own (MapLibre tiles). */
export function apiUrl(path: string): string {
  return `${apiBaseUrl()}${path}`;
}

/** Whether a URL points at this API, so a map never leaks the token to a third-party tile host. */
export function isApiUrl(url: string): boolean {
  return url.startsWith(apiBaseUrl());
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const { method = 'GET', body, retried = false, signal } = options;

  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (response.status === 401 && !retried) {
    // Share one refresh across every caller that hit 401 at the same moment.
    refreshInFlight ??= refreshSession().finally(() => {
      refreshInFlight = null;
    });

    const refreshed = await refreshInFlight;
    if (refreshed) {
      return send(path, { ...options, retried: true });
    }

    accessToken = null;
    onUnauthenticated?.();
    throw new ApiError('Votre session a expiré. Reconnectez-vous.', 401);
  }

  if (!response.ok) {
    let message = `La requête a échoué (statut ${response.status})`;
    let detail: unknown;
    try {
      const payload = await response.json();
      detail = payload;
      const raw = payload?.message ?? payload?.detail?.message ?? payload?.detail;
      if (typeof raw === 'string') message = raw;
      else if (Array.isArray(raw)) message = raw.join('. ');
    } catch {
      /* body was not JSON; the status-based message stands */
    }
    const error = new ApiError(message, response.status, detail);
    if (response.status === 403 && error.code === PASSWORD_CHANGE_REQUIRED) onPasswordChange?.();
    throw error;
  }

  return response;
}

/* ------------------------------------------------------------------- types */

export interface Paginated<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number; hasNextPage: boolean };
}

export interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  companyId: string | null;
  emailVerified: boolean;
  /** Signed in with a temporary password: the app asks for a new one before anything else. */
  mustChangePassword?: boolean;
}

export interface Explanation {
  summary: string;
  reasons: string[];
  assumptions: string[];
}

export interface Overview {
  shipments: {
    active: number;
    delayed: number;
    deliveredToday: number;
    atRisk: number;
    withOpenAnomaly: number;
  };
  inventory: {
    value: number;
    lowStockProducts: number;
    outOfStockProducts: number;
    distinctSkus: number;
  };
  fleet: { total: number; inTransit: number; reportingWithinTheHour: number };
  openIncidents: number;
  openRecommendations: number;
  demoData: { shipments: number; share: number; note: string | null };
}

export interface FleetVehicle {
  vehicleId: string;
  plateNumber: string;
  label: string | null;
  type: string;
  status: string;
  latitude: number;
  longitude: number;
  speedKmh: number | null;
  headingDegrees: number | null;
  /** Null for a vehicle on the road that never reported: it is placed at its estimate. */
  lastPositionAt: string | null;
  shipmentId: string | null;
  trackingNumber: string | null;
  shipmentStatus: string | null;
  destinationName: string | null;
  estimatedArrivalAt: string | null;
  delayProbability: number | null;
  driverName: string | null;
  isDemoData: boolean;
  /** `estimated` when latitude/longitude are the estimate rather than a GPS fix. */
  positionSource?: 'gps' | 'estimated';
  /** Minutes since the last fix; null if the vehicle never reported. */
  gpsSilentMinutes?: number | null;
  /** Probable position along the planned route while the GPS is silent (5 min or more). */
  estimated?: VehicleEstimate | null;
}

export interface VehicleEstimate {
  latitude: number;
  longitude: number;
  radiusKm: number;
  /** Share of the planned route covered, 0 to 1. */
  progress: number;
  basis: 'last-fix' | 'departure';
  minutesSinceBasis: number;
  assumedSpeedKmh: number;
  atDestination: boolean;
}

export interface ShipmentRow {
  id: string;
  trackingNumber: string;
  status: string;
  originName: string;
  destinationName: string;
  plannedDepartureAt: string;
  plannedArrivalAt: string;
  estimatedArrivalAt: string | null;
  deliveredAt: string | null;
  plannedDistanceKm: number;
  travelledDistanceKm: number;
  delayProbability: number | null;
  delayRisk: string | null;
  hasOpenAnomaly: boolean;
  isLate: boolean;
  isDemoData: boolean;
  carrier: { id: string; name: string; onTimeRate: number } | null;
  vehicle: { id: string; plateNumber: string; type: string } | null;
  driver: { id: string; firstName: string; lastName: string } | null;
  customer: { id: string; name: string } | null;
  _count: { items: number; anomalies: number; incidents: number };
}

export interface Recommendation {
  id: string;
  type: string;
  status: string;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  explanation: Explanation;
  estimatedCostDelta: number | null;
  estimatedRiskDelta: number | null;
  estimatedServiceLevelDelta: number | null;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  executedEntityType: string | null;
  executedEntityId: string | null;
}

export interface InventoryRow {
  id: string;
  availableStock: number;
  reservedStock: number;
  damagedStock: number;
  incomingStock: number;
  freeStock: number;
  value: number;
  reorderPoint: string | number;
  safetyStock: string | number;
  belowReorderPoint: boolean;
  product: { id: string; sku: string; name: string; unitCost: string; unitOfMeasure: string };
  warehouse: { id: string; code: string; name: string };
}

export interface RiskFinding {
  category: string;
  probability: number;
  impact: number;
  score: number;
  level: string;
  subject: string;
  subjectType: string;
  subjectId: string;
  recommendedAction: string;
  explanation: Explanation;
}
