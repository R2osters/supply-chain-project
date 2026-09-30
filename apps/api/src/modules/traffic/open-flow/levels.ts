/**
 * Turns each city's own way of saying "how busy" into one level: current speed over free-flow
 * speed, 0..1 (1 = free flow), or null when nothing was measured. A road with unusable data must
 * render like the simulation, never as a phantom jam.
 */

/** Rennes `trafficstatus` to a level, one per colour band. */
const RENNES_STATUS: Record<string, number> = { freeFlow: 0.9, heavy: 0.6, congested: 0.3 };

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Rennes Métropole, "Etat du trafic en temps réel".
 *
 * Rennes' own status comes first: it compares the measured speed with the section's reference
 * speed. The speed over the legal limit is a poor stand-in: a city street flows well under its
 * limit, so on 30 Sep 2026 that ratio called 601 of 2 277 lines in the city a jam where Rennes
 * saw 196 congested ones in the whole metropolitan area. The ratio only serves when the status
 * is missing or unexpected.
 *
 * Its 'unknown' lines still carry a speed and a limit (often 80/80) with zero probe vehicles, so
 * no probe (or 'unknown') means no measure, before anything else.
 */
export function rennesLevel(speed: unknown, limit: unknown, status: unknown, probes: unknown): number | null {
  if (status === 'unknown' || probes === 0) return null;
  if (typeof status === 'string' && Object.hasOwn(RENNES_STATUS, status)) return RENNES_STATUS[status];
  // Speeds above the limit are common (504 of 2 859 lines on 30 Sep 2026): cap at free flow.
  return positive(speed) && positive(limit) ? Math.min(1, speed / limit) : null;
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
