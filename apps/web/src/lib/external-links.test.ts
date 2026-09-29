import { describe, expect, it } from 'vitest';
import { isExternalHref } from './external-links';

describe('isExternalHref', () => {
  const origin = 'http://tauri.localhost';

  it('treats other web origins as external', () => {
    expect(isExternalHref('https://aisstream.io', origin)).toBe(true);
    expect(isExternalHref('http://127.0.0.1:3001/api/v1/files?key=x', origin)).toBe(true);
  });

  it('keeps in-app routes and non-web schemes inside the app', () => {
    expect(isExternalHref('/settings', origin)).toBe(false);
    expect(isExternalHref('http://tauri.localhost/map', origin)).toBe(false);
    expect(isExternalHref('mailto:someone@example.com', origin)).toBe(false);
    expect(isExternalHref('javascript:void(0)', origin)).toBe(false);
  });
});
