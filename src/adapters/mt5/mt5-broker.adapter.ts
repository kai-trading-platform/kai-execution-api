import { Injectable } from '@nestjs/common';
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
import { Mt5BridgeClient } from '../../mt5-bridge.client';

@Injectable()
export class Mt5BrokerAdapter implements BrokerAdapter {
  readonly provider = 'mt5' as const;

  readonly capabilities: BrokerCapabilities = {
    listAccounts: true,
    listPositions: true,
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
    const positions = (await this.mt5Bridge.fetchPositions(account.providerAccountId)) as Array<{
      ticketId: number | string;
      symbol: string;
      type: string;
      volume: number | string;
      entryPrice: number | string;
      currentPrice: number | string;
      stopLoss?: number | string | null;
      takeProfit?: number | string | null;
      profitLoss?: number | string | null;
      openTime?: string;
      comment?: string | null;
      magic?: number | null;
    }>;

    return positions.map((position) => ({
      id: String(position.ticketId),
      tradingAccountId: account.id,
      provider: this.provider,
      symbol: position.symbol,
      side: position.type === 'BUY' ? 'buy' : 'sell',
      volume: Number(position.volume),
      entryPrice: Number(position.entryPrice),
      currentPrice: Number(position.currentPrice),
      stopLoss: this.toNumberOrNull(position.stopLoss),
      takeProfit: this.toNumberOrNull(position.takeProfit),
      profitLoss: Number(position.profitLoss || 0),
      openedAt: position.openTime ? new Date(position.openTime).toISOString() : null,
      comment: position.comment ?? null,
      magic: position.magic ?? null,
    }));
  }

  async placeOrder(
    account: TradingAccountContext,
    request: PlaceOrderRequest,
  ): Promise<PlaceOrderResult> {
    const result = await this.mt5Bridge.executeMarketOrder({
      accountId: account.providerAccountId,
      symbol: request.symbol,
      type: request.side,
      volume: request.volume,
      sl: request.stopLoss ?? undefined,
      tp: request.takeProfit ?? undefined,
      comment: request.comment ?? account.customComment ?? undefined,
      magic: request.magic ?? account.customMagicNumber ?? undefined,
      requireStops: true,
      allowStopFallback: false,
    });

    if (!result.ok) {
      return {
        ok: false,
        provider: this.provider,
        tradingAccountId: account.id,
        message: result.error || 'Order execution failed',
      };
    }

    const raw = (result.data ?? {}) as Record<string, unknown>;
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

  private resolveOrderId(raw: Record<string, unknown>): string | null {
    const candidates = [raw.orderId, raw.order_id, raw.ticket, raw.deal, raw.position];
    const value = candidates.find((candidate) => candidate != null);
    return value == null ? null : String(value);
  }
}
