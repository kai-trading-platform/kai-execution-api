import { QueryService } from './query.service';
import type { BrokerCapabilities } from './core/types';

const MT5_CAPABILITIES: BrokerCapabilities = {
  listAccounts: true,
  listPositions: true,
  placeMarketOrder: true,
  closePosition: true,
  updateStops: true,
};

const mt5Adapter = {
  provider: 'mt5' as const,
  capabilities: MT5_CAPABILITIES,
};

function buildRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acc-1',
    userId: 'user-1',
    mt5AccountId: '500123',
    accountName: 'Demo CFD',
    server: 'MetaQuotes-Demo',
    connectionStatus: 'connected',
    accountType: 'demo',
    isDefault: true,
    balance: 10000,
    equity: 10250,
    bridgeInstance: 1,
    customComment: null,
    customMagicNumber: null,
    ...overrides,
  };
}

describe('QueryService.listAccounts', () => {
  const USER_ID = 'user-1';

  function makeService(options: {
    rows: Array<Record<string, unknown>>;
    providerRows: Array<{ id: string; provider: string }>;
  }) {
    const prisma = {
      mt5Account: {
        findMany: jest.fn().mockResolvedValue(options.rows),
      },
      $queryRaw: jest.fn().mockResolvedValue(options.providerRows),
    };
    const brokerRegistry = {
      has: jest.fn((provider: string) => provider === 'mt5'),
      get: jest.fn((provider: string) => {
        if (provider === 'mt5') return mt5Adapter;
        throw new Error(`not registered: ${provider}`);
      }),
    };
    const service = new QueryService(
      prisma as never,
      brokerRegistry as never,
    );
    return { service, prisma, brokerRegistry };
  }

  it('returns both MT5 and Rithmic accounts stamped with the correct provider', async () => {
    const mt5Row = buildRow({ id: 'acc-mt5', accountName: 'Demo CFD' });
    const rithmicRow = buildRow({
      id: 'acc-rithmic',
      accountName: 'Apex Futures',
      mt5AccountId: 'APEX-1',
      isDefault: false,
    });
    const { service } = makeService({
      rows: [mt5Row, rithmicRow],
      providerRows: [
        { id: 'acc-mt5', provider: 'mt5' },
        { id: 'acc-rithmic', provider: 'rithmic' },
      ],
    });

    const result = await service.listAccounts(USER_ID);

    expect(result).toHaveLength(2);
    const byId = Object.fromEntries(result.map((a) => [a.id, a]));
    expect(byId['acc-mt5'].provider).toBe('mt5');
    expect(byId['acc-rithmic'].provider).toBe('rithmic');
  });

  it('keeps the MT5 account shape and capabilities unchanged', async () => {
    const { service } = makeService({
      rows: [buildRow({ id: 'acc-mt5' })],
      providerRows: [{ id: 'acc-mt5', provider: 'mt5' }],
    });

    const [account] = await service.listAccounts(USER_ID);

    expect(account).toEqual({
      id: 'acc-mt5',
      provider: 'mt5',
      providerAccountId: '500123',
      name: 'Demo CFD',
      server: 'MetaQuotes-Demo',
      status: 'connected',
      accountType: 'demo',
      isDefault: true,
      balance: 10000,
      equity: 10250,
      capabilities: {
        listAccounts: true,
        listPositions: true,
        placeMarketOrder: true,
        closePosition: true,
        updateStops: true,
      },
    });
  });

  it('exposes Rithmic accounts read-only (no adapter registered yet)', async () => {
    const { service, brokerRegistry } = makeService({
      rows: [buildRow({ id: 'acc-rithmic', mt5AccountId: 'APEX-1' })],
      providerRows: [{ id: 'acc-rithmic', provider: 'rithmic' }],
    });

    const [account] = await service.listAccounts(USER_ID);

    expect(account.provider).toBe('rithmic');
    expect(account.capabilities).toEqual({
      listAccounts: false,
      listPositions: false,
      placeMarketOrder: false,
      closePosition: false,
      updateStops: false,
    });
    // Never resolves an adapter for an unregistered provider.
    expect(brokerRegistry.get).not.toHaveBeenCalledWith('rithmic');
  });

  it('defaults to mt5 when the provider column is missing/unknown', async () => {
    const { service } = makeService({
      rows: [buildRow({ id: 'acc-x' })],
      providerRows: [{ id: 'acc-x', provider: 'something-else' }],
    });

    const [account] = await service.listAccounts(USER_ID);
    expect(account.provider).toBe('mt5');
  });

  it('scopes the provider lookup to the authenticated user', async () => {
    const { service, prisma } = makeService({
      rows: [buildRow()],
      providerRows: [{ id: 'acc-1', provider: 'mt5' }],
    });

    await service.listAccounts(USER_ID);

    expect(prisma.mt5Account.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
    // Raw provider query is parameterized with the same userId (tagged template).
    const rawArgs = prisma.$queryRaw.mock.calls[0];
    expect(rawArgs).toEqual(expect.arrayContaining([USER_ID]));
  });
});
