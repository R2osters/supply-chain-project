/**
 * Outbound HTTP for public data feeds.
 *
 * Every live source this API reads (weather, seismic, camera catalogues, radio directories,
 * orbital elements) is a free service run by someone else. Three things go wrong with them, and
 * each has a guard here rather than in every caller:
 *
 *   - they hang: a deadline aborts the request instead of pinning a Node socket forever;
 *   - they return far more than expected (a misconfigured endpoint streaming a dump): the body is
 *     read against a byte ceiling and cancelled the moment it is crossed, so one bad upstream
 *     cannot exhaust the API's memory;
 *   - they fail: the error carries the status and host but never the upstream body, which may
 *     contain HTML, stack traces or the key we sent.
 *
 * Adapted from God's Eye View (MIT), `server/providers/common/http.js`.
 */

export const DEFAULT_USER_AGENT = 'SCIP/0.1 (+supply chain intelligence platform)';

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly host: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface CappedFetchOptions {
  /** Hard ceiling on the decoded body, in bytes. */
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
  /** Refuse redirects: set for sources whose host is on an allow-list. */
  noRedirects?: boolean;
}

const DEFAULTS = { maxBytes: 4 * 1024 * 1024, timeoutMs: 12_000 } as const;

export async function fetchBytesCapped(url: string, options: CappedFetchOptions = {}): Promise<Buffer> {
  const response = await openUpstream(url, options);
  return readBodyCapped(response, options.maxBytes ?? DEFAULTS.maxBytes, hostOf(url));
}

export async function fetchTextCapped(url: string, options: CappedFetchOptions = {}): Promise<string> {
  const bytes = await fetchBytesCapped(url, options);
  return bytes.toString('utf8');
}

export async function fetchJsonCapped<T>(url: string, options: CappedFetchOptions = {}): Promise<T> {
  const text = await fetchTextCapped(url, {
    ...options,
    headers: { Accept: 'application/json', ...options.headers },
  });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError(`${hostOf(url)} returned a body that is not JSON`, hostOf(url), null);
  }
}

/** Opens the request and checks status; the caller decides how to read the body. */
export async function openUpstream(url: string, options: CappedFetchOptions = {}): Promise<Response> {
  const host = hostOf(url);
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      body: options.body,
      headers: { 'User-Agent': DEFAULT_USER_AGENT, ...options.headers },
      redirect: options.noRedirects ? 'error' : 'follow',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULTS.timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'unreachable';
    throw new UpstreamError(`${host} ${reason}`, host, null);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamError(`${host} answered ${response.status}`, host, response.status);
  }
  return response;
}

/**
 * Reads a body while counting bytes. A declared Content-Length over the cap is refused before a
 * single byte is read; a chunked body is cancelled as soon as it crosses the cap.
 */
export async function readBodyCapped(response: Response, maxBytes: number, host: string): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamError(`${host} response exceeds ${maxBytes} bytes`, host, response.status);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new UpstreamError(`${host} response exceeds ${maxBytes} bytes`, host, response.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}
