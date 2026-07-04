import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { ExecutionService } from './execution.service';
import type { BrokerRegistryService } from './core/broker-registry.service';
import type { PrismaService } from './common/prisma.service';
import type { QueryService } from './query.service';
import type { RiskGuardClient } from './risk-guard.client';
import type {
  BrokerAdapter,
} from './core/broker-adapter.interface';
import type {
  BrokerProviderKey,
  PlaceOrderResult,
  TradingAccountContext,
} from './core/types';

/**
 * These tests pin down GATE 3 of the Phase-5 Rithmic (futures) rollout: a MANUAL
 * terminal order must run through the SAME risk-guard + trade-count path as an
 * MT5 order, for EVERY provider — the rithmic adapter must not get a bypass.
 *
 * `ExecutionService.placeOrder` is provider-agnostic: it calls
 * `riskGuard.checkRiskLimits` (execution.service.ts:93) BEFORE dispatching to any
 * adapter, and `riskGuard.recordTradeExecuted` (execution.service.ts:181) only
 * after a successful fill. The maxContracts clamp itself lives server-side in
 * kai-backend (InternalRithmicController.placeOrder); execution-api's contract is
 * that it forwards the REQUESTED volume unchanged so the downstream clamp sees the
 * real number — asserted below.
 */

const CONFIRMATION = 'EJECUTAR DEMO';

function makeAccount(
  provider: BrokerProviderKey,
): TradingAccountContext {
  return {
    id: provider === 'rithmic' ? 'acc-rithmic' : 'acc-mt5',
    userId: 'user-1',
    provider,
    providerAccountId: provider === 'rithmic' ? 'APEX-1' : '5001',
    name: provider === 'rithmic' ? 'Apex Futures' : 'MT5 Demo',
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
}

interface Harness {
  service: ExecutionService;
  query: { getOwnedAccountContext: jest.Mock };
  riskGuard: {
    checkRiskLimits: jest.Mock;
    recordTradeExecuted: jest.Mock;
  };
  adapter: {
    supports: jest.Mock;
    placeOrder: jest.Mock;
    provider: BrokerProviderKey;
  };
  prisma: {
    orderIdempotency: {
      create: jest.Mock;
      update: jest.Mock;
      findUnique: jest.Mock;
    };
  };
}

function makeHarness(
  provider: BrokerProviderKey,
  opts: {
    allowed?: boolean;
    reason?: string;
    supportsMarket?: boolean;
    orderResult?: PlaceOrderResult;
  } = {},
): Harness {
  const account = makeAccount(provider);
  const {
    allowed = true,
    reason,
    supportsMarket = true,
    orderResult = {
      ok: true,
      provider,
      tradingAccountId: account.id,
      orderId: 'ord-1',
      message: 'filled',
    },
  } = opts;

  const query = {
    getOwnedAccountContext: jest.fn().mockResolvedValue(account),
  };
  const riskGuard = {
    checkRiskLimits: jest.fn().mockResolvedValue({ allowed, reason }),
    recordTradeExecuted: jest.fn().mockResolvedValue(undefined),
  };
  const adapter = {
    provider,
    supports: jest.fn().mockReturnValue(supportsMarket),
    placeOrder: jest.fn().mockResolvedValue(orderResult),
  };
  const brokerRegistry = {
    get: jest.fn().mockReturnValue(adapter as unknown as BrokerAdapter),
  };
  const prisma = {
    orderIdempotency: {
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };

  const service = new ExecutionService(
    query as unknown as QueryService,
    brokerRegistry as unknown as BrokerRegistryService,
    riskGuard as unknown as RiskGuardClient,
    prisma as unknown as PrismaService,
  );

  return { service, query, riskGuard, adapter, prisma };
}

function orderPayload(overrides: Record<string, unknown> = {}) {
  return {
    tradingAccountId: 'acc-rithmic',
    symbol: 'MNQ',
    side: 'buy',
    type: 'market',
    volume: 5,
    dryRun: false,
    confirmationText: CONFIRMATION,
    ...overrides,
  };
}

describe('ExecutionService.placeOrder — risk gating (GATE 3)', () => {
  describe.each(['rithmic', 'mt5'] as const)('provider=%s', (provider) => {
    it('blocks a real order when RiskGuard says not allowed — no fill, no counter', async () => {
      const { service, riskGuard, adapter } = makeHarness(provider, {
        allowed: false,
        reason: 'Pérdida diaria máxima alcanzada',
      });

      await expect(
        service.placeOrder('user-1', orderPayload(), 'idem-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // The risk guard was consulted for THIS provider…
      expect(riskGuard.checkRiskLimits).toHaveBeenCalledTimes(1);
      // …and because it blocked, the order never reached the broker adapter…
      expect(adapter.placeOrder).not.toHaveBeenCalled();
      // …and the trade counter was NOT incremented.
      expect(riskGuard.recordTradeExecuted).not.toHaveBeenCalled();
    });

    it('fail-closed: a RiskGuard outage (allowed:false) blocks the order', async () => {
      // RiskGuardClient.checkRiskLimits already returns {allowed:false,
      // reason:'RiskGuard unavailable'} on transport failure. Prove placeOrder
      // honours that (no bypass on backend down).
      const { service, adapter, riskGuard } = makeHarness(provider, {
        allowed: false,
        reason: 'RiskGuard unavailable',
      });

      await expect(
        service.placeOrder('user-1', orderPayload(), 'idem-1'),
      ).rejects.toThrow('RiskGuard unavailable');
      expect(adapter.placeOrder).not.toHaveBeenCalled();
      expect(riskGuard.recordTradeExecuted).not.toHaveBeenCalled();
    });

    it('when allowed: risk check runs BEFORE the fill, and the counter is recorded AFTER', async () => {
      const calls: string[] = [];
      const { service, riskGuard, adapter } = makeHarness(provider);
      riskGuard.checkRiskLimits.mockImplementation(async () => {
        calls.push('check');
        return { allowed: true };
      });
      adapter.placeOrder.mockImplementation(async () => {
        calls.push('place');
        return {
          ok: true,
          provider,
          tradingAccountId: makeAccount(provider).id,
          orderId: 'ord-1',
        };
      });
      riskGuard.recordTradeExecuted.mockImplementation(async () => {
        calls.push('record');
      });

      const res = await service.placeOrder(
        'user-1',
        orderPayload({ tradingAccountId: makeAccount(provider).id }),
        'idem-1',
      );

      expect(res.ok).toBe(true);
      // Ordering is load-bearing: gate first, execute, then count.
      expect(calls).toEqual(['check', 'place', 'record']);
      expect(riskGuard.recordTradeExecuted).toHaveBeenCalledWith(
        'user-1',
        makeAccount(provider).id,
      );
    });
  });

  it('rithmic: forwards the REQUESTED volume unchanged so the server-side maxContracts clamp receives it', async () => {
    // execution-api itself does NOT clamp — the Apex maxContracts cap is applied
    // downstream in kai-backend (InternalRithmicController.placeOrder). This test
    // pins that execution-api hands the real requested qty (5) to the adapter,
    // which posts it to the backend where the clamp happens. If a future refactor
    // silently altered/dropped volume, the clamp input would be wrong.
    const { service, adapter } = makeHarness('rithmic');

    await service.placeOrder(
      'user-1',
      orderPayload({ volume: 5 }),
      'idem-1',
    );

    expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
    const forwardedRequest = adapter.placeOrder.mock.calls[0][1];
    expect(forwardedRequest.volume).toBe(5);
  });

  it('rithmic: a real order without the confirmation text is rejected before any risk/broker call', async () => {
    const { service, riskGuard, adapter } = makeHarness('rithmic');

    await expect(
      service.placeOrder(
        'user-1',
        orderPayload({ confirmationText: 'nope' }),
        'idem-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(riskGuard.checkRiskLimits).not.toHaveBeenCalled();
    expect(adapter.placeOrder).not.toHaveBeenCalled();
  });

  it('rithmic: a real order without an Idempotency-Key is rejected', async () => {
    const { service, adapter } = makeHarness('rithmic');

    await expect(
      service.placeOrder('user-1', orderPayload(), ''),
    ).rejects.toThrow('Idempotency-Key');
    expect(adapter.placeOrder).not.toHaveBeenCalled();
  });

  it('rithmic: a dry-run still runs the risk check but never fills or records', async () => {
    const { service, riskGuard, adapter } = makeHarness('rithmic');

    const res = await service.placeOrder(
      'user-1',
      orderPayload({ dryRun: true }),
      undefined,
    );

    expect(res.dryRun).toBe(true);
    expect(riskGuard.checkRiskLimits).toHaveBeenCalledTimes(1);
    expect(adapter.placeOrder).not.toHaveBeenCalled();
    expect(riskGuard.recordTradeExecuted).not.toHaveBeenCalled();
  });
});
