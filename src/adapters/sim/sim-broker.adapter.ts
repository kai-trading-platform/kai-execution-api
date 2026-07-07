import { Injectable, Logger } from '@nestjs/common';
import type { BrokerAdapter } from '../../core/broker-adapter.interface';
import type {
  BrokerCapabilities,
  BrokerCapability,
  ClosePositionRequest,
  ClosePositionResult,
  PlaceOrderRequest,
  PlaceOrderResult,
  TradingAccountContext,
  TradingPosition,
  UpdatePositionStopsRequest,
  UpdatePositionStopsResult,
} from '../../core/types';
import { PrismaService } from '../../common/prisma.service';
import { YahooPriceClient } from './yahoo-price.client';
import { resolveSimContract } from './sim-contracts';

/**
 * Ticket namespace for SIM fills. High enough to never collide with real MT5
 * tickets synced into the same table; the random suffix keeps concurrent SIM
 * fills apart (uniqueness is also enforced by the [accountId, ticket] unique).
 */
const SIM_TICKET_BASE = 910_000_000_000n;

/**
 * Broker adapter for SIM accounts (emulated funding, mt5_accounts.provider =
 * 'sim'). There is no external broker: positions are `synced_trades` rows
 * (status 'open') owned by the account, fills are marked against the last
 * Yahoo Finance price for the contract, and realized PnL settles straight
 * into `mt5_accounts.balance`. Row shapes (KAI_META comment, LONG/SHORT side,
 * filled/closedAt/pnl on close) match what kai-backend's sim engine writes so
 * the Journal/Orders pipelines treat both identically.
 */
@Injectable()
export class SimBrokerAdapter implements BrokerAdapter {
  private readonly logger = new Logger(SimBrokerAdapter.name);

  readonly provider = 'sim' as const;

  // Same capability set as the MT5 adapter: positions + market order + close
  // + stops. No flatten/cancel/reverse (those stay Rithmic-only).
  readonly capabilities: BrokerCapabilities = {
    listAccounts: true,
    listPositions: true,
    placeMarketOrder: true,
    closePosition: true,
    updateStops: true,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly yahoo: YahooPriceClient,
  ) {}

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
    const rows = await this.prisma.syncedTrade.findMany({
      where: { accountId: account.id, status: 'open' },
      orderBy: { openedAt: 'desc' },
    });

    // One Yahoo lookup per distinct symbol; a pricing outage must not hide
    // open positions, so failures fall back to the entry price (flat PnL).
    const priceBySymbol = new Map<string, number | null>();
    for (const row of rows) {
      if (!priceBySymbol.has(row.symbol)) {
        priceBySymbol.set(
          row.symbol,
          await this.tryGetLastPrice(row.symbol),
        );
      }
    }

    return rows.map((row) => {
      const side = String(row.side).toUpperCase() === 'LONG' ? 'buy' : 'sell';
      const direction = side === 'buy' ? 1 : -1;
      const entryPrice = Number(row.price);
      const volume = Number(row.qty);
      const contract = resolveSimContract(row.symbol);
      const livePrice = priceBySymbol.get(row.symbol) ?? null;
      const currentPrice = livePrice ?? entryPrice;
      const profitLoss = contract
        ? this.round2(
            (currentPrice - entryPrice) *
              direction *
              contract.pointValue *
              volume,
          )
        : 0;

      return {
        id: String(row.ticket),
        tradingAccountId: account.id,
        provider: this.provider,
        symbol: row.symbol,
        side,
        volume,
        entryPrice,
        currentPrice,
        stopLoss: this.toNumberOrNull(row.sl),
        takeProfit: this.toNumberOrNull(row.tp),
        profitLoss,
        openedAt: row.openedAt ? row.openedAt.toISOString() : null,
        comment: row.comment ?? null,
        magic: row.magic ?? null,
      };
    });
  }

  async placeOrder(
    account: TradingAccountContext,
    request: PlaceOrderRequest,
  ): Promise<PlaceOrderResult> {
    const contract = resolveSimContract(request.symbol);
    if (!contract) {
      return {
        ok: false,
        provider: this.provider,
        tradingAccountId: account.id,
        message: `SIM contract not supported: ${request.symbol}`,
      };
    }

    let lastPrice: number;
    try {
      lastPrice = await this.yahoo.getLastPrice(contract.yahooSymbol);
    } catch (error) {
      this.logger.error(
        `SIM order price lookup failed for ${contract.yahooSymbol}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        ok: false,
        provider: this.provider,
        tradingAccountId: account.id,
        message: 'SIM price unavailable, order not placed',
      };
    }

    // Market fill = last price with 1 tick of adverse slippage.
    const direction = request.side === 'buy' ? 1 : -1;
    const fillPrice = this.roundToTick(
      lastPrice + direction * contract.tickSize,
      contract.tickSize,
    );
    const ticket = this.newTicket();
    const openedAt = new Date();

    const row = await this.prisma.syncedTrade.create({
      data: {
        userId: account.userId,
        accountId: account.id,
        ticket,
        symbol: request.symbol,
        side: request.side === 'buy' ? 'LONG' : 'SHORT',
        qty: request.volume,
        price: fillPrice,
        sl: request.stopLoss ?? null,
        tp: request.takeProfit ?? null,
        status: 'open',
        openedAt,
        magic: request.magic ?? account.customMagicNumber ?? null,
        comment: this.kaiMeta({
          entryPrice: fillPrice,
          reason: null,
          closeSource: 'sim',
        }),
      },
    });

    return {
      ok: true,
      provider: this.provider,
      tradingAccountId: account.id,
      orderId: String(ticket),
      raw: {
        ticket: String(ticket),
        symbol: request.symbol,
        side: request.side,
        volume: request.volume,
        fillPrice,
        openedAt: openedAt.toISOString(),
        syncedTradeId: row.id,
      },
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

    const row = await this.prisma.syncedTrade.findFirst({
      where: {
        accountId: account.id,
        ticket: BigInt(request.ticket),
        status: 'open',
      },
    });
    if (!row) {
      return {
        success: false,
        provider: this.provider,
        tradingAccountId: account.id,
        ticket: request.ticket,
        message: `SIM position not found or already closed: ${request.ticket}`,
      };
    }

    const contract = resolveSimContract(row.symbol);
    if (!contract) {
      return {
        success: false,
        provider: this.provider,
        tradingAccountId: account.id,
        ticket: request.ticket,
        message: `SIM contract not supported: ${row.symbol}`,
      };
    }

    let lastPrice: number;
    try {
      lastPrice = await this.yahoo.getLastPrice(contract.yahooSymbol);
    } catch (error) {
      this.logger.error(
        `SIM close price lookup failed for ${contract.yahooSymbol}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        success: false,
        provider: this.provider,
        tradingAccountId: account.id,
        ticket: request.ticket,
        message: 'SIM price unavailable, position not closed',
      };
    }

    const closePrice = this.roundToTick(lastPrice, contract.tickSize);
    const entryPrice = Number(row.price);
    const openQty = Number(row.qty);
    const requestedQty = this.normalizeVolume(request.volume, openQty);
    const isPartial = requestedQty < openQty;
    const direction = String(row.side).toUpperCase() === 'LONG' ? 1 : -1;
    const pnl = this.round2(
      (closePrice - entryPrice) * direction * contract.pointValue * requestedQty -
        contract.commissionRT * requestedQty,
    );
    const closedAt = new Date();
    const closeComment = this.kaiMeta({
      entryPrice,
      closePrice,
      reason: 'CLIENT',
      closeSource: 'sim',
    });

    let closedTicket = row.ticket;
    if (isPartial) {
      // Partial close: shrink the open position and record the closed slice
      // as its own filled row, linked back via position_id = original ticket.
      closedTicket = this.newTicket();
      await this.prisma.syncedTrade.update({
        where: { id: row.id },
        data: { qty: { decrement: requestedQty } },
      });
      await this.prisma.syncedTrade.create({
        data: {
          userId: row.userId,
          accountId: row.accountId,
          ticket: closedTicket,
          positionId: row.ticket,
          symbol: row.symbol,
          side: row.side,
          qty: requestedQty,
          price: entryPrice,
          sl: row.sl,
          tp: row.tp,
          pnl,
          status: 'filled',
          openedAt: row.openedAt,
          closedAt,
          magic: row.magic,
          comment: closeComment,
        },
      });
    } else {
      await this.prisma.syncedTrade.update({
        where: { id: row.id },
        data: {
          status: 'filled',
          pnl,
          closedAt,
          comment: closeComment,
        },
      });
    }

    // Settle the realized PnL (commissions included) into the account balance.
    await this.prisma.mt5Account.update({
      where: { id: account.id },
      data: { balance: { increment: pnl } },
    });

    return {
      success: true,
      provider: this.provider,
      tradingAccountId: account.id,
      ticket: request.ticket,
      raw: {
        ticket: String(closedTicket),
        symbol: row.symbol,
        closedVolume: requestedQty,
        remainingVolume: isPartial ? this.round2(openQty - requestedQty) : 0,
        entryPrice,
        closePrice,
        pnl,
        partial: isPartial,
      },
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

    const result = await this.prisma.syncedTrade.updateMany({
      where: {
        accountId: account.id,
        ticket: BigInt(request.ticket),
        status: 'open',
      },
      data: {
        sl: request.stopLoss,
        tp: request.takeProfit,
      },
    });

    if (result.count === 0) {
      return {
        success: false,
        provider: this.provider,
        tradingAccountId: account.id,
        ticket: request.ticket,
        stopLoss: request.stopLoss,
        takeProfit: request.takeProfit,
        message: `SIM position not found or already closed: ${request.ticket}`,
      };
    }

    return {
      success: true,
      provider: this.provider,
      tradingAccountId: account.id,
      ticket: request.ticket,
      stopLoss: request.stopLoss,
      takeProfit: request.takeProfit,
      raw: { updated: result.count },
    };
  }

  private async tryGetLastPrice(symbol: string): Promise<number | null> {
    const contract = resolveSimContract(symbol);
    if (!contract) return null;
    try {
      return await this.yahoo.getLastPrice(contract.yahooSymbol);
    } catch (error) {
      this.logger.warn(
        `SIM price lookup failed for ${contract.yahooSymbol}, falling back to entry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** Clamp an optional partial-close volume to (0, openQty]. */
  private normalizeVolume(
    requested: number | null | undefined,
    openQty: number,
  ): number {
    const volume = Number(requested);
    if (!Number.isFinite(volume) || volume <= 0) return openQty;
    return Math.min(volume, openQty);
  }

  private newTicket(): bigint {
    return SIM_TICKET_BASE + BigInt(Math.floor(Math.random() * 1_000_000_000));
  }

  private kaiMeta(meta: Record<string, unknown>): string {
    return `KAI_META:${JSON.stringify(meta)}`;
  }

  private roundToTick(price: number, tickSize: number): number {
    // All SIM tick sizes have <= 2 decimals, so 2-decimal normalization is
    // enough to strip the float noise from the division/multiplication.
    return Number((Math.round(price / tickSize) * tickSize).toFixed(2));
  }

  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
}
