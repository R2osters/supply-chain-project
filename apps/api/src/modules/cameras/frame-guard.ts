/**
 * The checks between "a client asked for camera X" and "the API opens a socket to somewhere".
 *
 * The frame endpoint is the one place in this module where a request from a browser makes the
 * server fetch a URL, which is the textbook shape of an SSRF hole. The design keeps the client
 * away from the URL entirely — it names a camera, the server looks up the URL it registered from
 * a catalogue — and then, because catalogues are someone else's data, checks that URL again right
 * before the fetch: https only, exact host from the pack's allow-list, default port, no
 * credentials, optional path prefix. A catalogue that starts listing `http://169.254.169.254/`
 * produces a refused camera, not a request to the metadata service.
 *
 * The response is checked too: only bytes that start like a JPEG or PNG are relayed, and the
 * Content-Type we send is derived from those bytes, never copied from upstream. An HTML error
 * page served with status 200 therefore never reaches a browser as if it came from us.
 *
 * Adapted from God's Eye View (MIT), `server/providers/cctv/media.js`.
 */
import type { CameraFrame, CameraPack } from './camera.types';

/** The upstream URL to fetch for a registered frame, or null when it fails the pack's rules. */
export function resolveFrameUrl(pack: CameraPack, registeredUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(registeredUrl);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' && pack.upgradeHttpFrames) url.protocol = 'https:';
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  // `URL` drops the port when it is the scheme default, so any port left here is non-standard.
  if (url.port) return null;
  if (!pack.frameHosts.includes(url.hostname.toLowerCase())) return null;
  if (pack.framePathPrefix && !url.pathname.startsWith(pack.framePathPrefix)) return null;
  return url;
}

/** The image type the bytes actually are, or null. Only JPEG and PNG are relayed. */
export function sniffImageType(bytes: Buffer): CameraFrame['contentType'] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) {
    return 'image/png';
  }
  return null;
}

/**
 * Upstream content types we are willing to read at all. Some hosts label stills as
 * `application/octet-stream`, so that is let through to the magic-byte check; anything that
 * declares itself as text or HTML is refused before a byte is read.
 */
export function isAcceptableFrameContentType(header: string | null): boolean {
  const type = (header ?? '').split(';')[0].trim().toLowerCase();
  return type === '' || type === 'image/jpeg' || type === 'image/jpg' || type === 'image/png' ||
    type === 'application/octet-stream';
}

const CAMERA_ID = /^([a-z0-9]{1,32}):([A-Za-z0-9._-]{1,64})$/;

/** Splits a public camera id into pack and upstream id, or null when it is not one we issue. */
export function parseCameraId(id: string): { pack: string; upstreamId: string } | null {
  const match = CAMERA_ID.exec(id);
  return match ? { pack: match[1], upstreamId: match[2] } : null;
}
