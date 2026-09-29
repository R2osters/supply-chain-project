import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import type { AppConfig } from '../../config/configuration';
import { PASSWORD_CHANGE_REQUIRED } from '../../common/guards/password-change.guard';
import type { PrismaService } from '../../prisma/prisma.service';
import { TrackingGateway } from './tracking.gateway';

const SECRET = 'test-access-secret-0123456789abcdef0123456789';
const jwt = new JwtService();

interface Account {
  isActive: boolean;
  lockedUntil: Date | null;
  mustChangePassword: boolean;
  role: string;
  companyId: string | null;
}

const ACTIVE: Account = {
  isActive: true,
  lockedUntil: null,
  mustChangePassword: false,
  role: 'LOGISTICS_MANAGER',
  companyId: 'company-a',
};

function accessToken(claims: Record<string, unknown> = {}, secret = SECRET): string {
  return jwt.sign(
    { sub: 'user-1', email: 'u@acme.test', role: 'COMPANY_ADMIN', companyId: 'company-a', type: 'access', ...claims },
    { secret, algorithm: 'HS256', expiresIn: '5m' },
  );
}

function setup(account: Account | null | Error = ACTIVE) {
  const findUnique = jest.fn(async () => {
    if (account instanceof Error) throw account;
    return account;
  });
  const findFirst = jest.fn(async ({ where }: { where: { id: string; companyId?: string } }) =>
    where.id === 'shipment-a' && (where.companyId === undefined || where.companyId === 'company-a')
      ? { id: 'shipment-a' }
      : null,
  );
  const prisma = { user: { findUnique }, shipment: { findFirst } } as unknown as PrismaService;
  const config = { get: () => ({ accessSecret: SECRET }) } as unknown as ConfigService<AppConfig, true>;
  return { gateway: new TrackingGateway(jwt, config, prisma), findUnique, findFirst };
}

function fakeSocket(token?: string) {
  const emitted: Array<{ event: string; body: unknown }> = [];
  const rooms: string[] = [];
  const state = {
    id: 'socket-1',
    handshake: { auth: token ? { token } : {}, headers: {} },
    data: {} as Record<string, unknown>,
    disconnected: false,
    emit(event: string, body: unknown) {
      emitted.push({ event, body });
      return true;
    },
    async join(room: string) {
      rooms.push(room);
    },
    disconnect() {
      state.disconnected = true;
    },
  };
  return { socket: state as unknown as Socket, state, emitted, rooms };
}

describe('TrackingGateway handshake', () => {
  it('refuses a socket without a token', async () => {
    const { gateway, findUnique } = setup();
    const client = fakeSocket();
    await gateway.handleConnection(client.socket);
    expect(client.state.disconnected).toBe(true);
    expect(client.rooms).toEqual([]);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('puts an active account allowed to read the fleet into its company room', async () => {
    const { gateway } = setup();
    const client = fakeSocket(accessToken());
    await gateway.handleConnection(client.socket);
    expect(client.state.disconnected).toBe(false);
    expect(client.rooms).toEqual(['company:company-a']);
    expect(client.emitted).toEqual([{ event: 'connected', body: { userId: 'user-1', companyId: 'company-a' } }]);
  });

  it('refuses a deactivated account although its token is still valid', async () => {
    const { gateway } = setup({ ...ACTIVE, isActive: false });
    const client = fakeSocket(accessToken());
    await gateway.handleConnection(client.socket);
    expect(client.state.disconnected).toBe(true);
    expect(client.rooms).toEqual([]);
    expect(client.emitted[0]?.body).toEqual({ message: 'Invalid or expired access token' });
  });

  it('refuses an account that no longer exists', async () => {
    const { gateway } = setup(null);
    const client = fakeSocket(accessToken());
    await gateway.handleConnection(client.socket);
    expect(client.state.disconnected).toBe(true);
    expect(client.rooms).toEqual([]);
  });

  it('refuses a locked account', async () => {
    const { gateway } = setup({ ...ACTIVE, lockedUntil: new Date(Date.now() + 60_000) });
    const client = fakeSocket(accessToken());
    await gateway.handleConnection(client.socket);
    expect(client.state.disconnected).toBe(true);
    expect(client.rooms).toEqual([]);
  });

  it('refuses an account that must replace its temporary password, with the code clients react to', async () => {
    const { gateway } = setup({ ...ACTIVE, mustChangePassword: true });
    const client = fakeSocket(accessToken());
    await gateway.handleConnection(client.socket);
    expect(client.state.disconnected).toBe(true);
    expect(client.rooms).toEqual([]);
    expect(client.emitted[0]?.body).toMatchObject({ code: PASSWORD_CHANGE_REQUIRED });
  });

  it('refuses customers and suppliers: GET /gps/fleet does not show them the fleet either', async () => {
    for (const role of ['CUSTOMER', 'SUPPLIER']) {
      const { gateway } = setup({ ...ACTIVE, role });
      const client = fakeSocket(accessToken({ role }));
      await gateway.handleConnection(client.socket);
      expect(client.state.disconnected).toBe(true);
      expect(client.rooms).toEqual([]);
    }
  });

  it('trusts the stored role and company over the claims of an older token', async () => {
    // The token still says COMPANY_ADMIN of company-a; the account has since been downgraded.
    const downgraded = setup({ ...ACTIVE, role: 'CUSTOMER' });
    const refused = fakeSocket(accessToken());
    await downgraded.gateway.handleConnection(refused.socket);
    expect(refused.rooms).toEqual([]);

    const moved = setup({ ...ACTIVE, companyId: 'company-b' });
    const client = fakeSocket(accessToken());
    await moved.gateway.handleConnection(client.socket);
    expect(client.rooms).toEqual(['company:company-b']);
  });

  it('refuses a refresh token and a token signed with another secret', async () => {
    const { gateway, findUnique } = setup();
    for (const token of [accessToken({ type: 'refresh' }), accessToken({}, 'another-secret-0123456789abcdef0123456789')]) {
      const client = fakeSocket(token);
      await gateway.handleConnection(client.socket);
      expect(client.state.disconnected).toBe(true);
      expect(client.rooms).toEqual([]);
    }
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('refuses, without crashing, when the account cannot be read', async () => {
    const { gateway } = setup(new Error('connection refused'));
    const client = fakeSocket(accessToken());
    await expect(gateway.handleConnection(client.socket)).resolves.toBeUndefined();
    expect(client.state.disconnected).toBe(true);
    expect(client.rooms).toEqual([]);
  });

  it('joins nothing when the browser left while the account was being read', async () => {
    const { gateway, findUnique } = setup();
    const client = fakeSocket(accessToken());
    findUnique.mockImplementationOnce(async () => {
      client.state.disconnected = true;
      return ACTIVE;
    });
    await gateway.handleConnection(client.socket);
    expect(client.rooms).toEqual([]);
    expect(client.emitted).toEqual([]);
  });
});

describe('TrackingGateway shipment subscription', () => {
  async function connected(account: Account = ACTIVE) {
    const context = setup(account);
    const client = fakeSocket(accessToken());
    await context.gateway.handleConnection(client.socket);
    return { ...context, client };
  }

  it('lets a socket follow a shipment of its own company', async () => {
    const { gateway, client } = await connected();
    await expect(gateway.subscribeShipment(client.socket, { shipmentId: 'shipment-a' })).resolves.toEqual({
      ok: true,
      room: 'shipment:shipment-a',
    });
    expect(client.rooms).toContain('shipment:shipment-a');
  });

  it("refuses another company's shipment with the same answer as a missing one", async () => {
    const { gateway, client, findFirst } = await connected({ ...ACTIVE, companyId: 'company-b' });
    const answer = await gateway.subscribeShipment(client.socket, { shipmentId: 'shipment-a' });
    expect(answer).toEqual({ ok: false, error: 'Shipment not found' });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'shipment-a', companyId: 'company-b' } }));
    expect(client.rooms).not.toContain('shipment:shipment-a');
  });

  it('refuses a subscription sent before the handshake finished', async () => {
    const { gateway, findFirst } = setup();
    const client = fakeSocket(accessToken());
    const answer = await gateway.subscribeShipment(client.socket, { shipmentId: 'shipment-a' });
    expect(answer).toEqual({ ok: false, error: 'Not authenticated' });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('requires a shipment id', async () => {
    const { gateway, client } = await connected();
    await expect(gateway.subscribeShipment(client.socket, {})).resolves.toEqual({
      ok: false,
      error: 'shipmentId is required',
    });
  });
});
