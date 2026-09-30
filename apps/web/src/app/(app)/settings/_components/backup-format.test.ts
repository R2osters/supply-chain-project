import { describe, expect, it } from 'vitest';
import { desktopInvoke, formatBytes } from './backup-format';

describe('formatBytes', () => {
  it('uses decimal units with the locale separator', () => {
    expect(formatBytes(1_275_904, 'fr-FR').replace(/\s/g, ' ')).toBe('1,3 Mo');
    expect(formatBytes(1_275_904, 'en-GB')).toBe('1.3 MB');
    expect(formatBytes(512, 'en-GB')).toBe('512 B');
    expect(formatBytes(3_200_000_000, 'en-GB')).toBe('3.2 GB');
  });

  it('shows a dash for nonsense', () => {
    expect(formatBytes(Number.NaN, 'fr-FR')).toBe('—');
    expect(formatBytes(-1, 'fr-FR')).toBe('—');
  });
});

describe('desktopInvoke', () => {
  it('is null outside the SCIP window', () => {
    expect(desktopInvoke()).toBeNull();
  });
});
