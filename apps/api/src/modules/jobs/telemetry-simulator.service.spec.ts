import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import type { PrismaService } from '../../prisma/prisma.service';
import type { TrackingGateway } from '../gps/tracking.gateway';
import type { ShipmentsService } from '../shipments/shipments.service';
import { MAX_CRUISE_KMH, TelemetrySimulatorService, cruiseSpeedKmh } from './telemetry-simulator.service';

describe('cruiseSpeedKmh', () => {
  it('follows the planned pace', () => {
    expect(cruiseSpeedKmh(250, 5)).toBe(50);
  });

  it('never drives faster than a truck can, even to keep an impossible promise', () => {
    // The demo rehearsal promises 250 km in five minutes: 3 000 km/h taken literally.
    expect(cruiseSpeedKmh(250, 5 / 60)).toBe(MAX_CRUISE_KMH);
  });

  it('uses a default pace without a planned window', () => {
    expect(cruiseSpeedKmh(250, 0)).toBe(55);
    expect(cruiseSpeedKmh(250, -1)).toBe(55);
  });
});

describe('TelemetrySimulatorService.pauseWhile', () => {
  function simulator() {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { shipment: { findMany } } as unknown as PrismaService;
    const config = {
      get: () => ({ enabled: true, tickMs: 5000, speedMultiplier: 12 }),
    } as unknown as ConfigService<AppConfig, true>;
    const service = new TelemetrySimulatorService(
      prisma,
      {} as ShipmentsService,
      {} as TrackingGateway,
      config,
    );
    return { service, findMany };
  }

  it('skips ticks while work is running, and ticks again afterwards', async () => {
    const { service, findMany } = simulator();
    await service.pauseWhile(async () => {
      await service.tick();
    });
    expect(findMany).not.toHaveBeenCalled();
    await service.tick();
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('waits for a tick already in flight before running the work', async () => {
    const { service, findMany } = simulator();
    let release: (value: unknown[]) => void = () => undefined;
    findMany.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const order: string[] = [];

    const tick = service.tick().then(() => order.push('tick done'));
    const work = service.pauseWhile(async () => {
      order.push('work');
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(order).toEqual([]);

    release([]);
    await Promise.all([tick, work]);
    expect(order).toEqual(['tick done', 'work']);
  });

  it('returns what the work returns and releases the pause when it throws', async () => {
    const { service, findMany } = simulator();
    await expect(service.pauseWhile(async () => 42)).resolves.toBe(42);
    await expect(
      service.pauseWhile(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await service.tick();
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
