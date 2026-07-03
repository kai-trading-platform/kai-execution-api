import { RithmicBrokerAdapter } from './rithmic-broker.adapter';
import type { KaiBackendRithmicClient } from './kai-backend.client';
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

function makeAdapter(fetchPositions: jest.Mock) {
  const backend = { fetchPositions } as unknown as KaiBackendRithmicClient;
  return new RithmicBrokerAdapter(backend);
}

describe('RithmicBrokerAdapter', () => {
  describe('capabilities / supports', () => {
    it('is read-only: positions yes, writes no', () => {
      const adapter = makeAdapter(jest.fn());
      expect(adapter.provider).toBe('rithmic');
      expect(adapter.capabilities).toEqual({
        listAccounts: true,
        listPositions: true,
        placeMarketOrder: false,
        closePosition: false,
        updateStops: false,
      });
      expect(adapter.supports('list_positions')).toBe(true);
      expect(adapter.supports('list_accounts')).toBe(true);
      expect(adapter.supports('place_market_order')).toBe(false);
      expect(adapter.supports('close_position')).toBe(false);
      expect(adapter.supports('update_position_stops')).toBe(false);
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
      const adapter = makeAdapter(fetchPositions);

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
      const adapter = makeAdapter(fetchPositions);

      const [p] = await adapter.listPositions(ACCOUNT);

      expect(p.side).toBe('sell');
      expect(p.volume).toBe(1);
      expect(p.entryPrice).toBe(5000);
      expect(p.currentPrice).toBe(4990);
      expect(p.stopLoss).toBeNull();
      expect(p.takeProfit).toBeNull();
      expect(p.profitLoss).toBe(500);
    });

    it('returns an empty list cleanly when the account is flat', async () => {
      const adapter = makeAdapter(
        jest.fn().mockResolvedValue({ positions: [] }),
      );
      await expect(adapter.listPositions(ACCOUNT)).resolves.toEqual([]);
    });

    it('throws when the response shape is invalid (fails loudly)', async () => {
      const adapter = makeAdapter(
        jest.fn().mockResolvedValue({ positions: [{ nope: true }] }),
      );
      await expect(adapter.listPositions(ACCOUNT)).rejects.toThrow(
        /unexpected shape/,
      );
    });

    it('propagates a transport failure (surfaces outage, not empty)', async () => {
      const adapter = makeAdapter(
        jest.fn().mockRejectedValue(new Error('kai-backend 503')),
      );
      await expect(adapter.listPositions(ACCOUNT)).rejects.toThrow(
        'kai-backend 503',
      );
    });
  });

  describe('write paths are not supported', () => {
    it.each(['placeOrder', 'closePosition', 'updatePositionStops'] as const)(
      '%s throws a clear "not supported" error (never a silent no-op)',
      async (method) => {
        const adapter = makeAdapter(jest.fn());
        await expect(
          (adapter[method] as () => Promise<unknown>)(),
        ).rejects.toThrow(/not supported yet/);
      },
    );
  });
});
