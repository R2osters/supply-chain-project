import { BadRequestException } from '@nestjs/common';
import type { PurchaseOrderStatus } from '@scip/shared';

/**
 * Purchase-order lifecycle.
 *
 *   DRAFT ──▶ PENDING ──▶ CONFIRMED ──▶ PROCESSING ──▶ SHIPPED ──▶ IN_TRANSIT ──▶ DELIVERED
 *     │          │            │             │             │            │
 *     └──────────┴────────────┴─────────────┴─────────────┴────────────┴──▶ CANCELLED
 *
 * Encoded as data rather than a chain of `if`s so the allowed moves are inspectable, testable and
 * exposed to the UI (which greys out buttons instead of letting the user discover the rule from a
 * 400). DELIVERED is terminal: goods that arrived cannot un-arrive — a mistake is corrected with
 * a stock adjustment, which leaves a trail, not by rewinding the order.
 */
export const PURCHASE_ORDER_TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  DRAFT: ['PENDING', 'CANCELLED'],
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['IN_TRANSIT', 'DELIVERED', 'CANCELLED'],
  IN_TRANSIT: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

/** Statuses at which the ordered quantity counts as incoming stock for the reorder engine. */
export const INCOMING_STOCK_STATUSES: PurchaseOrderStatus[] = [
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'IN_TRANSIT',
];

/** Once confirmed, lines are a commitment to the supplier and are no longer freely editable. */
export const EDITABLE_STATUSES: PurchaseOrderStatus[] = ['DRAFT', 'PENDING'];

export function canTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): boolean {
  return PURCHASE_ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): void {
  if (from === to) {
    throw new BadRequestException(`Purchase order is already ${from}`);
  }
  if (!canTransition(from, to)) {
    const allowed = PURCHASE_ORDER_TRANSITIONS[from];
    throw new BadRequestException(
      allowed.length === 0
        ? `${from} is a terminal status; no further transitions are possible`
        : `Cannot move a purchase order from ${from} to ${to}. Allowed: ${allowed.join(', ')}`,
    );
  }
}
