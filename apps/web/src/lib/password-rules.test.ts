import { describe, expect, it } from 'vitest';
import { checkPassword, checkPasswordChange } from './password-rules';

describe('checkPassword', () => {
  it('accepts 12+ characters with three kinds out of four', () => {
    expect(checkPassword('DemoPassw0rd!2026').valid).toBe(true);
    expect(checkPassword('lowercase-and-UPPER').valid).toBe(true); // lower + upper + symbol
    expect(checkPassword('lower1234567!').valid).toBe(true); // lower + digit + symbol
    expect(checkPassword('Kx7mPq3rTz9wHb4n').valid).toBe(true); // what the API generates
  });

  it('refuses short passwords whatever their mix', () => {
    const check = checkPassword('Ab1!Ab1!');
    expect(check).toMatchObject({ length: false, mix: true, valid: false });
  });

  it('refuses two kinds only, and says which kinds are there', () => {
    const check = checkPassword('onlylowercase123');
    expect(check).toMatchObject({ lower: true, digit: true, upper: false, symbol: false, kinds: 2, mix: false, valid: false });
  });

  it('counts kinds exactly as the API does', () => {
    // `_` is a word character for the API, not a symbol…
    expect(checkPassword('under_score_only1')).toMatchObject({ symbol: false, kinds: 2, valid: false });
    // …while an accented letter is one.
    expect(checkPassword('éléphant-rose-42')).toMatchObject({ symbol: true, lower: true, digit: true, valid: true });
    // Spaces count toward the length but are no kind at all.
    expect(checkPassword('Correct horse battery 9')).toMatchObject({ kinds: 3, valid: true });
  });

  it('enforces the 128-character ceiling', () => {
    const long = `Aa1${'x'.repeat(126)}`;
    expect(long).toHaveLength(129);
    expect(checkPassword(long)).toMatchObject({ length: true, mix: true, notTooLong: false, valid: false });
  });

  it('agrees with its own checklist on ordinary input', () => {
    for (const sample of ['Password1234', 'password1234', 'PASSWORD-1234', 'Pass word 12!', '123456789012', 'aA1!']) {
      const check = checkPassword(sample);
      expect(check.valid).toBe(check.length && check.mix && check.notTooLong);
    }
  });
});

describe('checkPasswordChange', () => {
  it('is ready only with the current password, a valid new one, different, confirmed', () => {
    expect(checkPasswordChange('Temp0rary-Pass', 'Mine-0nly-Now!', 'Mine-0nly-Now!').ready).toBe(true);
    expect(checkPasswordChange('', 'Mine-0nly-Now!', 'Mine-0nly-Now!').ready).toBe(false);
    expect(checkPasswordChange('Temp0rary-Pass', 'Mine-0nly-Now!', 'Mine-0nly-Now')).toMatchObject({ matches: false, ready: false });
    expect(checkPasswordChange('Temp0rary-Pass', 'Temp0rary-Pass', 'Temp0rary-Pass')).toMatchObject({ differs: false, ready: false });
    expect(checkPasswordChange('Temp0rary-Pass', 'weak', 'weak').ready).toBe(false);
  });

  it('does not tick "matches" or "differs" for an empty new password', () => {
    expect(checkPasswordChange('x', '', '')).toMatchObject({ matches: false, differs: false });
  });
});
