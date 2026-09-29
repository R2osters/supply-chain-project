import { randomInt } from 'node:crypto';

/**
 * Password policy: 12+ chars with three of four character classes. Length is weighted more
 * heavily than symbol gymnastics because it is what actually resists offline cracking, and the
 * hash is Argon2id regardless. The web app mirrors this rule in src/lib/password-rules.ts so the
 * checklist a user sees is the one the API enforces.
 */
export const STRONG_PASSWORD =
  /^(?:(?=.*[a-z])(?=.*[A-Z])(?=.*\d)|(?=.*[a-z])(?=.*[A-Z])(?=.*[^\w\s])|(?=.*[a-z])(?=.*\d)(?=.*[^\w\s])|(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s]))[\s\S]{12,}$/;

export const STRONG_PASSWORD_MESSAGE =
  'password must be at least 12 characters and combine at least three of: lowercase, uppercase, digit, symbol';

/*
 * Temporary passwords are read off a screen and typed by someone else, often dictated. The
 * alphabet therefore leaves out the characters people confuse: l / 1 / I and o / 0 / O.
 */
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
export const TEMPORARY_PASSWORD_ALPHABET = LOWER + UPPER + DIGITS;
export const TEMPORARY_PASSWORD_LENGTH = 16;

function pick(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)];
}

/**
 * A random temporary password: 16 characters from a 56-symbol alphabet (about 93 bits), with at
 * least one lowercase letter, one capital and one digit so it always satisfies STRONG_PASSWORD.
 * `crypto.randomInt` is uniform (no modulo bias) and cryptographically secure.
 */
export function generateTemporaryPassword(length = TEMPORARY_PASSWORD_LENGTH): string {
  if (length < 12) throw new RangeError('A temporary password needs at least 12 characters');
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS)];
  while (chars.length < length) chars.push(pick(TEMPORARY_PASSWORD_ALPHABET));
  // Fisher–Yates, so the guaranteed classes are not always in the first three positions.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
