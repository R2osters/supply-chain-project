import type { TranslationKey } from '@/lib/i18n';

export const PO_STATUSES = [
  'DRAFT',
  'PENDING',
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'IN_TRANSIT',
  'DELIVERED',
  'CANCELLED',
] as const;

export type PoStatus = (typeof PO_STATUSES)[number];

/**
 * Mirrors the API's state machine (apps/api/.../purchase-order-status.ts), so the UI only offers
 * moves the server will accept. It is forward-only: DELIVERED and CANCELLED are terminal.
 */
export const PO_NEXT: Record<string, string[]> = {
  DRAFT: ['PENDING', 'CANCELLED'],
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['IN_TRANSIT', 'DELIVERED', 'CANCELLED'],
  IN_TRANSIT: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

/** Everything that is neither delivered nor cancelled still needs watching. */
export const OPEN_STATUSES: string[] = ['DRAFT', 'PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'IN_TRANSIT'];

export function poStatusKey(status: string): TranslationKey {
  return (PO_STATUSES as readonly string[]).includes(status)
    ? (`po.st.${status}` as TranslationKey)
    : ('po.status' as TranslationKey);
}

/** Late = the expected date has passed and the goods are not in, or they arrived after it. */
export function isLate(order: {
  status: string;
  expectedDeliveryDate: string | null;
  actualDeliveryDate: string | null;
}): boolean {
  if (!order.expectedDeliveryDate) return false;
  const expected = new Date(order.expectedDeliveryDate).getTime();
  if (order.actualDeliveryDate) return new Date(order.actualDeliveryDate).getTime() > expected;
  return OPEN_STATUSES.includes(order.status) && expected < Date.now();
}
