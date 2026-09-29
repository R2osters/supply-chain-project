'use client';

import { useCallback } from 'react';
import { useI18n, type TranslationKey } from '@/lib/i18n';

/** `IN_TRANSIT` → `in transit`: the readable fallback when an enum value has no translation. */
export function humanise(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase();
}

/**
 * Looks up a dynamic key (built from an API enum) and falls back to readable text rather than
 * showing the raw key when the dictionary does not know the value yet.
 */
export function useLabel() {
  const { t } = useI18n();
  return useCallback(
    (key: string, fallback: string) => {
      const value = t(key as TranslationKey);
      return value === key ? fallback : value;
    },
    [t],
  );
}

/** Shipment status in the user's language (shared by /shipments/[id], /map and /maritime). */
export function useStatusLabel() {
  const label = useLabel();
  return useCallback((status: string | null | undefined) => (status ? label(`ship.detail.status.${status}`, humanise(status)) : '—'), [label]);
}
