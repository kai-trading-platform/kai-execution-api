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
    // Rows returned by the second $queryRaw call (getMaxContractsMap's
    // `system_configs` lookup). Defaults to none (no cap configured for
    // any account) so existing tests that don't care about caps keep
    // asserting on an unchanged MT5/Rithmic shape.
    configRows?: Array<{ key: string; value: unknown }>;
  }) {
    let queryRawCallCount = 0;
    const prisma = {
      mt5Account: {
        findMany: jest.fn().mockResolvedValue(options.rows),
      },
      // getProviderMap is always called first in listAccounts, followed by
      // getMaxContractsMap — mirror that ordering so each raw query gets its
      // own canned rows instead of both reading the same mocked value.
      $queryRaw: jest.fn(() => {
        queryRawCallCount += 1;
        if (queryRawCallCount === 1) {
          return Promise.resolve(options.providerRows);
        }
        return Promise.resolve(options.configRows ?? []);
      }),
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
        flattenAll: false,
        cancelAllOrders: false,
        reversePosition: false,
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

  it('stamps maxContracts when a system_configs cap key exists for the account UUID', async () => {
    const { service } = makeService({
      rows: [buildRow({ id: 'acc-mt5' })],
      providerRows: [{ id: 'acc-mt5', provider: 'mt5' }],
      configRows: [{ key: 'autotrading:maxContracts:acc-mt5', value: '1' }],
    });

    const [account] = await service.listAccounts(USER_ID);

    expect(account.maxContracts).toBe(1);
  });

  it('falls back to the broker login/ref key when the UUID key is absent', async () => {
    const { service } = makeService({
      rows: [buildRow({ id: 'acc-rithmic', mt5AccountId: 'APEX-1' })],
      providerRows: [{ id: 'acc-rithmic', provider: 'rithmic' }],
      configRows: [{ key: 'autotrading:maxContracts:APEX-1', value: '2' }],
    });

    const [account] = await service.listAccounts(USER_ID);

    expect(account.maxContracts).toBe(2);
  });

  it('prefers the account UUID cap key over the broker login/ref key', async () => {
    const { service } = makeService({
      rows: [buildRow({ id: 'acc-rithmic', mt5AccountId: 'APEX-1' })],
      providerRows: [{ id: 'acc-rithmic', provider: 'rithmic' }],
      configRows: [
        { key: 'autotrading:maxContracts:acc-rithmic', value: '1' },
        { key: 'autotrading:maxContracts:APEX-1', value: '5' },
      ],
    });

    const [account] = await service.listAccounts(USER_ID);

    expect(account.maxContracts).toBe(1);
  });

  it('leaves maxContracts undefined (no cap) and the MT5 shape otherwise unchanged when no cap key exists', async () => {
    const { service } = makeService({
      rows: [buildRow({ id: 'acc-mt5' })],
      providerRows: [{ id: 'acc-mt5', provider: 'mt5' }],
      configRows: [],
    });

    const [account] = await service.listAccounts(USER_ID);

    expect(account.maxContracts).toBeUndefined();
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
        flattenAll: false,
        cancelAllOrders: false,
        reversePosition: false,
      },
    });
  });

  it('ignores a non-positive or unparseable cap value (treated as no cap)', async () => {
    const { service } = makeService({
      rows: [buildRow({ id: 'acc-mt5' })],
      providerRows: [{ id: 'acc-mt5', provider: 'mt5' }],
      configRows: [{ key: 'autotrading:maxContracts:acc-mt5', value: '0' }],
    });

    const [account] = await service.listAccounts(USER_ID);

    expect(account.maxContracts).toBeUndefined();
  });
});

describe('QueryService.listPositions routing', () => {
  const USER_ID = 'user-1';

  function makeService(provider: string) {
    const listPositions = jest.fn().mockResolvedValue([]);
    const prisma = {
      mt5Account: {
        findFirst: jest
          .fn()
          .mockResolvedValue(buildRow({ id: 'acc-1', mt5AccountId: 'APEX-1' })),
      },
      // getProviderForAccount reads the provider column via a scoped raw query.
      $queryRaw: jest.fn().mockResolvedValue([{ provider }]),
    };
    const adapter = {
      provider,
      capabilities: MT5_CAPABILITIES,
      supports: jest.fn((cap: string) => cap === 'list_positions'),
      listPositions,
    };
    const brokerRegistry = {
      has: jest.fn(() => true),
      get: jest.fn(() => adapter),
    };
    const service = new QueryService(prisma as never, brokerRegistry as never);
    return { service, prisma, brokerRegistry, adapter, listPositions };
  }

  it('routes a Rithmic account to the rithmic adapter (not mt5)', async () => {
    const { service, brokerRegistry, listPositions } = makeService('rithmic');

    await service.listPositions(USER_ID, 'acc-1');

    // The load-bearing fix: getOwnedAccountContext must resolve the real
    // provider, so the registry is asked for 'rithmic', never 'mt5'.
    expect(brokerRegistry.get).toHaveBeenCalledWith('rithmic');
    const ctx = listPositions.mock.calls[0][0];
    expect(ctx.provider).toBe('rithmic');
    expect(ctx.providerAccountId).toBe('APEX-1');
  });

  it('still routes an MT5 account to the mt5 adapter', async () => {
    const { service, brokerRegistry, listPositions } = makeService('mt5');

    await service.listPositions(USER_ID, 'acc-1');

    expect(brokerRegistry.get).toHaveBeenCalledWith('mt5');
    expect(listPositions.mock.calls[0][0].provider).toBe('mt5');
  });
});

describe('QueryService.listOrders', () => {
  const USER_ID = 'user-1';

  function makeService(opts: {
    provider: string;
    supportsOrders: boolean;
    orders?: unknown[];
    hasProvider?: boolean;
  }) {
    const listOrders = jest.fn().mockResolvedValue(opts.orders ?? []);
    const prisma = {
      mt5Account: {
        findFirst: jest
          .fn()
          .mockResolvedValue(buildRow({ id: 'acc-1', mt5AccountId: 'APEX-1' })),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ provider: opts.provider }]),
    };
    const adapter = {
      provider: opts.provider,
      capabilities: MT5_CAPABILITIES,
      supports: jest.fn((cap: string) =>
        cap === 'list_orders' ? opts.supportsOrders : false,
      ),
      listOrders,
    };
    const brokerRegistry = {
      has: jest.fn(() => opts.hasProvider ?? true),
      get: jest.fn(() => adapter),
    };
    const service = new QueryService(prisma as never, brokerRegistry as never);
    return { service, brokerRegistry, adapter, listOrders };
  }

  it('delegates to the adapter when the provider supports list_orders', async () => {
    const orders = [{ id: '1', symbol: 'EURUSD' }];
    const { service, listOrders } = makeService({
      provider: 'mt5',
      supportsOrders: true,
      orders,
    });

    await expect(service.listOrders(USER_ID, 'acc-1')).resolves.toBe(orders);
    expect(listOrders).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list (no 503) when the provider lacks list_orders', async () => {
    const { service, listOrders } = makeService({
      provider: 'sim',
      supportsOrders: false,
    });

    await expect(service.listOrders(USER_ID, 'acc-1')).resolves.toEqual([]);
    expect(listOrders).not.toHaveBeenCalled();
  });

  it('surfaces a 503 when the adapter throws', async () => {
    const { service, listOrders } = makeService({
      provider: 'mt5',
      supportsOrders: true,
    });
    listOrders.mockRejectedValueOnce(new Error('bridge offline'));

    await expect(service.listOrders(USER_ID, 'acc-1')).rejects.toMatchObject({
      response: { code: 'TRADING_ORDERS_UNAVAILABLE' },
    });
  });
});
