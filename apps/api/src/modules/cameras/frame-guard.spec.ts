import type { CameraPack } from './camera.types';
import { isAcceptableFrameContentType, parseCameraId, resolveFrameUrl, sniffImageType } from './frame-guard';
import { headingFromDirection, toSafeId } from './packs/normalize-helpers';

const pack = (overrides: Partial<CameraPack> = {}): CameraPack => ({
  id: 'test',
  label: 'Test',
  attribution: 'Test',
  licence: 'Test',
  catalogUrl: 'https://catalog.example/list',
  refreshSeconds: 60,
  frameHosts: ['frames.example'],
  normalize: () => [],
  ...overrides,
});

describe('resolveFrameUrl', () => {
  it('accepts an https URL on an allowed host', () => {
    expect(resolveFrameUrl(pack(), 'https://frames.example/a.jpg')?.toString()).toBe(
      'https://frames.example/a.jpg',
    );
  });

  it.each([
    ['plain http', 'http://frames.example/a.jpg'],
    ['another host', 'https://metadata.google.internal/a.jpg'],
    ['a look-alike host', 'https://frames.example.evil.test/a.jpg'],
    ['a link-local address', 'https://169.254.169.254/latest/meta-data'],
    ['a non-default port', 'https://frames.example:8443/a.jpg'],
    ['credentials', 'https://user:pw@frames.example/a.jpg'],
    ['another scheme', 'file:///etc/passwd'],
    ['garbage', 'not a url'],
  ])('refuses %s', (_label, url) => {
    expect(resolveFrameUrl(pack(), url)).toBeNull();
  });

  it('upgrades http only for packs documented to redirect to https', () => {
    expect(resolveFrameUrl(pack({ upgradeHttpFrames: true }), 'http://frames.example/a.jpg')?.protocol).toBe(
      'https:',
    );
  });

  it('enforces the path prefix on shared hosts', () => {
    const s3 = pack({ frameHosts: ['s3.example'], framePathPrefix: '/our-bucket/' });
    expect(resolveFrameUrl(s3, 'https://s3.example/our-bucket/a.jpg')).not.toBeNull();
    expect(resolveFrameUrl(s3, 'https://s3.example/their-bucket/a.jpg')).toBeNull();
  });
});

describe('sniffImageType', () => {
  it('recognises JPEG and PNG by their magic bytes', () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe('image/png');
  });

  it('rejects an HTML placeholder served with status 200', () => {
    expect(sniffImageType(Buffer.from('<html>please use a browser</html>'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('isAcceptableFrameContentType', () => {
  it('lets images and unlabelled bytes through, refuses text', () => {
    expect(isAcceptableFrameContentType('image/jpeg')).toBe(true);
    expect(isAcceptableFrameContentType('application/octet-stream')).toBe(true);
    expect(isAcceptableFrameContentType('text/html; charset=utf-8')).toBe(false);
  });
});

describe('parseCameraId', () => {
  it('splits a pack-prefixed id', () => {
    expect(parseCameraId('tfl:00002.00865')).toEqual({ pack: 'tfl', upstreamId: '00002.00865' });
  });

  it.each(['tfl', 'tfl:', ':x', 'tfl:a/b', 'tfl:https://evil', 'TFL:1'])('refuses %s', (id) => {
    expect(parseCameraId(id)).toBeNull();
  });
});

describe('normalize helpers', () => {
  it('reads compass codes and travel words as bearings', () => {
    expect(headingFromDirection('N-W')).toBe(315);
    expect(headingFromDirection('Westbound')).toBe(270);
    expect(headingFromDirection('SSE')).toBe(157.5);
    expect(headingFromDirection('Toronto Bound')).toBeNull();
    expect(headingFromDirection(null)).toBeNull();
  });

  it('refuses ids that are not URL-safe instead of rewriting them', () => {
    expect(toSafeId(' C0150301 ')).toBe('C0150301');
    expect(toSafeId('a b')).toBeNull();
    expect(toSafeId('../x')).toBeNull();
  });
});
