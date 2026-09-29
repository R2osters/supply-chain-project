/**
 * In the desktop app, links that leave SCIP (aisstream.io, opensky-network.org, MarineTraffic
 * pages...) must open in the user's browser: the webview blocks new windows, so a plain
 * `target="_blank"` would do nothing. In a normal browser this is a no-op.
 */

interface TauriOpener {
  opener?: { openUrl?: (url: string) => Promise<void> };
}

export function isExternalHref(href: string, currentOrigin: string): boolean {
  try {
    const url = new URL(href, currentOrigin);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin !== currentOrigin;
  } catch {
    return false;
  }
}

/** Installs one document-level handler; returns its remover. */
export function routeExternalLinksToBrowser(): () => void {
  const tauri = (window as unknown as { __TAURI__?: TauriOpener }).__TAURI__;
  const openUrl = tauri?.opener?.openUrl;
  if (!openUrl) return () => undefined;

  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor || !isExternalHref(anchor.href, window.location.origin)) return;
    event.preventDefault();
    void openUrl(anchor.href);
  };
  document.addEventListener('click', onClick);
  return () => document.removeEventListener('click', onClick);
}
