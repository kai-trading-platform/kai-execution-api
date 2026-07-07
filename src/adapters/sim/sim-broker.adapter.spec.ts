import { SimBrokerAdapter } from './sim-broker.adapter';
import { resolveSimContract } from './sim-contracts';
import type { PrismaService } from '../../common/prisma.service';
import type { YahooPriceClient } from './yahoo-price.client';
import type { TradingAccountContext } from '../../core/types';

const ACCOUNT: TradingAccountContext = {
  id: 'acc-sim',
  userId: 'user-1',
  provider: 'sim',
  providerAccountId: 'SIM-0001',
  name: 'Fondeo Emulado',
  server: null,
  status: 'connected',
  accountType: 'demo',
  isDefault: false,
  balance: 50000,
  equity: 50000,
  bridgeInstance: null,
  customComment: null,
  customMagicNumber: null,
};

interface PrismaMocks {
  syncedTrade: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  mt5Account: {
    update: jest.Mock;
  };
}

function makePrisma(): PrismaMocks {
  return {
    syncedTrade: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'st-created', ...data }),
        ),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    mt5Account: {
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

function makeAdapter(prices: Record<string, number | Error> = {}) {
  const prisma = makePrisma();
  const getLastPrice = jest.fn(async (yahooSymbol: string) => {
    const value = prices[yahooSymbol];
    if (value === undefined) {
      throw new Error(`no mocked price for ${yahooSymbol}`);
    }
    if (value instanceof Error) throw value;
    return value;
  });
  const yahoo = { getLastPrice } as unknown as YahooPriceClient;
  const adapter = new SimBrokerAdapter(
    prisma as unknown as PrismaService,
    yahoo,
  );
  return { adapter, prisma, getLastPrice };
}

function openRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'st-1',
    userId: 'user-1',
    accountId: 'acc-sim',
    ticket: 910000000123n,
    positionId: null,
    symbol: 'MNQ',
    side: 'LONG',
    qty: 2,
    price: 20000,
    sl: 19950,
    tp: 20100,
    pnl: null,
    status: 'open',
    openedAt: new Date('2026-07-06T14:30:00.000Z'),
    closedAt: null,
    magic: 777,
    comment: 'KAI_META:{"entryPrice":20000,"reason":null,"closeSource":"sim"}',
    ...overrides,
  };
}

describe('resolveSimContract', () => {
  it('matches the longest root (MNQ beats NQ, MGC beats GC)', () => {
    expect(resolveSimContract('MNQ')?.root).toBe('MNQ');
    expect(resolveSimContract('MNQU5')?.root).toBe('MNQ');
    expect(resolveSimContract('NQ')?.root).toBe('NQ');
    expect(resolveSimContract('MGCQ5')?.root).toBe('MGC');
    expect(resolveSimContract('GC')?.root).toBe('GC');
  });

  it('is case-insensitive and null for unknown symbols', () => {
    expect(resolveSimContract('mes')?.root).toBe('MES');
    expect(resolveSimContract('CL')).toBeNull();
    expect(resolveSimContract('')).toBeNull();
  });
});

describe('SimBrokerAdapter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('capabilities / supports', () => {
    it('mirrors the MT5 capability set (no flatten/cancel/reverse)', () => {
      const { adapter } = makeAdapter();
      expect(adapter.provider).toBe('sim');
      expect(adapter.capabilities).toEqual({
        listAccounts: true,
        listPositions: true,
        placeMarketOrder: true,
        closePosition: true,
        updateStops: true,
      });
      expect(adapter.supports('list_positions')).toBe(true);
      expect(adapter.supports('place_market_order')).toBe(true);
      expect(adapter.supports('close_position')).toBe(true);
      expect(adapter.supports('update_position_stops')).toBe(true);
      expect(adapter.supports('flatten_all')).toBe(false);
      expect(adapter.supports('cancel_all_orders')).toBe(false);
      expect(adapter.supports('reverse_position')).toBe(false);
    });
  });

  describe('listPositions', () => {
    it('maps open synced_trades rows with live Yahoo pricing and floating PnL', async () => {
      const { adapter, prisma } = makeAdapter({ 'MNQ=F': 20010.25 });
      prisma.syncedTrade.findMany.mockResolvedValue([openRow()]);

      const positions = await adapter.listPositions(ACCOUNT);

      expect(prisma.syncedTrade.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { accountId: 'acc-sim', status: 'open' },
        }),
      );
      expect(positions).toEqual([
        {
          id: '910000000123',
          tradingAccountId: 'acc-sim',
          provider: 'sim',
          symbol: 'MNQ',
          side: 'buy',
          volume: 2,
          entryPrice: 20000,
          currentPrice: 20010.25,
          stopLoss: 19950,
          takeProfit: 20100,
          // (20010.25 - 20000) * +1 * $2/pt * 2 contracts = 41.00
          profitLoss: 41,
          openedAt: '2026-07-06T14:30:00.000Z',
          comment:
            'KAI_META:{"entryPrice":20000,"reason":null,"closeSource":"sim"}',
          magic: 777,
        },
      ]);
    });

    it('maps SHORT rows to sell with inverted PnL and null stops', async () => {
      const { adapter, prisma } = makeAdapter({ 'ES=F': 4990 });
      prisma.syncedTrade.findMany.mockResolvedValue([
        openRow({
          ticket: 910000000456n,
          symbol: 'ES',
          side: 'SHORT',
          qty: 1,
          price: 5000,
          sl: null,
          tp: null,
          magic: null,
          comment: null,
        }),
      ]);

      const [position] = await adapter.listPositions(ACCOUNT);

      expect(position.side).toBe('sell');
      expect(position.stopLoss).toBeNull();
      expect(position.takeProfit).toBeNull();
      // (4990 - 5000) * -1 * $50/pt * 1 = +500
      expect(position.profitLoss).toBe(500);
      expect(position.comment).toBeNull();
      expect(position.magic).toBeNull();
    });

    it('falls back to the entry price (flat PnL) when Yahoo fails', async () => {
      const { adapter, prisma } = makeAdapter({
        'MNQ=F': new Error('yahoo down'),
      });
      prisma.syncedTrade.findMany.mockResolvedValue([openRow()]);

      const [position] = await adapter.listPositions(ACCOUNT);

      expect(position.currentPrice).toBe(20000);
      expect(position.profitLoss).toBe(0);
    });

    it('fetches the Yahoo price once per distinct symbol', async () => {
      const { adapter, prisma, getLastPrice } = makeAdapter({
        'MNQ=F': 20010,
      });
      prisma.syncedTrade.findMany.mockResolvedValue([
        openRow(),
        openRow({ id: 'st-2', ticket: 910000000124n }),
      ]);

      await adapter.listPositions(ACCOUNT);

      expect(getLastPrice).toHaveBeenCalledTimes(1);
      expect(getLastPrice).toHaveBeenCalledWith('MNQ=F');
    });
  });

  describe('placeOrder', () => {
    it('fills a buy at Yahoo + 1 tick, rounded to tick, and creates the open row', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      const { adapter, prisma } = makeAdapter({ 'MNQ=F': 20000 });

      const result = await adapter.placeOrder(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        symbol: 'MNQ',
        side: 'buy',
        volume: 2,
        stopLoss: 19950,
        takeProfit: 20100,
      });

      expect(prisma.syncedTrade.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          accountId: 'acc-sim',
          ticket: 910000000000n + 500000000n,
          symbol: 'MNQ',
          side: 'LONG',
          qty: 2,
          price: 20000.25, // 20000 + 1 tick (0.25)
          sl: 19950,
          tp: 20100,
          status: 'open',
          magic: null,
          comment:
            'KAI_META:{"entryPrice":20000.25,"reason":null,"closeSource":"sim"}',
        }),
      });
      expect(result).toEqual({
        ok: true,
        provider: 'sim',
        tradingAccountId: 'acc-sim',
        orderId: '910500000000',
        raw: expect.objectContaining({
          fillPrice: 20000.25,
          symbol: 'MNQ',
          side: 'buy',
          volume: 2,
        }),
      });
    });

    it('fills a sell at Yahoo - 1 tick and snaps an off-tick price to the grid', async () => {
      const { adapter, prisma } = makeAdapter({ 'GC=F': 3345.73 });

      const result = await adapter.placeOrder(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        symbol: 'GC',
        side: 'sell',
        volume: 1,
      });

      // 3345.73 - 0.1 = 3345.63 -> nearest 0.1 tick = 3345.6
      expect(prisma.syncedTrade.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          side: 'SHORT',
          price: 3345.6,
          sl: null,
          tp: null,
        }),
      });
      expect(result.ok).toBe(true);
    });

    it('uses the account custom magic when the request has none', async () => {
      const { adapter, prisma } = makeAdapter({ 'MES=F': 5000 });

      await adapter.placeOrder(
        { ...ACCOUNT, customMagicNumber: 424242 },
        {
          tradingAccountId: ACCOUNT.id,
          symbol: 'MES',
          side: 'buy',
          volume: 1,
        },
      );

      expect(prisma.syncedTrade.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ magic: 424242 }),
      });
    });

    it('rejects unsupported symbols without touching the DB', async () => {
      const { adapter, prisma, getLastPrice } = makeAdapter();

      const result = await adapter.placeOrder(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        symbol: 'CL',
        side: 'buy',
        volume: 1,
      });

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/not supported/i);
      expect(getLastPrice).not.toHaveBeenCalled();
      expect(prisma.syncedTrade.create).not.toHaveBeenCalled();
    });

    it('fails closed when Yahoo pricing is unavailable', async () => {
      const { adapter, prisma } = makeAdapter({
        'MNQ=F': new Error('rate limited'),
      });

      const result = await adapter.placeOrder(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        symbol: 'MNQ',
        side: 'buy',
        volume: 1,
      });

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/price unavailable/i);
      expect(prisma.syncedTrade.create).not.toHaveBeenCalled();
    });
  });

  describe('closePosition — total', () => {
    it('marks the row filled with PnL net of commissions and settles the balance', async () => {
      const { adapter, prisma } = makeAdapter({ 'MNQ=F': 20010 });
      prisma.syncedTrade.findFirst.mockResolvedValue(openRow());

      const result = await adapter.closePosition(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        ticket: '910000000123',
      });

      expect(prisma.syncedTrade.findFirst).toHaveBeenCalledWith({
        where: {
          accountId: 'acc-sim',
          ticket: 910000000123n,
          status: 'open',
        },
      });
      // (20010 - 20000) * +1 * $2/pt * 2 - 1.34 * 2 = 40 - 2.68 = 37.32
      expect(prisma.syncedTrade.update).toHaveBeenCalledWith({
        where: { id: 'st-1' },
        data: expect.objectContaining({
          status: 'filled',
          pnl: 37.32,
          closedAt: expect.any(Date),
          comment:
            'KAI_META:{"entryPrice":20000,"closePrice":20010,"reason":"CLIENT","closeSource":"sim"}',
        }),
      });
      expect(prisma.mt5Account.update).toHaveBeenCalledWith({
        where: { id: 'acc-sim' },
        data: { balance: { increment: 37.32 } },
      });
      expect(prisma.syncedTrade.create).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.provider).toBe('sim');
      expect(result.ticket).toBe('910000000123');
      expect(result.raw).toEqual(
        expect.objectContaining({
          pnl: 37.32,
          closePrice: 20010,
          partial: false,
          remainingVolume: 0,
        }),
      );
    });

    it('computes SHORT PnL with inverted direction', async () => {
      const { adapter, prisma } = makeAdapter({ 'ES=F': 4990 });
      prisma.syncedTrade.findFirst.mockResolvedValue(
        openRow({ symbol: 'ES', side: 'SHORT', qty: 1, price: 5000 }),
      );

      await adapter.closePosition(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        ticket: '910000000123',
      });

      // (4990 - 5000) * -1 * $50/pt * 1 - 4.28 = 500 - 4.28 = 495.72
      expect(prisma.syncedTrade.update).toHaveBeenCalledWith({
        where: { id: 'st-1' },
        data: expect.objectContaining({ pnl: 495.72 }),
      });
      expect(prisma.mt5Account.update).toHaveBeenCalledWith({
        where: { id: 'acc-sim' },
        data: { balance: { increment: 495.72 } },
      });
    });

    it('returns failure when the position does not exist (no balance touch)', async () => {
      const { adapter, prisma } = makeAdapter();
      prisma.syncedTrade.findFirst.mockResolvedValue(null);

      const result = await adapter.closePosition(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        ticket: '42',
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not found/i);
      expect(prisma.syncedTrade.update).not.toHaveBeenCalled();
      expect(prisma.mt5Account.update).not.toHaveBeenCalled();
    });

    it('fails closed when Yahoo pricing is unavailable', async () => {
      const { adapter, prisma } = makeAdapter({
        'MNQ=F': new Error('yahoo down'),
      });
      prisma.syncedTrade.findFirst.mockResolvedValue(openRow());

      const result = await adapter.closePosition(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        ticket: '910000000123',
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/price unavailable/i);
      expect(prisma.syncedTrade.update).not.toHaveBeenCalled();
      expect(prisma.mt5Account.update).not.toHaveBeenCalled();
    });

    it('dry-run short-circuits without touching the DB', async () => {
      const { adapter, prisma } = makeAdapter();

      const result = await adapter.closePosition(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        ticket: '910000000123',
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(prisma.syncedTrade.findFirst).not.toHaveBeenCalled();
      expect(prisma.mt5Account.update).not.toHaveBeenCalled();
    });
  });

  describe('closePosition — partial', () => {
    it('reduces the open qty and books the closed slice as a new filled row', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.25);
      const { adapter, prisma } = makeAdapter({ 'MNQ=F': 20010 });
      prisma.syncedTrade.findFirst.mockResolvedValue(openRow({ qty: 3 }));

      const result = await adapter.closePosition(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        ticket: '910000000123',
        volume: 1,
      });

      // Open position shrinks by the closed slice.
      expect(prisma.syncedTrade.update).toHaveBeenCalledWith({
        where: { id: 'st-1' },
        data: { qty: { decrement: 1 } },
      });
      // (20010 - 20000) * +1 * $2/pt * 1 - 1.34 = 18.66
      expect(prisma.syncedTrade.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          accountId: 'acc-sim',
          ticket: 910000000000n + 250000000n,
          positionId: 910000000123n,
          symbol: 'MNQ',
          side: 'LONG',
          qty: 1,
          price: 20000,
          pnl: 18.66,
          status: 'filled',
          closedAt: expect.any(Date),
          comment:
            'KAI_META:{"entryPrice":20000,"closePrice":20010,"reason":"CLIENT","closeSource":"sim"}',
        }),
      });
      expect(prisma.mt5Account.update).toHaveBeenCalledWith({
        where: { id: 'acc-sim' },
        data: { balance: { increment: 18.66 } },
      });
      expect(result.success).toBe(true);
      expect(result.raw).toEqual(
        expect.objectContaining({
          partial: true,
          closedVolume: 1,
          remainingVolume: 2,
        }),
      );
    });

    it('treats a volume >= open qty as a total close', async () => {
      const { adapter, prisma } = makeAdapter({ 'MNQ=F': 20010 });
      prisma.syncedTrade.findFirst.mockResolvedValue(openRow({ qty: 2 }));

      await adapter.closePosition(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        ticket: '910000000123',
        volume: 5,
      });

      expect(prisma.syncedTrade.create).not.toHaveBeenCalled();
      expect(prisma.syncedTrade.update).toHaveBeenCalledWith({
        where: { id: 'st-1' },
        data: expect.objectContaining({ status: 'filled', pnl: 37.32 }),
      });
    });
  });

  describe('updatePositionStops', () => {
    it('updates sl/tp on the open row', async () => {
      const { adapter, prisma } = makeAdapter();
      prisma.syncedTrade.updateMany.mockResolvedValue({ count: 1 });

      const result = await adapter.updatePositionStops(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        ticket: '910000000123',
        stopLoss: 19900,
        takeProfit: 20200,
      });

      expect(prisma.syncedTrade.updateMany).toHaveBeenCalledWith({
        where: {
          accountId: 'acc-sim',
          ticket: 910000000123n,
          status: 'open',
        },
        data: { sl: 19900, tp: 20200 },
      });
      expect(result.success).toBe(true);
      expect(result.stopLoss).toBe(19900);
      expect(result.takeProfit).toBe(20200);
    });

    it('returns failure when no open row matches', async () => {
      const { adapter, prisma } = makeAdapter();
      prisma.syncedTrade.updateMany.mockResolvedValue({ count: 0 });

      const result = await adapter.updatePositionStops(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        ticket: '42',
        stopLoss: 1,
        takeProfit: 2,
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not found/i);
    });

    it('dry-run short-circuits without touching the DB', async () => {
      const { adapter, prisma } = makeAdapter();

      const result = await adapter.updatePositionStops(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        ticket: '910000000123',
        stopLoss: 1,
        takeProfit: 2,
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      expect(prisma.syncedTrade.updateMany).not.toHaveBeenCalled();
    });
  });
});
