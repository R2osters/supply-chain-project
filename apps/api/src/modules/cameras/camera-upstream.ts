/**
 * The only code in this module that touches the network. It sits behind an injection token so the
 * service can be tested with hand-written fixtures and no sockets.
 */
import { Injectable } from '@nestjs/common';
import { UpstreamError, fetchJsonCapped, hostOf, openUpstream, readBodyCapped } from '../../common/http';
import type { CameraPack } from './camera.types';
import { isAcceptableFrameContentType } from './frame-guard';

export const CAMERA_UPSTREAM = Symbol('CAMERA_UPSTREAM');

// The largest catalogue (DriveBC, ~1 000 cameras with nested metadata) is ~1.3 MB; 16 MiB is only
// there so a misbehaving endpoint cannot be buffered without limit.
const CATALOG_MAX_BYTES = 16 * 1024 * 1024;
const CATALOG_TIMEOUT_MS = 20_000;
// A 1080p traffic still is 100-600 KB. Anything past 3 MiB is not a still we want to relay.
export const FRAME_MAX_BYTES = 3 * 1024 * 1024;
const FRAME_TIMEOUT_MS = 10_000;

export interface CameraUpstream {
  fetchCatalog(pack: CameraPack): Promise<unknown>;
  /** Fetches a frame from an already-vetted URL. Returns raw bytes; type checks are the caller's. */
  fetchFrame(url: URL, pack: CameraPack): Promise<Buffer>;
}

@Injectable()
export class HttpCameraUpstream implements CameraUpstream {
  fetchCatalog(pack: CameraPack): Promise<unknown> {
    return fetchJsonCapped<unknown>(pack.catalogUrl, {
      maxBytes: CATALOG_MAX_BYTES,
      timeoutMs: CATALOG_TIMEOUT_MS,
      headers: pack.catalogHeaders,
      noRedirects: true,
    });
  }

  async fetchFrame(url: URL, pack: CameraPack): Promise<Buffer> {
    const href = url.toString();
    const host = hostOf(href);
    const response = await openUpstream(href, {
      timeoutMs: FRAME_TIMEOUT_MS,
      // A redirect would land on a host nobody checked against the allow-list.
      noRedirects: true,
      headers: { Accept: 'image/jpeg, image/png;q=0.9', ...pack.frameHeaders },
    });
    const contentType = response.headers.get('content-type');
    if (!isAcceptableFrameContentType(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpstreamError(`${host} did not answer with an image`, host, response.status);
    }
    return readBodyCapped(response, FRAME_MAX_BYTES, host);
  }
}
