import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiUrl, wsUrl } from './runtime-config';

function fakeWindow(origin: string, stored: string | null): void {
  const url = new URL(origin);
  vi.stubGlobal('window', {
    location: { protocol: url.protocol, port: url.port, origin: url.origin },
    localStorage: { getItem: () => stored },
  });
}

describe('runtime config', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('prefers the address written by the desktop shell', () => {
    fakeWindow('http://tauri.localhost', JSON.stringify({ apiUrl: 'http://127.0.0.1:3001/api/v1', wsUrl: 'http://127.0.0.1:3001' }));
    expect(apiUrl()).toBe('http://127.0.0.1:3001/api/v1');
    expect(wsUrl()).toBe('http://127.0.0.1:3001');
  });

  it('uses the page origin when the API served the page (driver phone on the LAN)', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', undefined as unknown as string);
    fakeWindow('http://192.168.1.20:3001', null);
    expect(apiUrl()).toBe('http://192.168.1.20:3001/api/v1');
  });

  it('keeps the next dev default beside a UI on :3000', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', undefined as unknown as string);
    fakeWindow('http://localhost:3000', null);
    expect(apiUrl()).toBe('http://localhost:3001/api/v1');
  });

  it('ignores a malformed stored value', () => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', undefined as unknown as string);
    fakeWindow('http://localhost:3000', '{not json');
    expect(wsUrl()).toBe('http://localhost:3001');
  });
});
