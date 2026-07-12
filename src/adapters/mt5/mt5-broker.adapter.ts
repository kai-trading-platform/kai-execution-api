import { Injectable, Logger } from '@nestjs/common';
import type { BrokerAdapter } from '../../core/broker-adapter.interface';
import { mt5OrderResultSchema, mt5OrdersSchema, mt5PositionsSchema } from './mt5-schemas';
import type {
  BrokerCapability,
  BrokerCapabilities,
  ClosePositionRequest,
  ClosePositionResult,
  PlaceOrderRequest,
  PlaceOrderResult,
  TradingAccountContext,
  TradingOrder,
  TradingOrderKind,
  TradingPosition,
  UpdatePositionStopsRequest,
  UpdatePositionStopsResult,
} from '../../core/types';
import { Mt5BridgeClient } from '../../mt5-bridge.client';

@Injectable()
export class Mt5BrokerAdapter implements BrokerAdapter {
  private readonly logger = new Logger(Mt5BrokerAdapter.name);

  readonly provider = 'mt5' as const;

  readonly capabilities: BrokerCapabilities = {
    listAccounts: true,
    listPositions: true,
    listOrders: true,
    placeMarketOrder: true,
    closePosition: true,
    updateStops: true,
  };

  constructor(private readonly mt5Bridge: Mt5BridgeClient) {}

  supports(capability: BrokerCapability): boolean {
    switch (capability) {
      case 'list_accounts':
        return this.capabilities.listAccounts;
      case 'list_positions':
        return this.capabilities.listPositions;
      case 'list_orders':
        return this.capabilities.listOrders === true;
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
    const rawPositions = await this.mt5Bridge.fetchPositions(
      account.providerAccountId,
      account.bridgeInstance,
    );

    const parsed = mt5PositionsSchema.safeParse(rawPositions);
    if (!parsed.success) {
      this.logger.error(
        `MT5 positions response failed schema validation for account ${account.id}: ${parsed.error.message}`,
      );
      throw new Error('MT5 bridge returned positions in an unexpected shape');
    }
    const positions = parsed.data;

    const firstDefined = (...vals: unknown[]) =>
      vals.find((v) => v !== undefined && v !== null);

    return positions.map((position) => ({
      id: String(firstDefined(position.ticket, position.ticketId)),
      tradingAccountId: account.id,
      provider: this.provider,
      symbol: position.symbol,
      side: String(position.type).toLowerCase() === 'buy' ? 'buy' : 'sell',
      volume: Number(position.volume),
      entryPrice: Number(
        firstDefined(position.price_open, position.openPrice, position.entryPrice),
      ),
      currentPrice: Number(position.currentPrice),
      stopLoss: this.toNumberOrNull(firstDefined(position.sl, position.stopLoss)),
      takeProfit: this.toNumberOrNull(firstDefined(position.tp, position.takeProfit)),
      profitLoss: Number(firstDefined(position.profit, position.profitLoss) || 0),
      openedAt: this.parseMt5Time(
        firstDefined(position.time, position.openTime),
      ),
      comment: position.comment ?? null,
      magic: position.magic ?? null,
    }));
  }

  async listOrders(account: TradingAccountContext): Promise<TradingOrder[]> {
    const rawOrders = await this.mt5Bridge.fetchOrders(account.bridgeInstance);

    const parsed = mt5OrdersSchema.safeParse(rawOrders);
    if (!parsed.success) {
      this.logger.error(
        `MT5 orders response failed schema validation for account ${account.id}: ${parsed.error.message}`,
      );
      throw new Error('MT5 bridge returned orders in an unexpected shape');
    }

    const firstDefined = (...vals: unknown[]) =>
      vals.find((v) => v !== undefined && v !== null);

    return parsed.data.map((order) => {
      // Bridge order type is e.g. 'buy_limit' | 'sell_stop' | 'buy_stop_limit'.
      const rawType = String(order.type).toLowerCase();
      const side: 'buy' | 'sell' = rawType.startsWith('sell') ? 'sell' : 'buy';
      const kind: TradingOrderKind = rawType.includes('stop_limit')
        ? 'stop_limit'
        : rawType.includes('stop')
          ? 'stop'
          : rawType.includes('limit')
            ? 'limit'
            : 'other';
      return {
        id: String(firstDefined(order.ticket, order.ticketId)),
        tradingAccountId: account.id,
        provider: this.provider,
        symbol: order.symbol,
        side,
        type: kind,
        volume: Number(firstDefined(order.volume) ?? 0),
        price: this.toNumberOrNull(
          firstDefined(order.openPrice, order.price, order.price_open),
        ),
        stopLoss: this.toNumberOrNull(firstDefined(order.sl, order.stopLoss)),
        takeProfit: this.toNumberOrNull(firstDefined(order.tp, order.takeProfit)),
        placedAt: this.parseMt5Time(firstDefined(order.openTime, order.time)),
        comment: order.comment ?? null,
        magic: order.magic ?? null,
      };
    });
  }

  async placeOrder(
    account: TradingAccountContext,
    request: PlaceOrderRequest,
    idempotencyKey?: string,
  ): Promise<PlaceOrderResult> {
    const result = await this.mt5Bridge.executeMarketOrder({
      accountId: account.providerAccountId,
      bridgeInstance: account.bridgeInstance,
      symbol: request.symbol,
      type: request.side,
      volume: request.volume,
      sl: request.stopLoss ?? undefined,
      tp: request.takeProfit ?? undefined,
      comment: request.comment ?? account.customComment ?? undefined,
      magic: request.magic ?? account.customMagicNumber ?? undefined,
      requireStops: false,
      idempotencyKey,
    });

    if (!result.ok) {
      return {
        ok: false,
        provider: this.provider,
        tradingAccountId: account.id,
        message: result.error || 'Order execution failed',
      };
    }

    const parsed = mt5OrderResultSchema.safeParse(result.data ?? {});
    if (!parsed.success) {
      this.logger.error(
        `MT5 order result failed schema validation for account ${account.id}: ${parsed.error.message}`,
      );
      return {
        ok: false,
        provider: this.provider,
        tradingAccountId: account.id,
        message: 'MT5 bridge returned an order result in an unexpected shape',
      };
    }

    const raw = parsed.data as Record<string, unknown>;
    return {
      ok: true,
      provider: this.provider,
      tradingAccountId: account.id,
      orderId: this.resolveOrderId(raw),
      raw,
    };
  }

  async closePosition(
    account: TradingAccountContext,
    request: ClosePositionRequest,
  ): Promise<ClosePositionResult> {
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

    const result = await this.mt5Bridge.closePosition({
      accountId: account.providerAccountId,
      bridgeInstance: account.bridgeInstance,
      ticket: request.ticket,
    });

    if (!result.ok) {
      return {
        success: false,
        provider: this.provider,
        tradingAccountId: account.id,
        ticket: request.ticket,
        message: result.error || 'Position close failed',
      };
    }

    return {
      success: true,
      provider: this.provider,
      tradingAccountId: account.id,
      ticket: request.ticket,
      raw: result.data,
    };
  }

  async updatePositionStops(
    account: TradingAccountContext,
    request: UpdatePositionStopsRequest,
  ): Promise<UpdatePositionStopsResult> {
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

    const result = await this.mt5Bridge.modifyPosition({
      accountId: account.providerAccountId,
      bridgeInstance: account.bridgeInstance,
      ticket: request.ticket,
      sl: request.stopLoss,
      tp: request.takeProfit,
    });

    if (!result.ok) {
      return {
        success: false,
        provider: this.provider,
        tradingAccountId: account.id,
        ticket: request.ticket,
        stopLoss: request.stopLoss,
        takeProfit: request.takeProfit,
        message: result.error || 'Position stops update failed',
      };
    }

    return {
      success: true,
      provider: this.provider,
      tradingAccountId: account.id,
      ticket: request.ticket,
      stopLoss: request.stopLoss,
      takeProfit: request.takeProfit,
      raw: result.data,
    };
  }

  private toNumberOrNull(value: unknown): number | null {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  /**
   * MT5 reports position open time as a unix timestamp in SECONDS. A bare
   * `new Date(seconds)` treats it as milliseconds and lands in 1970, so scale
   * up when the value looks like seconds. Also accepts ISO strings / ms values.
   */
  private parseMt5Time(value: unknown): string | null {
    if (value == null || value === '') return null;
    if (typeof value === 'string' && !/^\d+$/.test(value)) {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return null;
    // < 1e12 => seconds (anything in ms would be far larger for current dates).
    const ms = num < 1e12 ? num * 1000 : num;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  private resolveOrderId(raw: Record<string, unknown>): string | null {
    const candidates = [raw.orderId, raw.order_id, raw.ticket, raw.deal, raw.position];
    const value = candidates.find((candidate) => candidate != null);
    return value == null ? null : String(value);
  }
}
