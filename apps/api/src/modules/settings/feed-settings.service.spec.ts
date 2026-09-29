import type { ConfigService } from '@nestjs/config';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../../config/configuration';
import { FeedSettingsService } from './feed-settings.service';

function makeService(file: string, env: { ais?: string; tomtom?: string } = {}, bundledFile: string | null = null) {
  const sections: Record<string, unknown> = {
    settings: { file, bundledFile },
    maritime: { aisStreamApiKey: env.ais ?? null, marineTrafficApiKey: null },
    aircraft: { openskyClientId: null, openskyClientSecret: null },
    intel: { tomtomApiKey: env.tomtom ?? null, firmsMapKey: null },
  };
  const config = { get: (name: string) => sections[name] } as unknown as ConfigService<AppConfig, true>;
  return new FeedSettingsService(config);
}

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'scip-settings-')), 'settings.json');

describe('FeedSettingsService', () => {
  it('lets a key entered in the app override the environment, and persists it', () => {
    const file = tempFile();
    const service = makeService(file, { ais: 'env-key-0000' });
    expect(service.get('aisStreamApiKey')).toBe('env-key-0000');

    service.update({ aisStreamApiKey: '  typed-key-1234 ' });
    expect(service.get('aisStreamApiKey')).toBe('typed-key-1234');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ aisStreamApiKey: 'typed-key-1234' });
    // A fresh instance (next launch) reads it back.
    expect(makeService(file).get('aisStreamApiKey')).toBe('typed-key-1234');
  });

  it('never exposes values, only where they come from and a four-character hint', () => {
    const service = makeService(tempFile(), { tomtom: 'tomtom-secret-9f3a' });
    expect(service.describe().tomtomApiKey).toEqual({ configured: true, from: 'environment', hint: '••••9f3a' });
    expect(service.describe().aisStreamApiKey).toEqual({ configured: false, from: null, hint: null });
  });

  it('clears a key with null or blank and falls back to the environment', () => {
    const service = makeService(tempFile(), { ais: 'env-key-0000' });
    service.update({ aisStreamApiKey: 'typed' });
    service.update({ aisStreamApiKey: '' });
    expect(service.get('aisStreamApiKey')).toBe('env-key-0000');
  });

  it('notifies feeds of changed keys only', () => {
    const service = makeService(tempFile());
    const seen: string[][] = [];
    service.onChange((changed) => seen.push(changed));
    service.update({ openskyClientId: 'id', openskyClientSecret: 'secret' });
    service.update({ openskyClientId: 'id' });
    expect(seen).toEqual([['openskyClientId', 'openskyClientSecret']]);
  });

  it('survives a corrupt settings file', () => {
    const file = tempFile();
    writeFileSync(file, '{not json');
    expect(makeService(file).get('aisStreamApiKey')).toBeNull();
  });

  it('uses keys bundled in the build when nothing else sets them, lowest precedence', () => {
    const bundled = tempFile();
    writeFileSync(bundled, JSON.stringify({ aisStreamApiKey: 'bundled-ais-1111', tomtomApiKey: 'bundled-tt-2222' }));
    const service = makeService(tempFile(), { tomtom: 'env-tomtom-3333' }, bundled);
    expect(service.get('aisStreamApiKey')).toBe('bundled-ais-1111');
    expect(service.describe().aisStreamApiKey).toEqual({ configured: true, from: 'bundled', hint: '••••1111' });
    // The environment beats the bundled key, and a key typed in the app beats both.
    expect(service.get('tomtomApiKey')).toBe('env-tomtom-3333');
    service.update({ aisStreamApiKey: 'typed-4444' });
    expect(service.get('aisStreamApiKey')).toBe('typed-4444');
    // Clearing the typed key falls back to the bundled one, not to nothing.
    service.update({ aisStreamApiKey: null });
    expect(service.get('aisStreamApiKey')).toBe('bundled-ais-1111');
  });
});
