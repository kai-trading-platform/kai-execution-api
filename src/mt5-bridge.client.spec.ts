import { ConfigService } from '@nestjs/config';
import { Mt5BridgeClient } from './mt5-bridge.client';

/**
 * Per-instance bridge routing (mt5_accounts.bridge_instance → its own Docker
 * container). Regression tests for the terminal bug where every MT5 account's
 * positions were fetched from the single fixed MT5_BRIDGE_URL (bridge slot 1),
 * so accounts living on other slots showed "Sin posiciones abiertas" and drew
 * no entry/TP/SL lines despite having real open positions.
 */
describe('Mt5BridgeClient bridge-instance routing', () => {
  const makeConfig = (env: Record<string, string>): ConfigService =>
    ({
      get: (key: string, defaultValue?: string) =>
        env[key] !== undefined ? env[key] : defaultValue,
    }) as unknown as ConfigService;

  const makeClient = (env: Record<string, string>) =>
    new Mt5BridgeClient(makeConfig(env));

  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify([]), { status: 200 }) as never,
      );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const requestedUrl = (): string => String(fetchSpy.mock.calls[0][0]);
  const requestedApiKey = (): string | null => {
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    return new Headers(init.headers).get('X-API-Key');
  };

  it('uses the default MT5_BRIDGE_URL when no bridgeInstance is given', async () => {
    const client = makeClient({
      MT5_BRIDGE_URL: 'http://mt5-bridge-1:8001',
      MT5_BRIDGE_API_KEY: 'shared-key',
    });
    await client.fetchPositions('198576816');
    expect(requestedUrl()).toBe(
      'http://mt5-bridge-1:8001/positions?accountId=198576816',
    );
    expect(requestedApiKey()).toBe('shared-key');
  });

  it('prefers the explicit MT5_BRIDGE_URL_{n} override', async () => {
    const client = makeClient({
      MT5_BRIDGE_URL: 'http://mt5-bridge-1:8001',
      MT5_BRIDGE_URL_TEMPLATE: 'http://mt5-bridge-{instance}:8001',
      MT5_BRIDGE_URL_4: 'http://custom-bridge:9000/',
    });
    await client.fetchPositions('198573122', 4);
    expect(requestedUrl()).toBe(
      'http://custom-bridge:9000/positions?accountId=198573122',
    );
  });

  it('expands MT5_BRIDGE_URL_TEMPLATE with the instance number', async () => {
    const client = makeClient({
      MT5_BRIDGE_URL: 'http://mt5-bridge:8001',
      MT5_BRIDGE_URL_TEMPLATE: 'http://mt5-bridge-{instance}:8001',
    });
    await client.fetchPositions('198573122', 4);
    expect(requestedUrl()).toBe(
      'http://mt5-bridge-4:8001/positions?accountId=198573122',
    );
  });

  it('derives the slot URL from a numbered MT5_BRIDGE_URL when no template/override exists', async () => {
    // The deployed execution-api only sets MT5_BRIDGE_URL=http://mt5-bridge-1:8001;
    // an account on slot 4 must still reach mt5-bridge-4.
    const client = makeClient({
      MT5_BRIDGE_URL: 'http://mt5-bridge-1:8001',
    });
    await client.fetchPositions('198573122', 4);
    expect(requestedUrl()).toBe(
      'http://mt5-bridge-4:8001/positions?accountId=198573122',
    );
  });

  it('falls back to the default URL when it has no slot number to derive from', async () => {
    const client = makeClient({
      MT5_BRIDGE_URL: 'http://mt5-bridge:8001',
    });
    await client.fetchPositions('198573122', 4);
    expect(requestedUrl()).toBe(
      'http://mt5-bridge:8001/positions?accountId=198573122',
    );
  });

  it('ignores invalid bridge instances (routing ceiling)', async () => {
    const client = makeClient({
      MT5_BRIDGE_URL: 'http://mt5-bridge-1:8001',
    });
    await client.fetchPositions('198573122', 0);
    expect(requestedUrl()).toBe(
      'http://mt5-bridge-1:8001/positions?accountId=198573122',
    );
  });

  it('uses the per-instance API key when configured', async () => {
    const client = makeClient({
      MT5_BRIDGE_URL: 'http://mt5-bridge-1:8001',
      MT5_BRIDGE_API_KEY: 'shared-key',
      MT5_BRIDGE_API_KEY_4: 'slot-4-key',
    });
    await client.fetchPositions('198573122', 4);
    expect(requestedApiKey()).toBe('slot-4-key');
  });

  it('routes order execution to the account slot bridge', async () => {
    const client = makeClient({
      MT5_BRIDGE_URL: 'http://mt5-bridge-1:8001',
    });
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ticket: 1 }), { status: 200 }) as never,
    );
    await client.executeMarketOrder({
      accountId: '198573122',
      bridgeInstance: 4,
      symbol: 'XAUUSDm',
      type: 'buy',
      volume: 0.1,
    });
    expect(requestedUrl()).toBe('http://mt5-bridge-4:8001/orders');
    // bridgeInstance is routing metadata; it must not leak into the payload.
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).not.toHaveProperty('bridgeInstance');
  });

  it('rethrows fetchPositions failures instead of masking them as an empty list', async () => {
    const client = makeClient({
      MT5_BRIDGE_URL: 'http://mt5-bridge-1:8001',
    });
    fetchSpy.mockRejectedValue(new Error('bridge down'));
    await expect(client.fetchPositions('198573122', 4)).rejects.toThrow(
      'bridge down',
    );
  });
});
