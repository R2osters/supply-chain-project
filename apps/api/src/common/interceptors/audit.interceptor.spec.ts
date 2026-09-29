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

  it('recurses into nested objects and arrays', () => {
    expect(redact({ feeds: [{ marineTrafficApiKey: 'k' }] })).toEqual({
      feeds: [{ marineTrafficApiKey: '[redacted]' }],
    });
  });
});
