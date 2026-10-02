import { describe, expect, it } from 'vitest';
import { shouldToast, updateView, type UpdateStatus } from './update-format';

const base = { current: '0.2.0', lastCheck: null, offline: false };

describe('updateView', () => {
  it('offers to install only a ready update', () => {
    const ready = updateView({ ...base, state: 'ready', version: '0.3.0', notes: 'x', pubDate: null });
    expect(ready).toMatchObject({ key: 'settings.update.ready', canInstall: true, params: { version: '0.3.0' } });
    expect(updateView({ ...base, state: 'upToDate' }).canInstall).toBe(false);
  });

  it('shows download progress as a whole percentage', () => {
    const view = updateView({ ...base, state: 'downloading', version: '0.3.0', received: 170_000_000, total: 340_000_000 });
    expect(view).toMatchObject({ percent: 50, canCheck: false, params: { percent: 50 } });
    expect(updateView({ ...base, state: 'downloading', version: '0.3.0', received: 5, total: 0 }).percent).toBe(0);
  });

  it('reads an unreachable GitHub as offline, not as an error', () => {
    expect(updateView({ ...base, state: 'idle', offline: true }).key).toBe('settings.update.offline');
    expect(updateView({ ...base, state: 'idle' }).key).toBe('settings.update.idle');
    expect(updateView({ ...base, state: 'error', message: 'signature invalide' })).toMatchObject({ tone: 'alert', params: { message: 'signature invalide' } });
  });

  it('never checks in a build without the publisher key', () => {
    expect(updateView({ ...base, state: 'disabled' }).canCheck).toBe(false);
  });

  it('says updates are manual on macOS and Linux, with nothing to check or install', () => {
    const view = updateView({ ...base, state: 'manual' });
    expect(view).toMatchObject({ key: 'settings.update.manual', tone: 'info', canCheck: false, canInstall: false });
  });
});

describe('shouldToast', () => {
  const ready: UpdateStatus = { ...base, state: 'ready', version: '0.3.0', notes: null, pubDate: null };

  it('announces each ready version once', () => {
    expect(shouldToast(ready, null)).toBe('0.3.0');
    expect(shouldToast(ready, '0.3.0')).toBeNull();
    expect(shouldToast({ ...ready, version: '0.3.1' }, '0.3.0')).toBe('0.3.1');
    expect(shouldToast({ ...base, state: 'checking' }, null)).toBeNull();
    expect(shouldToast(undefined, null)).toBeNull();
  });
});
