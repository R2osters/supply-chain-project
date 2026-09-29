import {
  STRONG_PASSWORD,
  TEMPORARY_PASSWORD_ALPHABET,
  TEMPORARY_PASSWORD_LENGTH,
  generateTemporaryPassword,
} from './password-policy';

describe('generateTemporaryPassword', () => {
  const samples = Array.from({ length: 500 }, () => generateTemporaryPassword());

  it('is 16 characters and always satisfies the API password rule', () => {
    for (const password of samples) {
      expect(password).toHaveLength(TEMPORARY_PASSWORD_LENGTH);
      expect(password).toMatch(STRONG_PASSWORD);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/\d/);
    }
  });

  it('only uses characters that cannot be misread (no l/1/I, o/0/O, no symbols)', () => {
    const allowed = new Set(TEMPORARY_PASSWORD_ALPHABET);
    for (const password of samples) {
      for (const char of password) expect(allowed.has(char)).toBe(true);
    }
    expect(TEMPORARY_PASSWORD_ALPHABET).not.toMatch(/[l1IoO0]/);
  });

  it('does not repeat itself', () => {
    expect(new Set(samples).size).toBe(samples.length);
  });

  it('spreads the guaranteed character classes over every position', () => {
    // If the first three characters were always lower/upper/digit, position 0 would never be a
    // capital. Over 500 samples every class shows up at position 0.
    const first = samples.map((password) => password[0]);
    expect(first.some((c) => /[a-z]/.test(c))).toBe(true);
    expect(first.some((c) => /[A-Z]/.test(c))).toBe(true);
    expect(first.some((c) => /\d/.test(c))).toBe(true);
  });

  it('refuses a length below the policy minimum', () => {
    expect(() => generateTemporaryPassword(8)).toThrow(RangeError);
    expect(generateTemporaryPassword(24)).toHaveLength(24);
  });
});

describe('STRONG_PASSWORD', () => {
  it.each([
    ['Str0ng-Passphrase!', true],
    ['DemoPassw0rd!2026', true],
    ['alllowercase-with-symbols', false],
    ['Short1!', false],
    ['NoDigitsButUpper-and-lower', true],
    ['lowercase123456', false],
    ['under_score_only1', false],
  ])('%s → %s', (password, ok) => {
    expect(STRONG_PASSWORD.test(password)).toBe(ok);
  });
});
