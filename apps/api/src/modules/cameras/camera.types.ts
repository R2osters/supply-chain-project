/**
 * Shapes shared by the camera packs, the service and the controller.
 *
 * Two camera shapes exist on purpose. `CameraRecord` is what a pack normaliser produces and it
 * carries the upstream frame URL. `Camera` is what leaves the API and it does not: the frame URL
 * is a server-side secret in the sense that matters here — if a client never sees it, a client can
 * never hand one back, and the frame endpoint cannot be turned into a fetch-anything proxy.
 */

/** One camera as a pack normaliser sees it. Never serialised to a client. */
export interface CameraRecord {
  /** Provider-stable id, already URL-safe (`[A-Za-z0-9._-]`). The pack prefix is added later. */
  upstreamId: string;
  name: string;
  latitude: number;
  longitude: number;
  /** Compass bearing the camera looks along, when the provider publishes one. */
  headingDegrees: number | null;
  /** The provider's own facing text ("Northbound", "N-E"), kept for display. */
  direction: string | null;
  /** Absolute https URL of the still frame. Checked again against the pack allow-list on fetch. */
  frameUrl: string;
}

export interface CameraPack {
  id: string;
  label: string;
  /** Attribution text the licence requires to be shown next to the picture. */
  attribution: string;
  licence: string;
  catalogUrl: string;
  /** How often a viewer should ask for a new frame of this pack's cameras. */
  refreshSeconds: number;
  /** Exact hostnames frames may be fetched from. Anything else is refused at fetch time. */
  frameHosts: string[];
  /** Optional path prefix frames must sit under, for packs whose frame host is shared (S3). */
  framePathPrefix?: string;
  /** Upgrade `http:` frame URLs to `https:` — only for hosts documented to redirect there. */
  upgradeHttpFrames?: boolean;
  /** Extra request headers for the catalogue call (identification some providers ask for). */
  catalogHeaders?: Record<string, string>;
  /** Extra request headers for frame calls. */
  frameHeaders?: Record<string, string>;
  /** Pure: raw catalogue JSON in, cameras out. Must not throw on malformed rows. */
  normalize(raw: unknown): CameraRecord[];
}

/** Public camera shape. Field names are the frontend contract. */
export interface Camera {
  /** `<pack>:<upstreamId>` */
  id: string;
  pack: string;
  name: string;
  latitude: number;
  longitude: number;
  headingDegrees: number | null;
  direction: string | null;
  refreshSeconds: number;
  attribution: string;
  distanceKm?: number;
}

export type PackHealth = 'OK' | 'STALE' | 'UNAVAILABLE';

export interface PackStatus {
  id: string;
  label: string;
  status: PackHealth;
  count: number;
  fetchedAt: string | null;
  attribution: string;
  licence: string;
}

export interface CameraList {
  cameras: Camera[];
  packs: PackStatus[];
}

export interface CameraFrame {
  bytes: Buffer;
  contentType: 'image/jpeg' | 'image/png';
}
