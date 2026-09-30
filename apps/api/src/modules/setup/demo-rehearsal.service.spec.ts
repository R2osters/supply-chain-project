import { ConflictException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { PrismaService } from '../../prisma/prisma.service';
import type { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import type { TelemetrySimulatorService } from '../jobs/telemetry-simulator.service';
import {
  DEFAULT_SPEED_KMH,
  DELAYED_PROMISE_MS,
  DemoRehearsalService,
  STAGED_TRACKING_NUMBERS,
  assignVehicles,
  stagedArrival,
  stagedRouteKm,
} from './demo-rehearsal.service';
import type { SetupService } from './setup.service';

const NOW = new Date('2026-09-30T14:00:00Z');
const HOUR = 3_600_000;

describe('STAGED_TRACKING_NUMBERS', () => {
  it('covers the seed shipments 0041 to 0055', () => {
    expect(STAGED_TRACKING_NUMBERS).toHaveLength(15);
    expect(STAGED_TRACKING_NUMBERS[0]).toBe('SHP-DEMO-0041');
    expect(STAGED_TRACKING_NUMBERS[14]).toBe('SHP-DEMO-0055');
  });
});

describe('stagedRouteKm', () => {
  it('measures the route polyline', () => {
    const polyline = [
      { latitude: 0, longitude: 0 },
      { latitude: 1, longitude: 0 },
    ];
    expect(stagedRouteKm({ polyline }, 999)).toBeCloseTo(111.2, 0);
  });

  it('falls back to the planned distance without a usable polyline', () => {
    expect(stagedRouteKm(null, 250)).toBe(250);
    expect(stagedRouteKm({ polyline: [{ latitude: 0, longitude: 0 }] }, 250)).toBe(250);
    expect(stagedRouteKm({ polyline: 'not a polyline' }, 250)).toBe(250);
  });
});

describe('stagedArrival', () => {
  it('plans the trip at the vehicle speed the ETA engine will assume, so it starts on time', () => {
    expect(stagedArrival(NOW, 100, 50, false).getTime()).toBe(NOW.getTime() + 2 * HOUR);
  });

  it(`uses ${DEFAULT_SPEED_KMH} km/h when the vehicle speed is unknown`, () => {
    expect(stagedArrival(NOW, 120, null, false).getTime()).toBe(NOW.getTime() + 2 * HOUR);
    expect(stagedArrival(NOW, 120, 0, false).getTime()).toBe(NOW.getTime() + 2 * HOUR);
  });

  it('promises the two late shipments in five minutes, whatever the distance', () => {
    expect(stagedArrival(NOW, 250, 50, true).getTime()).toBe(NOW.getTime() + DELAYED_PROMISE_MS);
    expect(DELAYED_PROMISE_MS).toBe(5 * 60_000);
  });
});

describe('assignVehicles', () => {
  const fleet = ['t1', 't2', 't3', 't4', 't5'];

  it('keeps each shipment on its own vehicle', () => {
    const plan = assignVehicles(
      [
        { id: 'a', vehicleId: 't1' },
        { id: 'b', vehicleId: 't2' },
      ],
      fleet,
      new Set(),
    );
    expect([...plan]).toEqual([
      ['a', 't1'],
      ['b', 't2'],
    ]);
  });

  it('gives a shipment that shares a vehicle a spare one, never one another shipment still needs', () => {
    // The seed puts 0054 on 0042's truck: the simulator would move one marker along two routes.
    const plan = assignVehicles(
      [
        { id: 'a', vehicleId: 't1' },
        { id: 'late', vehicleId: 't1' },
        { id: 'c', vehicleId: 't3' },
      ],
      fleet,
      new Set(),
    );
    expect(plan.get('a')).toBe('t1');
    expect(plan.get('late')).toBe('t2');
    expect(plan.get('c')).toBe('t3');
  });

  it('leaves vehicles busy on other trips alone', () => {
    const plan = assignVehicles([{ id: 'a', vehicleId: 't1' }], fleet, new Set(['t1', 't2']));
    expect(plan.get('a')).toBe('t3');
  });

  it('keeps the shared vehicle when no spare is left, rather than none', () => {
    const plan = assignVehicles(
      [
        { id: 'a', vehicleId: 't1' },
        { id: 'b', vehicleId: 't1' },
      ],
      ['t1'],
      new Set(),
    );
    expect(plan.get('b')).toBe('t1');
  });

  it('gives a vehicle to a shipment that had none, when one is spare', () => {
    expect(assignVehicles([{ id: 'a', vehicleId: null }], fleet, new Set()).get('a')).toBe('t1');
  });
});

describe('DemoRehearsalService guards', () => {
  const admin: AuthenticatedUser = {
    id: 'u1',
    email: 'admin@demo-scip.com',
    role: 'COMPANY_ADMIN',
    companyId: 'demo',
    linkedSupplierId: null,
    linkedCustomerId: null,
  } as AuthenticatedUser;

  function service(demoAccounts: boolean) {
    const transaction = jest.fn();
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ companyId: 'demo' }) },
      $transaction: transaction,
    } as unknown as PrismaService;
    const setup = { status: jest.fn().mockResolvedValue({ demoAccounts }) } as unknown as SetupService;
    const simulator = {
      pauseWhile: jest.fn((work: () => Promise<unknown>) => work()),
      forget: jest.fn(),
    } as unknown as TelemetrySimulatorService;
    const ledger = {} as InventoryLedgerService;
    return { rehearsal: new DemoRehearsalService(prisma, setup, simulator, ledger), transaction, simulator };
  }

  it('refuses on an install without the demo data set', async () => {
    const { rehearsal, transaction } = service(false);
    await expect(rehearsal.rehearse(admin)).rejects.toBeInstanceOf(ConflictException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses anyone but the demo company administrator', async () => {
    const { rehearsal, transaction, simulator } = service(true);
    await expect(rehearsal.rehearse({ ...admin, role: 'LOGISTICS_MANAGER' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(rehearsal.rehearse({ ...admin, companyId: 'another' })).rejects.toBeInstanceOf(ConflictException);
    await expect(rehearsal.rehearse({ ...admin, role: 'SUPER_ADMIN', companyId: null })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(simulator.forget).not.toHaveBeenCalled();
  });
});
