import { RithmicBrokerAdapter } from './rithmic-broker.adapter';
import type { KaiBackendRithmicClient } from './kai-backend.client';
import type { ConfigService } from '@nestjs/config';
import type { TradingAccountContext } from '../../core/types';

const ACCOUNT: TradingAccountContext = {
  id: 'acc-rithmic',
  userId: 'user-1',
  provider: 'rithmic',
  providerAccountId: 'APEX-1',
  name: 'Apex Futures',
  server: null,
  status: 'connected',
  accountType: 'demo',
  isDefault: false,
  balance: 50000,
  equity: 50120,
  bridgeInstance: null,
  customComment: null,
  customMagicNumber: null,
};

function makeConfig(flag?: string): ConfigService {
  return {
    get: jest.fn((key: string) =>
      key === 'RITHMIC_TERMINAL_ORDERS_ENABLED' ? flag : undefined,
    ),
  } as unknown as ConfigService;
}

function makeAdapter(
  backendOverrides: Partial<Record<keyof KaiBackendRithmicClient, jest.Mock>> = {},
  flag?: string,
) {
  const backend = {
    fetchPositions: jest.fn(),
    placeOrder: jest.fn(),
    closePosition: jest.fn(),
    modifyStops: jest.fn(),
    ...backendOverrides,
  } as unknown as KaiBackendRithmicClient;
  return {
    adapter: new RithmicBrokerAdapter(backend, makeConfig(flag)),
    backend,
  };
}

describe('RithmicBrokerAdapter', () => {
  describe('capabilities / supports — flag OFF (default)', () => {
    it('is read-only: positions yes, writes no', () => {
      const { adapter } = makeAdapter();
      expect(adapter.provider).toBe('rithmic');
      expect(adapter.capabilities).toEqual({
        listAccounts: true,
        listPositions: true,
        placeMarketOrder: false,
        closePosition: false,
        updateStops: false,
      });
      expect(adapter.supports('list_positions')).toBe(true);
      expect(adapter.supports('place_market_order')).toBe(false);
      expect(adapter.supports('close_position')).toBe(false);
      expect(adapter.supports('update_position_stops')).toBe(false);
    });

    it.each(['false', undefined, '', 'TRUE_NOT'] as const)(
      'stays disabled for flag=%s',
      (flag) => {
        const { adapter } = makeAdapter({}, flag);
        expect(adapter.capabilities.placeMarketOrder).toBe(false);
      },
    );
  });

  describe('capabilities / supports — flag ON', () => {
    it('enables writes when RITHMIC_TERMINAL_ORDERS_ENABLED=true', () => {
      const { adapter } = makeAdapter({}, 'true');
      expect(adapter.capabilities).toEqual({
        listAccounts: true,
        listPositions: true,
        placeMarketOrder: true,
        closePosition: true,
        updateStops: true,
      });
      expect(adapter.supports('place_market_order')).toBe(true);
      expect(adapter.supports('close_position')).toBe(true);
      expect(adapter.supports('update_position_stops')).toBe(true);
    });
  });

  describe('listPositions mapping', () => {
    it('maps the kai-backend envelope into the shared TradingPosition DTO', async () => {
      const fetchPositions = jest.fn().mockResolvedValue({
        positions: [
          {
            ticket: 987654321,
            symbol: 'MNQ',
            securityCode: 'MNQU5',
            side: 'buy',
            volume: 2,
            entryPrice: 20000.25,
            currentPrice: 20010.25,
            stopLoss: 19950,
            takeProfit: 20100,
            profitLoss: 40,
            openedAt: null,
          },
        ],
      });
      const { adapter } = makeAdapter({ fetchPositions });

      const positions = await adapter.listPositions(ACCOUNT);

      expect(fetchPositions).toHaveBeenCalledWith('acc-rithmic');
      expect(positions).toEqual([
        {
          id: '987654321',
          tradingAccountId: 'acc-rithmic',
          provider: 'rithmic',
          symbol: 'MNQ',
          side: 'buy',
          volume: 2,
          entryPrice: 20000.25,
          currentPrice: 20010.25,
          stopLoss: 19950,
          takeProfit: 20100,
          profitLoss: 40,
          openedAt: null,
          comment: null,
          magic: null,
        },
      ]);
    });

    it('coalesces string numerics and null stops (short side)', async () => {
      const fetchPositions = jest.fn().mockResolvedValue({
        positions: [
          {
            ticket: '111',
            symbol: 'ES',
            side: 'SELL',
            volume: '1',
            entryPrice: '5000',
            currentPrice: '4990',
            stopLoss: null,
            takeProfit: null,
            profitLoss: '500',
          },
        ],
      });
      const { adapter } = makeAdapter({ fetchPositions });

      const [p] = await adapter.listPositions(ACCOUNT);

      expect(p.side).toBe('sell');
      expect(p.volume).toBe(1);
      expect(p.stopLoss).toBeNull();
      expect(p.takeProfit).toBeNull();
      expect(p.profitLoss).toBe(500);
    });

    it('throws when the response shape is invalid (fails loudly)', async () => {
      const { adapter } = makeAdapter({
        fetchPositions: jest.fn().mockResolvedValue({ positions: [{ nope: true }] }),
      });
      await expect(adapter.listPositions(ACCOUNT)).rejects.toThrow(
        /unexpected shape/,
      );
    });

    it('propagates a transport failure (surfaces outage, not empty)', async () => {
      const { adapter } = makeAdapter({
        fetchPositions: jest.fn().mockRejectedValue(new Error('kai-backend 503')),
      });
      await expect(adapter.listPositions(ACCOUNT)).rejects.toThrow(
        'kai-backend 503',
      );
    });

    it('reads positions regardless of the flag (read path always on)', async () => {
      const fetchPositions = jest.fn().mockResolvedValue({ positions: [] });
      const { adapter } = makeAdapter({ fetchPositions }, 'false');
      await expect(adapter.listPositions(ACCOUNT)).resolves.toEqual([]);
    });
  });

  describe('write paths — flag OFF: throw, never touch the backend', () => {
    it('placeOrder throws and does not call the backend', async () => {
      const placeOrder = jest.fn();
      const { adapter } = makeAdapter({ placeOrder });
      await expect(
        adapter.placeOrder(ACCOUNT, {
          tradingAccountId: ACCOUNT.id,
          symbol: 'MNQ',
          side: 'buy',
          volume: 1,
          dryRun: false,
        }),
      ).rejects.toThrow(/not supported yet|disabled/);
      expect(placeOrder).not.toHaveBeenCalled();
    });

    it('closePosition throws and does not call the backend', async () => {
      const closePosition = jest.fn();
      const { adapter } = makeAdapter({ closePosition });
      await expect(
        adapter.closePosition(ACCOUNT, {
          tradingAccountId: ACCOUNT.id,
          ticket: 't1',
          dryRun: false,
        }),
      ).rejects.toThrow(/disabled|not supported yet/);
      expect(closePosition).not.toHaveBeenCalled();
    });

    it('updatePositionStops throws and does not call the backend', async () => {
      const modifyStops = jest.fn();
      const { adapter } = makeAdapter({ modifyStops });
      await expect(
        adapter.updatePositionStops(ACCOUNT, {
          tradingAccountId: ACCOUNT.id,
          ticket: 't1',
          stopLoss: 1,
          takeProfit: 2,
          dryRun: false,
        }),
      ).rejects.toThrow(/disabled|not supported yet/);
      expect(modifyStops).not.toHaveBeenCalled();
    });
  });

  describe('write paths — flag ON: delegate to kai-backend', () => {
    it('placeOrder posts the correct payload and maps the result', async () => {
      const placeOrder = jest.fn().mockResolvedValue({
        ok: true,
        orderId: 'ORD-1',
        requestedVolume: 5,
        volume: 1,
        capApplied: true,
      });
      const { adapter } = makeAdapter({ placeOrder }, 'true');

      const result = await adapter.placeOrder(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        symbol: 'MNQ',
        side: 'buy',
        volume: 5,
        stopLoss: 19950,
        takeProfit: 20100,
        entry: 20000,
        comment: 'manual',
        dryRun: false,
      });

      expect(placeOrder).toHaveBeenCalledWith({
        account: 'acc-rithmic',
        symbol: 'MNQ',
        side: 'buy',
        volume: 5,
        sl: 19950,
        tp: 20100,
        entry: 20000,
        comment: 'manual',
      });
      expect(result.ok).toBe(true);
      expect(result.orderId).toBe('ORD-1');
      expect(result.provider).toBe('rithmic');
    });

    it('closePosition resolves ticket→symbol then flattens', async () => {
      const fetchPositions = jest.fn().mockResolvedValue({
        positions: [
          {
            ticket: 't1',
            symbol: 'MNQ',
            side: 'buy',
            volume: 1,
            entryPrice: 20000,
            currentPrice: 20010,
            profitLoss: 20,
          },
        ],
      });
      const closePosition = jest.fn().mockResolvedValue({ ok: true });
      const { adapter } = makeAdapter({ fetchPositions, closePosition }, 'true');

      const result = await adapter.closePosition(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        ticket: 't1',
        dryRun: false,
      });

      expect(closePosition).toHaveBeenCalledWith({
        account: 'acc-rithmic',
        symbol: 'MNQ',
      });
      expect(result.success).toBe(true);
      expect(result.ticket).toBe('t1');
    });

    it('updatePositionStops resolves ticket→symbol then modifies the bracket', async () => {
      const fetchPositions = jest.fn().mockResolvedValue({
        positions: [
          {
            ticket: 't1',
            symbol: 'MNQ',
            side: 'buy',
            volume: 1,
            entryPrice: 20000,
            currentPrice: 20010,
            profitLoss: 20,
          },
        ],
      });
      const modifyStops = jest.fn().mockResolvedValue({ ok: true });
      const { adapter } = makeAdapter({ fetchPositions, modifyStops }, 'true');

      const result = await adapter.updatePositionStops(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        ticket: 't1',
        stopLoss: 19900,
        takeProfit: 20200,
        dryRun: false,
      });

      expect(modifyStops).toHaveBeenCalledWith({
        account: 'acc-rithmic',
        symbol: 'MNQ',
        sl: 19900,
        tp: 20200,
      });
      expect(result.success).toBe(true);
      expect(result.stopLoss).toBe(19900);
      expect(result.takeProfit).toBe(20200);
    });

    it('dry-run close/modify short-circuit without touching the backend', async () => {
      const closePosition = jest.fn();
      const modifyStops = jest.fn();
      const { adapter } = makeAdapter({ closePosition, modifyStops }, 'true');

      const close = await adapter.closePosition(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        ticket: 't1',
        dryRun: true,
      });
      expect(close.dryRun).toBe(true);
      expect(closePosition).not.toHaveBeenCalled();

      const mod = await adapter.updatePositionStops(ACCOUNT, {
        tradingAccountId: ACCOUNT.id,
        ticket: 't1',
        stopLoss: 1,
        takeProfit: 2,
        dryRun: true,
      });
      expect(mod.dryRun).toBe(true);
      expect(modifyStops).not.toHaveBeenCalled();
    });
  });
});
