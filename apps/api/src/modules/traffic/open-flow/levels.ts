/**
 * Turns each city's own way of saying "how busy" into one level: current speed over free-flow
 * speed, 0..1 (1 = free flow), or null when nothing was measured. A road with unusable data must
 * render like the simulation, never as a phantom jam.
 */

/** Rennes `trafficstatus` when no usable speed was published. */
const RENNES_STATUS: Record<string, number> = { freeFlow: 0.9, heavy: 0.6, congested: 0.3 };

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Rennes Métropole, "Etat du trafic en temps réel". Its 'unknown' lines still carry a speed and a
 * limit (often 80/80) with zero probe vehicles: read as a ratio they would pass for free-flowing
 * measured roads, so no probe (or 'unknown') means no measure, before anything else.
 */
export function rennesLevel(speed: unknown, limit: unknown, status: unknown, probes: unknown): number | null {
  if (status === 'unknown' || probes === 0) return null;
  // Speeds above the limit are common (504 of 2 859 lines on 30 Sep 2026): cap at free flow.
  if (positive(speed) && positive(limit)) return Math.min(1, speed / limit);
  return typeof status === 'string' && Object.hasOwn(RENNES_STATUS, status) ? RENNES_STATUS[status] : null;
}

/**
 * Métromobilité (Grenoble) service level, `nsv_id`: 0 unknown, 1 free, 2 heavy, 3 congested,
 * 4 blocked (MetromobiliteWS, trrC38.js).
 */
export function grenobleLevel(code: unknown): { level: number | null; closed: boolean } {
  switch (code) {
    case 1:
      return { level: 0.9, closed: false };
    case 2:
      return { level: 0.6, closed: false };
    case 3:
      return { level: 0.3, closed: false };
    case 4:
      return { level: 0, closed: true };
    default:
      return { level: null, closed: false };
  }
}
