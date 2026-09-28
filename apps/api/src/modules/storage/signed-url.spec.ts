import { isValidStorageKey, signStorageKey, verifyStorageSignature } from './signed-url';

const SECRET = 'test-secret';
const KEY = 'company_1/delivery-2/photo-3f2b8c1e-9d4a-4c1b-8e2f-0a1b2c3d4e5f.png';
const NOW = 1_800_000_000;

describe('signed storage links', () => {
  it('accepts a link it signed, before expiry', () => {
    const signature = signStorageKey(SECRET, KEY, NOW + 60);
    expect(verifyStorageSignature(SECRET, KEY, NOW + 60, signature, NOW)).toBe(true);
  });

  it('refuses an expired link', () => {
    const signature = signStorageKey(SECRET, KEY, NOW - 1);
    expect(verifyStorageSignature(SECRET, KEY, NOW - 1, signature, NOW)).toBe(false);
  });

  it('refuses a link whose expiry was extended', () => {
    const signature = signStorageKey(SECRET, KEY, NOW + 60);
    expect(verifyStorageSignature(SECRET, KEY, NOW + 99_999, signature, NOW)).toBe(false);
  });

  it('refuses a signature reused for another key', () => {
    const signature = signStorageKey(SECRET, KEY, NOW + 60);
    const other = KEY.replace('photo', 'signature');
    expect(verifyStorageSignature(SECRET, other, NOW + 60, signature, NOW)).toBe(false);
  });

  it('refuses a signature made with another secret', () => {
    const signature = signStorageKey('other-secret', KEY, NOW + 60);
    expect(verifyStorageSignature(SECRET, KEY, NOW + 60, signature, NOW)).toBe(false);
  });

  it('accepts only keys shaped like the ones the service generates', () => {
    expect(isValidStorageKey(KEY)).toBe(true);
    expect(isValidStorageKey('../../Windows/system.ini')).toBe(false);
    expect(isValidStorageKey('company_1/../photo-3f2b8c1e-9d4a-4c1b-8e2f-0a1b2c3d4e5f.png')).toBe(false);
    expect(isValidStorageKey('C:/secrets.txt')).toBe(false);
  });
});
