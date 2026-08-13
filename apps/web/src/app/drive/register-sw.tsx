'use client';

import { useEffect } from 'react';

/**
 * Registers the driver screen's service worker.
 *
 * Scoped to `/drive` so it never intercepts the operator dashboard: a stale cached shipment list
 * would be a far worse failure than a slow one, and the two screens have opposite requirements —
 * the driver needs the page to open with no network, the dispatcher needs it to be current.
 *
 * Registration is skipped outside a secure context. Service workers require HTTPS everywhere
 * except localhost, and calling `register` on a plain-HTTP LAN address throws an error into the
 * console that looks like a bug in the app rather than a browser rule.
 */
export function DriveServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register('/drive-sw.js', { scope: '/drive' }).catch(() => {
      // Nothing to do: the page works without it, only without the offline shell.
    });
  }, []);

  return null;
}
