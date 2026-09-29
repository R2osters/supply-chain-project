import { redact } from './audit.interceptor';

describe('redact', () => {
  it('hides exact credential fields', () => {
    expect(redact({ password: 'p', token: 't', note: 'kept' })).toEqual({
      password: '[redacted]',
      token: '[redacted]',
      note: 'kept',
    });
  });

  it('hides fields whose name ends in a credential word', () => {
    expect(
      redact({ aisStreamApiKey: 'k', openskyClientSecret: 's', refreshToken: 'r', openskyClientId: 'id' }),
    ).toEqual({
      aisStreamApiKey: '[redacted]',
      openskyClientSecret: '[redacted]',
      refreshToken: '[redacted]',
      openskyClientId: 'id',
    });
  });

  it('hides the temporary password an administrator may choose for a new account', () => {
    // POST /users accepts `temporaryPassword`; the audit trail records request bodies.
    expect(
      redact({ email: 'kofi@acme.test', role: 'DRIVER', temporaryPassword: 'Chosen-Passw0rd', TemporaryPassword: 'x' }),
    ).toEqual({
      email: 'kofi@acme.test',
      role: 'DRIVER',
      temporaryPassword: '[redacted]',
      TemporaryPassword: '[redacted]',
    });
    expect(redact({ currentPassword: 'a', newPassword: 'b', localRecoveryToken: 'c' })).toEqual({
      currentPassword: '[redacted]',
      newPassword: '[redacted]',
      localRecoveryToken: '[redacted]',
    });
  });

  it('recurses into nested objects and arrays', () => {
    expect(redact({ feeds: [{ marineTrafficApiKey: 'k' }] })).toEqual({
      feeds: [{ marineTrafficApiKey: '[redacted]' }],
    });
  });
});
