import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Time-limited, tamper-proof download links for locally stored files.
 *
 * This replaces S3 presigned URLs one-for-one: the database still holds only an object key, and a
 * reader gets a link that expires. The signature covers both the key and the expiry, so neither
 * can be edited to reach another file or to extend access.
 */

/** Keys we generate: `<companyId>/<deliveryId>/<kind>-<uuid>.<ext>`. Anything else is refused. */
const KEY_PATTERN = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[a-z]+-[0-9a-f-]{36}\.[a-z0-9]{1,8}$/;

export function isValidStorageKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function signStorageKey(secret: string, key: string, expiresAtSeconds: number): string {
  return createHmac('sha256', secret).update(`${key}\n${expiresAtSeconds}`).digest('base64url');
}

export function verifyStorageSignature(
  secret: string,
  key: string,
  expiresAtSeconds: number,
  signature: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!Number.isFinite(expiresAtSeconds) || expiresAtSeconds < nowSeconds) return false;
  const expected = Buffer.from(signStorageKey(secret, key, expiresAtSeconds));
  const given = Buffer.from(signature);
  // Length check first: timingSafeEqual throws on unequal lengths.
  return expected.length === given.length && timingSafeEqual(expected, given);
}
