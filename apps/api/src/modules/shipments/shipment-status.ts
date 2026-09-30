import { BadRequestException } from '@nestjs/common';
import type { ShipmentStatus } from '@scip/shared';

/**
 * Shipment lifecycle.
 *
 *   PLANNED ─▶ LOADING ─▶ DEPARTED ─▶ IN_TRANSIT ─▶ ARRIVED ─▶ DELIVERED
 *                                          ▲  │
 *                                          └──┘  DELAYED (reversible)
 *
 * DELAYED is a *state*, not a terminal outcome: a shipment that recovers goes back to IN_TRANSIT.
 * Modelling it as a flag on IN_TRANSIT was the alternative, but the brief treats it as a status
 * and operators filter on it, so it stays a status and the transition table keeps the round trip
 * legal in both directions.
 */
export const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  PLANNED: ['LOADING', 'DEPARTED', 'CANCELLED'],
  LOADING: ['DEPARTED', 'CANCELLED'],
  DEPARTED: ['IN_TRANSIT', 'DELAYED', 'ARRIVED', 'CANCELLED'],
  IN_TRANSIT: ['DELAYED', 'ARRIVED', 'CANCELLED'],
  DELAYED: ['IN_TRANSIT', 'ARRIVED', 'CANCELLED'],
  ARRIVED: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

/** Statuses in which the vehicle is physically on the road and GPS is expected. */
export const IN_MOTION_STATUSES: ShipmentStatus[] = ['DEPARTED', 'IN_TRANSIT', 'DELAYED'];

/** Statuses that still count as "open" on the dashboard. */
export const ACTIVE_STATUSES: ShipmentStatus[] = [
  'PLANNED',
  'LOADING',
  'DEPARTED',
  'IN_TRANSIT',
  'DELAYED',
  'ARRIVED',
];

/**
 * French names of the statuses, for texts people read (timeline, errors). The status values
 * themselves stay English identifiers. Agreed with « expédition », as the shipment page shows them.
 */
export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = {
  PLANNED: 'planifiée',
  LOADING: 'en chargement',
  DEPARTED: 'partie',
  IN_TRANSIT: 'en transit',
  DELAYED: 'en retard',
  ARRIVED: 'arrivée',
  DELIVERED: 'livrée',
  CANCELLED: 'annulée',
};

/** The status inside a sentence, e.g. « Une expédition livrée… ». Unknown values pass through. */
export function shipmentStatusLabel(status: string): string {
  return SHIPMENT_STATUS_LABELS[status as ShipmentStatus] ?? status;
}

/** The status quoted as a label, e.g. « Livrée ». */
export function quotedShipmentStatus(status: string): string {
  const label = shipmentStatusLabel(status);
  return `« ${label.charAt(0).toUpperCase()}${label.slice(1)} »`;
}

export function canTransition(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return SHIPMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: ShipmentStatus, to: ShipmentStatus): void {
  if (from === to) {
    throw new BadRequestException(`L’expédition est déjà ${shipmentStatusLabel(from)}`);
  }
  if (!canTransition(from, to)) {
    const allowed = SHIPMENT_TRANSITIONS[from];
    throw new BadRequestException(
      allowed.length === 0
        ? `${quotedShipmentStatus(from)} est un statut final : aucune autre transition n’est possible`
        : `Impossible de faire passer une expédition de ${quotedShipmentStatus(from)} à ` +
            `${quotedShipmentStatus(to)}. Transitions autorisées : ${allowed.map(quotedShipmentStatus).join(', ')}`,
    );
  }
}
