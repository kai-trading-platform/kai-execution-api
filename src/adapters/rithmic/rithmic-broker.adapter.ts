import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BrokerAdapter } from '../../core/broker-adapter.interface';
import type {
  BrokerCapability,
  BrokerCapabilities,
  ClosePositionRequest,
  ClosePositionResult,
  PlaceOrderRequest,
  PlaceOrderResult,
  TradingAccountContext,
  TradingPosition,
  UpdatePositionStopsRequest,
  UpdatePositionStopsResult,
} from '../../core/types';
import { KaiBackendRithmicClient } from './kai-backend.client';
import {
  rithmicPlaceOrderResponseSchema,
  rithmicPositionsResponseSchema,
  rithmicWriteResponseSchema,
} from './rithmic-schemas';

/**
 * Feature flag env var. Rithmic (futures) order execution places REAL orders on
 * a funded Apex account, so it is gated OFF by default: only when
 * `RITHMIC_TERMINAL_ORDERS_ENABLED === 'true'` do the write paths delegate to
 * kai-backend. With the flag absent/false, every write throws {@link DISABLED}
 * and the capabilities report the writes as unavailable — the DEFAULT deployed
 * behaviour is unchanged (no live futures orders possible).
 */
const ORDERS_FLAG = 'RITHMIC_TERMINAL_ORDERS_ENABLED';

/**
 * Thrown by every write path while the flag is OFF. We throw loudly rather than
 * silently no-op so a mis-wired caller can never believe an order succeeded.
 * Keeps the historical "not supported yet" phrase so existing callers/tests that
 * match on it keep working.
 */
const DISABLED =
  'Rithmic (futures) order execution is disabled (not supported yet): set ' +
  `${ORDERS_FLAG}=true in kai-execution-api to enable it. Order placement, ` +
  'close, and stop modification stay off until then.';

@Injectable()
export class RithmicBrokerAdapter implements BrokerAdapter {
  private readonly logger = new Logger(RithmicBrokerAdapter.name);

  readonly provider = 'rithmic' as const;

  /** Resolved once at construction from the env flag (default false). */
  private readonly ordersEnabled: boolean;

  readonly capabilities: BrokerCapabilities;

  constructor(
    private readonly backend: KaiBackendRithmicClient,
    configService: ConfigService,
  ) {
    this.ordersEnabled =
      String(configService.get<string>(ORDERS_FLAG) ?? '')
        .trim()
        .toLowerCase() === 'true';

    this.capabilities = {
      listAccounts: true,
      listPositions: true,
      // Writes reflect the flag: false by default (no live futures orders).
      placeMarketOrder: this.ordersEnabled,
      closePosition: this.ordersEnabled,
      updateStops: this.ordersEnabled,
    };

    if (this.ordersEnabled) {
      this.logger.warn(
        `${ORDERS_FLAG}=true — Rithmic (futures) terminal order execution is ENABLED (live orders possible).`,
      );
    }
  }

  supports(capability: BrokerCapability): boolean {
    switch (capability) {
      case 'list_accounts':
        return this.capabilities.listAccounts;
      case 'list_positions':
        return this.capabilities.listPositions;
      case 'place_market_order':
        return this.capabilities.placeMarketOrder;
      case 'close_position':
        return this.capabilities.closePosition;
      case 'update_position_stops':
        return this.capabilities.updateStops;
      default:
        return false;
    }
  }

  async listPositions(
    account: TradingAccountContext,
  ): Promise<TradingPosition[]> {
    const raw = await this.backend.fetchPositions(account.id);

    const parsed = rithmicPositionsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.error(
        `Rithmic positions response failed schema validation for account ${account.id}: ${parsed.error.message}`,
      );
      throw new Error(
        'kai-backend returned Rithmic positions in an unexpected shape',
      );
    }

    return parsed.data.positions.map((position) => ({
      id: String(position.ticket),
      tradingAccountId: account.id,
      provider: this.provider,
      symbol: position.symbol,
      side: String(position.side).toLowerCase() === 'buy' ? 'buy' : 'sell',
      // Futures qty is an integer number of CONTRACTS.
      volume: Number(position.volume),
      entryPrice: Number(position.entryPrice),
      currentPrice: Number(position.currentPrice),
      stopLoss: this.toNumberOrNull(position.stopLoss),
      takeProfit: this.toNumberOrNull(position.takeProfit),
      profitLoss: Number(position.profitLoss) || 0,
      openedAt: position.openedAt ?? null,
      comment: null,
      magic: null,
    }));
  }

  private assertOrdersEnabled(): void {
    if (!this.ordersEnabled) {
      throw new Error(DISABLED);
    }
  }

  /**
   * Resolve a position's symbol from its ticket by re-reading positions. Rithmic
   * close/modify are keyed by SYMBOL (the bridge is symbol-scoped), but the
   * shared close/modify requests carry only a ticket.
   */
  private async resolveSymbolForTicket(
    account: TradingAccountContext,
    ticket: string,
  ): Promise<string> {
    const positions = await this.listPositions(account);
    const match = positions.find((p) => p.id === ticket);
    if (!match) {
      throw new Error(
        `Rithmic position not found for ticket ${ticket} on account ${account.id}`,
      );
    }
    return match.symbol;
  }

  async placeOrder(
    account: TradingAccountContext,
    request: PlaceOrderRequest,
  ): Promise<PlaceOrderResult> {
    this.assertOrdersEnabled();

    const raw = await this.backend.placeOrder({
      account: account.id,
      symbol: request.symbol,
      side: request.side,
      volume: request.volume,
      sl: request.stopLoss ?? null,
      tp: request.takeProfit ?? null,
      entry: request.entry ?? null,
      comment: request.comment ?? account.customComment ?? null,
    });

    const parsed = rithmicPlaceOrderResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.error(
        `Rithmic place-order response failed schema validation for account ${account.id}: ${parsed.error.message}`,
      );
      throw new Error(
        'kai-backend returned a Rithmic order result in an unexpected shape',
      );
    }

    return {
      ok: parsed.data.ok,
      provider: this.provider,
      tradingAccountId: account.id,
      orderId: parsed.data.orderId != null ? String(parsed.data.orderId) : null,
      message: parsed.data.message,
      raw: parsed.data,
    };
  }

  async closePosition(
    account: TradingAccountContext,
    request: ClosePositionRequest,
  ): Promise<ClosePositionResult> {
    this.assertOrdersEnabled();

    if (request.dryRun === true) {
      return {
        success: true,
        provider: this.provider,
        tradingAccountId: account.id,
        ticket: request.ticket,
        message: 'Dry-run close validated. No position was closed.',
        dryRun: true,
      };
    }

    const symbol = await this.resolveSymbolForTicket(account, request.ticket);
    const raw = await this.backend.closePosition({
      account: account.id,
      symbol,
    });

    const parsed = rithmicWriteResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        'kai-backend returned a Rithmic close result in an unexpected shape',
      );
    }

    return {
      success: parsed.data.ok,
      provider: this.provider,
      tradingAccountId: account.id,
      ticket: request.ticket,
      message: parsed.data.message,
      raw: parsed.data,
    };
  }

  async updatePositionStops(
    account: TradingAccountContext,
    request: UpdatePositionStopsRequest,
  ): Promise<UpdatePositionStopsResult> {
    this.assertOrdersEnabled();

    if (request.dryRun === true) {
      return {
        success: true,
        provider: this.provider,
        tradingAccountId: account.id,
        ticket: request.ticket,
        stopLoss: request.stopLoss,
        takeProfit: request.takeProfit,
        message: 'Dry-run stops update validated. No position was modified.',
        dryRun: true,
      };
    }

    const symbol = await this.resolveSymbolForTicket(account, request.ticket);
    const raw = await this.backend.modifyStops({
      account: account.id,
      symbol,
      sl: request.stopLoss,
      tp: request.takeProfit,
    });

    const parsed = rithmicWriteResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        'kai-backend returned a Rithmic stops result in an unexpected shape',
      );
    }

    return {
      success: parsed.data.ok,
      provider: this.provider,
      tradingAccountId: account.id,
      ticket: request.ticket,
      stopLoss: request.stopLoss,
      takeProfit: request.takeProfit,
      message: parsed.data.message,
      raw: parsed.data,
    };
  }

  private toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
}
