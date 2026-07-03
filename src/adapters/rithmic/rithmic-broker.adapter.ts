import { Injectable, Logger } from '@nestjs/common';
import type { BrokerAdapter } from '../../core/broker-adapter.interface';
import type {
  BrokerCapability,
  BrokerCapabilities,
  ClosePositionResult,
  PlaceOrderResult,
  TradingAccountContext,
  TradingPosition,
  UpdatePositionStopsResult,
} from '../../core/types';
import { KaiBackendRithmicClient } from './kai-backend.client';
import { rithmicPositionsResponseSchema } from './rithmic-schemas';

/**
 * Thrown by every write path. Rithmic (futures) order placement / close /
 * stop-modification are money-critical writes reserved for a later phase — this
 * adapter is READ-ONLY (positions). We throw loudly rather than silently no-op
 * so a mis-wired caller can never believe an order succeeded.
 */
const NOT_SUPPORTED =
  'Rithmic (futures) order execution is not supported yet: this is a read-only ' +
  'positions integration. Order placement, close, and stop modification will ' +
  'land in a later phase.';

@Injectable()
export class RithmicBrokerAdapter implements BrokerAdapter {
  private readonly logger = new Logger(RithmicBrokerAdapter.name);

  readonly provider = 'rithmic' as const;

  readonly capabilities: BrokerCapabilities = {
    listAccounts: true,
    listPositions: true,
    // Read-only for now: no writes to a live futures account.
    placeMarketOrder: false,
    closePosition: false,
    updateStops: false,
  };

  constructor(private readonly backend: KaiBackendRithmicClient) {}

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

  async placeOrder(): Promise<PlaceOrderResult> {
    throw new Error(NOT_SUPPORTED);
  }

  async closePosition(): Promise<ClosePositionResult> {
    throw new Error(NOT_SUPPORTED);
  }

  async updatePositionStops(): Promise<UpdatePositionStopsResult> {
    throw new Error(NOT_SUPPORTED);
  }

  private toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
}
