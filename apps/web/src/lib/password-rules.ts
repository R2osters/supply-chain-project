/**
 * The API's password rule, for the live checklist under a password field: at least 12
 * characters, and three of the four kinds — lowercase, uppercase, digit, symbol.
 *
 * `valid` uses the very regular expression of the API (apps/api/src/modules/auth/password-policy.ts,
 * STRONG_PASSWORD) plus its 128-character ceiling, so the checklist never approves a password the
 * server then refuses. The kinds are the regex's own classes: `_` is not a symbol there (it is a
 * word character), an accented letter is.
 */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_MIN_KINDS = 3;

const STRONG_PASSWORD =
  /^(?:(?=.*[a-z])(?=.*[A-Z])(?=.*\d)|(?=.*[a-z])(?=.*[A-Z])(?=.*[^\w\s])|(?=.*[a-z])(?=.*\d)(?=.*[^\w\s])|(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s]))[\s\S]{12,}$/;

export interface PasswordCheck {
  /** At least 12 characters. */
  length: boolean;
  /** At most 128 characters (the API's limit). */
  notTooLong: boolean;
  lower: boolean;
  upper: boolean;
  digit: boolean;
  symbol: boolean;
  /** How many of the four kinds are present. */
  kinds: number;
  /** Three kinds or more. */
  mix: boolean;
  /** Accepted by the API. */
  valid: boolean;
}

export function checkPassword(password: string): PasswordCheck {
  const lower = /[a-z]/.test(password);
  const upper = /[A-Z]/.test(password);
  const digit = /\d/.test(password);
  const symbol = /[^\w\s]/.test(password);
  const kinds = [lower, upper, digit, symbol].filter(Boolean).length;
  const notTooLong = password.length <= PASSWORD_MAX_LENGTH;
  return {
    length: password.length >= PASSWORD_MIN_LENGTH,
    notTooLong,
    lower,
    upper,
    digit,
    symbol,
    kinds,
    mix: kinds >= PASSWORD_MIN_KINDS,
    valid: notTooLong && STRONG_PASSWORD.test(password),
  };
}

export interface PasswordChangeCheck extends PasswordCheck {
  /** The new password differs from the current one (the API refuses the same one). */
  differs: boolean;
  /** The confirmation matches. */
  matches: boolean;
  /** Everything above holds and the current password is filled in: the form may be sent. */
  ready: boolean;
}

/** The checklist of a "change password" form: the rule, plus the two checks the form adds. */
export function checkPasswordChange(current: string, next: string, confirm: string): PasswordChangeCheck {
  const rule = checkPassword(next);
  const differs = next.length > 0 && next !== current;
  const matches = next.length > 0 && next === confirm;
  return { ...rule, differs, matches, ready: current.length > 0 && rule.valid && differs && matches };
}
