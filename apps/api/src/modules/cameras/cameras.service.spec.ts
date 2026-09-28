import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import type { CameraUpstream } from './camera-upstream';
import type { CameraPack } from './camera.types';
import { CamerasService } from './cameras.service';

// Two cameras in London ~2.5 km apart, one in Calgary.
const TFL_CATALOG = [
  {
    id: 'JamCams_00001.01251',
    commonName: 'Trafalgar Sq',
    lat: 51.508,
    lon: -0.128,
    additionalProperties: [
      { key: 'available', value: 'true' },
      { key: 'imageUrl', value: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.01251.jpg' },
    ],
  },
  {
    id: 'JamCams_00001.02000',
    commonName: 'Tower Bridge',
    lat: 51.5055,
    lon: -0.0754,
    additionalProperties: [
      { key: 'available', value: 'true' },
      { key: 'imageUrl', value: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.02000.jpg' },
    ],
  },
];

const CALGARY_CATALOG = [
  {
    camera_url: { url: 'http://trafficcam.calgary.ca/loc86.jpg' },
    camera_location: 'Stoney Trail / Deerfoot Trail SE',
    point: { coordinates: [-113.9766063, 50.9007257] },
  },
];

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

class FakeUpstream implements CameraUpstream {
  catalogs: Record<string, unknown> = { tfl: TFL_CATALOG, calgary: CALGARY_CATALOG };
  failing = new Set<string>();
  frameBytes: Buffer = JPEG;
  catalogCalls = 0;
  frameCalls: string[] = [];

  async fetchCatalog(pack: CameraPack): Promise<unknown> {
    this.catalogCalls += 1;
    if (this.failing.has(pack.id)) throw new Error(`${pack.id} down`);
    return this.catalogs[pack.id] ?? [];
  }

  async fetchFrame(url: URL): Promise<Buffer> {
    this.frameCalls.push(url.toString());
    return this.frameBytes;
  }
}

function build(packs: string[] = ['tfl', 'calgary', 'nsw']) {
  const config = {
    get: () => ({ cameraPacks: packs }),
  } as unknown as ConfigService<AppConfig, true>;
  const upstream = new FakeUpstream();
  // NSW has no fixture, so its normaliser yields nothing and the pack is UNAVAILABLE.
  return { service: new CamerasService(config, upstream), upstream };
}

describe('CamerasService — listing', () => {
  it('returns cameras inside the box with public fields only, plus a status per pack', async () => {
    const { service } = build();
    const result = await service.listInBoundingBox({ minLat: 51.4, minLon: -0.3, maxLat: 51.6, maxLon: 0.1 });

    expect(result.cameras.map((camera) => camera.id).sort()).toEqual(['tfl:00001.01251', 'tfl:00001.02000']);
    const camera = result.cameras[0];
    expect(Object.keys(camera).sort()).toEqual(
      ['attribution', 'direction', 'headingDegrees', 'id', 'latitude', 'longitude', 'name', 'pack', 'refreshSeconds'].sort(),
    );
    expect(JSON.stringify(result)).not.toContain('amazonaws');

    const statuses = Object.fromEntries(result.packs.map((pack) => [pack.id, pack.status]));
    expect(statuses).toEqual({ tfl: 'OK', calgary: 'OK', nsw: 'UNAVAILABLE' });
    expect(result.packs.find((pack) => pack.id === 'nsw')).toMatchObject({ count: 0, fetchedAt: null });
  });

  it('keeps the other packs when one fails', async () => {
    const { service, upstream } = build(['tfl', 'calgary']);
    upstream.failing.add('tfl');
    const result = await service.listInBoundingBox({});
    expect(result.cameras.map((camera) => camera.pack)).toEqual(['calgary']);
    expect(result.packs.map((pack) => pack.status)).toEqual(['UNAVAILABLE', 'OK']);
  });

  it('refuses a half-specified box', async () => {
    const { service } = build();
    await expect(service.listInBoundingBox({ minLat: 1 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('applies the limit', async () => {
    const { service } = build();
    const result = await service.listInBoundingBox({ limit: 1 });
    expect(result.cameras).toHaveLength(1);
  });

  it('sorts near results by distance and filters by radius', async () => {
    const { service } = build();
    const result = await service.listNear({ lat: 51.5074, lon: -0.1278, radiusKm: 10 });
    expect(result.cameras.map((camera) => camera.id)).toEqual(['tfl:00001.01251', 'tfl:00001.02000']);
    expect(result.cameras[0].distanceKm).toBeLessThan(0.2);
    expect(result.cameras[1].distanceKm).toBeGreaterThan(3);

    const tight = await service.listNear({ lat: 51.5074, lon: -0.1278, radiusKm: 1 });
    expect(tight.cameras).toHaveLength(1);
  });

  it('loads each catalogue once while it is fresh', async () => {
    const { service, upstream } = build(['tfl']);
    await service.listInBoundingBox({});
    await service.listNear({ lat: 51.5, lon: -0.1 });
    expect(upstream.catalogCalls).toBe(1);
  });

  it('ignores unknown pack ids from configuration', async () => {
    const { service } = build(['tfl', 'nope']);
    const result = await service.listInBoundingBox({});
    expect(result.packs.map((pack) => pack.id)).toEqual(['tfl']);
  });
});

describe('CamerasService — single camera and frame', () => {
  it('finds a camera by id and 404s on unknown or malformed ids', async () => {
    const { service } = build();
    await expect(service.getCamera('calgary:86')).resolves.toMatchObject({ name: 'Stoney Trail / Deerfoot Trail SE' });
    await expect(service.getCamera('calgary:999')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getCamera('ontario511:1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getCamera('https://evil.example/x.jpg')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('fetches the registered URL, upgraded to https, and types it from the bytes', async () => {
    const { service, upstream } = build();
    const frame = await service.getFrame('calgary:86');
    expect(frame.contentType).toBe('image/jpeg');
    expect(upstream.frameCalls).toEqual(['https://trafficcam.calgary.ca/loc86.jpg']);
  });

  it('serves concurrent and repeated viewers of one camera from one upstream fetch', async () => {
    const { service, upstream } = build();
    await Promise.all([service.getFrame('tfl:00001.01251'), service.getFrame('tfl:00001.01251')]);
    await service.getFrame('tfl:00001.01251');
    expect(upstream.frameCalls).toHaveLength(1);
  });

  it('answers 502 when the upstream returns something that is not an image', async () => {
    const { service, upstream } = build();
    upstream.frameBytes = Buffer.from('<html>blocked</html>');
    await expect(service.getFrame('tfl:00001.02000')).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('never fetches a registered URL that fails the pack allow-list', async () => {
    const { service, upstream } = build(['tfl']);
    // Simulate a normaliser bug letting a foreign URL into the registry.
    const tfl = (service as unknown as { packs: CameraPack[] }).packs[0];
    const original = tfl.normalize;
    tfl.normalize = (raw) =>
      original(raw).map((record) => ({ ...record, frameUrl: 'https://169.254.169.254/latest/meta-data' }));
    try {
      await expect(service.getFrame('tfl:00001.01251')).rejects.toBeInstanceOf(BadGatewayException);
      expect(upstream.frameCalls).toEqual([]);
    } finally {
      tfl.normalize = original;
    }
  });
});
