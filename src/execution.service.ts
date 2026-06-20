import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrokerRegistryService } from './core/broker-registry.service';
import type {
  ClosePositionRequest,
  ClosePositionResult,
  PlaceOrderRequest,
  PlaceOrderResult,
  UpdatePositionStopsRequest,
  UpdatePositionStopsResult,
  TradingAccountContext,
} from './core/types';
import { QueryService } from './query.service';
import { RiskGuardClient } from './risk-guard.client';

const REAL_EXECUTION_CONFIRMATION = 'EJECUTAR DEMO';
const DEMO_REAL_MAX_VOLUME = 0.01;

@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);

  constructor(
    private readonly query: QueryService,
    private readonly brokerRegistry: BrokerRegistryService,
    private readonly riskGuard: RiskGuardClient,
    private readonly configService: ConfigService,
  ) {}

  async placeOrder(
    userId: string,
    payload: unknown,
  ): Promise<PlaceOrderResult> {
    const request = this.parsePlaceOrderRequest(payload);
    const account = await this.query.getOwnedAccountContext(
      userId,
      request.tradingAccountId,
    );
    const adapter = this.brokerRegistry.get(account.provider);

    if (account.status.toLowerCase() !== 'connected') {
      throw new ForbiddenException('Trading account is not connected');
    }

    if (!adapter.supports('place_market_order')) {
      throw new ForbiddenException(
        `Provider ${account.provider} does not support market orders`,
      );
    }

    const riskCheck = await this.riskGuard.checkRiskLimits({
      userId,
      accountId: account.id,
      symbol: request.symbol,
      side: request.side,
      volume: request.volume,
    });
    if (!riskCheck.allowed) {
      this.auditExecution({
        userId,
        tradingAccountId: account.id,
        provider: account.provider,
        action: 'open_order',
        dryRun: request.dryRun === true,
        symbol: request.symbol,
        success: false,
        message: riskCheck.reason || 'RiskGuard blocked this operation',
      });
      throw new ForbiddenException(
        riskCheck.reason || 'RiskGuard blocked this operation',
      );
    }

    if (request.dryRun === true) {
      const result = {
        ok: true,
        provider: account.provider,
        tradingAccountId: account.id,
        message: 'Dry-run validated. No order was executed.',
        dryRun: true,
      };
      this.auditExecution({
        userId,
        tradingAccountId: account.id,
        provider: account.provider,
        action: 'open_order',
        dryRun: true,
        symbol: request.symbol,
        success: true,
        message: result.message,
      });
      return result;
    }

    this.assertRealExecutionAllowed(account, request.confirmationText);
    if (request.volume > DEMO_REAL_MAX_VOLUME) {
      this.auditExecution({
        userId,
        tradingAccountId: account.id,
        provider: account.provider,
        action: 'open_order',
        dryRun: false,
        symbol: request.symbol,
        success: false,
        message: `volume must be <= ${DEMO_REAL_MAX_VOLUME} for demo real execution`,
      });
      throw new BadRequestException(
        `volume must be <= ${DEMO_REAL_MAX_VOLUME} for demo real execution`,
      );
    }

    const result = await adapter.placeOrder(account, request);
    if (!result.ok) {
      this.auditExecution({
        userId,
        tradingAccountId: account.id,
        provider: account.provider,
        action: 'open_order',
        dryRun: false,
        symbol: request.symbol,
        success: false,
        message: result.message || 'Order execution failed',
      });
      throw new BadRequestException(result.message || 'Order execution failed');
    }

    await this.riskGuard.recordTradeExecuted(userId, account.id);
    this.auditExecution({
      userId,
      tradingAccountId: account.id,
      provider: account.provider,
      action: 'open_order',
      dryRun: false,
      symbol: request.symbol,
      success: true,
      message: result.message || 'Order executed',
    });
    return result;
  }

  async closePosition(
    userId: string,
    ticket: string,
    payload: unknown,
  ): Promise<ClosePositionResult> {
    const request = this.parseClosePositionRequest(ticket, payload);
    const account = await this.query.getOwnedAccountContext(
      userId,
      request.tradingAccountId,
    );
    const adapter = this.brokerRegistry.get(account.provider);

    if (account.status.toLowerCase() !== 'connected') {
      throw new ForbiddenException('Trading account is not connected');
    }

    if (!adapter.supports('close_position')) {
      throw new ForbiddenException(
        `Provider ${account.provider} does not support closing positions`,
      );
    }

    let positions;
    try {
      positions = await adapter.listPositions(account);
    } catch (error) {
      throw new ServiceUnavailableException({
        code: 'TRADING_POSITIONS_UNAVAILABLE',
        message: 'No se pudo consultar posiciones del provider.',
        provider: account.provider,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    const position = positions.find((row) => row.id === request.ticket);
    if (!position) {
      throw new NotFoundException('Trading position not found');
    }

    const riskCheck = await this.riskGuard.checkRiskLimits({
      userId,
      accountId: account.id,
      symbol: position.symbol,
      side: position.side === 'buy' ? 'buy' : 'sell',
      volume: position.volume,
    });
    if (!riskCheck.allowed) {
      this.auditExecution({
        userId,
        tradingAccountId: account.id,
        provider: account.provider,
        action: 'close_position',
        dryRun: request.dryRun === true,
        symbol: position.symbol,
        ticket: position.id,
        success: false,
        message: riskCheck.reason || 'RiskGuard blocked this operation',
      });
      throw new ForbiddenException(
        riskCheck.reason || 'RiskGuard blocked this operation',
      );
    }

    if (request.dryRun !== true) {
      this.assertRealExecutionAllowed(account, request.confirmationText);
    }

    const result = await adapter.closePosition(account, request);
    if (!result.success) {
      this.auditExecution({
        userId,
        tradingAccountId: account.id,
        provider: account.provider,
        action: 'close_position',
        dryRun: request.dryRun === true,
        symbol: position.symbol,
        ticket: position.id,
        success: false,
        message: result.message || 'Position close failed',
      });
      throw new BadRequestException(result.message || 'Position close failed');
    }

    const response = {
      success: true,
      provider: account.provider,
      tradingAccountId: account.id,
      ticket: position.id,
      message:
        result.message ||
        (request.dryRun === true
          ? 'Dry-run close validated. No position was closed.'
          : 'Position closed.'),
      dryRun: request.dryRun === true,
    };
    this.auditExecution({
      userId,
      tradingAccountId: account.id,
      provider: account.provider,
      action: 'close_position',
      dryRun: request.dryRun === true,
      symbol: position.symbol,
      ticket: position.id,
      success: true,
      message: response.message,
    });
    return response;
  }

  async updatePositionStops(
    userId: string,
    ticket: string,
    payload: unknown,
  ): Promise<UpdatePositionStopsResult> {
    const request = this.parseUpdatePositionStopsRequest(ticket, payload);
    const account = await this.query.getOwnedAccountContext(
      userId,
      request.tradingAccountId,
    );
    const adapter = this.brokerRegistry.get(account.provider);

    if (account.status.toLowerCase() !== 'connected') {
      throw new ForbiddenException('Trading account is not connected');
    }

    if (!adapter.supports('update_position_stops')) {
      throw new ForbiddenException(
        `Provider ${account.provider} does not support updating position stops`,
      );
    }

    let positions;
    try {
      positions = await adapter.listPositions(account);
    } catch (error) {
      throw new ServiceUnavailableException({
        code: 'TRADING_POSITIONS_UNAVAILABLE',
        message: 'No se pudo consultar posiciones del provider.',
        provider: account.provider,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    const position = positions.find((row) => row.id === request.ticket);
    if (!position) {
      throw new NotFoundException('Trading position not found');
    }

    const riskCheck = await this.riskGuard.checkRiskLimits({
      userId,
      accountId: account.id,
      symbol: position.symbol,
      side: position.side === 'buy' ? 'buy' : 'sell',
      volume: position.volume,
    });
    if (!riskCheck.allowed) {
      this.auditExecution({
        userId,
        tradingAccountId: account.id,
        provider: account.provider,
        action: 'update_stops',
        dryRun: request.dryRun === true,
        symbol: position.symbol,
        ticket: position.id,
        success: false,
        message: riskCheck.reason || 'RiskGuard blocked this operation',
      });
      throw new ForbiddenException(
        riskCheck.reason || 'RiskGuard blocked this operation',
      );
    }

    if (request.dryRun !== true) {
      this.assertRealExecutionAllowed(account, request.confirmationText);
    }

    const result = await adapter.updatePositionStops(account, request);
    if (!result.success) {
      this.auditExecution({
        userId,
        tradingAccountId: account.id,
        provider: account.provider,
        action: 'update_stops',
        dryRun: request.dryRun === true,
        symbol: position.symbol,
        ticket: position.id,
        success: false,
        message: result.message || 'Position stops update failed',
      });
      throw new BadRequestException(
        result.message || 'Position stops update failed',
      );
    }

    const response = {
      success: true,
      provider: account.provider,
      tradingAccountId: account.id,
      ticket: position.id,
      stopLoss: request.stopLoss,
      takeProfit: request.takeProfit,
      message:
        result.message ||
        (request.dryRun === true
          ? 'Dry-run stops update validated. No position was modified.'
          : 'Position stops updated.'),
      dryRun: request.dryRun === true,
    };
    this.auditExecution({
      userId,
      tradingAccountId: account.id,
      provider: account.provider,
      action: 'update_stops',
      dryRun: request.dryRun === true,
      symbol: position.symbol,
      ticket: position.id,
      success: true,
      message: response.message,
    });
    return response;
  }

  private parsePlaceOrderRequest(payload: unknown): PlaceOrderRequest {
    const body =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};

    const tradingAccountId = String(body.tradingAccountId || '').trim();
    const symbol = String(body.symbol || '').trim();
    const side = String(body.side || '')
      .trim()
      .toLowerCase();
    const type = String(body.type || 'market')
      .trim()
      .toLowerCase();
    const volume = Number(body.volume);
    const stopLoss = this.optionalPositiveNumber(body.stopLoss);
    const takeProfit = this.optionalPositiveNumber(body.takeProfit);
    const magic =
      body.magic === null || body.magic === undefined || body.magic === ''
        ? null
        : Number(body.magic);

    if (!tradingAccountId) {
      throw new BadRequestException('tradingAccountId is required');
    }
    if (!symbol) {
      throw new BadRequestException('symbol is required');
    }
    if (side !== 'buy' && side !== 'sell') {
      throw new BadRequestException('side must be buy or sell');
    }
    if (type !== 'market') {
      throw new BadRequestException('Only market orders are supported');
    }
    if (!Number.isFinite(volume) || volume <= 0) {
      throw new BadRequestException('volume must be greater than 0');
    }
    if (stopLoss === null || takeProfit === null) {
      throw new BadRequestException('stopLoss and takeProfit are required');
    }
    if (magic !== null && (!Number.isFinite(magic) || magic < 0)) {
      throw new BadRequestException('magic must be a non-negative number');
    }
    if (body.dryRun !== true && body.dryRun !== false) {
      throw new BadRequestException('dryRun must be true or false');
    }

    return {
      tradingAccountId,
      symbol,
      side,
      type: 'market',
      volume,
      stopLoss,
      takeProfit,
      comment:
        body.comment === null || body.comment === undefined
          ? null
          : String(body.comment).trim(),
      magic,
      dryRun: body.dryRun === true,
      confirmationText:
        body.confirmationText === null || body.confirmationText === undefined
          ? null
          : String(body.confirmationText),
    };
  }

  private optionalPositiveNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return null;
    return num;
  }

  private parseClosePositionRequest(
    ticket: string,
    payload: unknown,
  ): ClosePositionRequest {
    const body =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};

    const tradingAccountId = String(body.tradingAccountId || '').trim();
    const normalizedTicket = String(ticket || '').trim();

    if (!normalizedTicket) {
      throw new BadRequestException('ticket is required');
    }
    if (!tradingAccountId) {
      throw new BadRequestException('tradingAccountId is required');
    }
    if (body.dryRun !== true && body.dryRun !== false) {
      throw new BadRequestException('dryRun must be true or false');
    }

    return {
      tradingAccountId,
      ticket: normalizedTicket,
      dryRun: body.dryRun === true,
      confirmationText:
        body.confirmationText === null || body.confirmationText === undefined
          ? null
          : String(body.confirmationText),
    };
  }

  private parseUpdatePositionStopsRequest(
    ticket: string,
    payload: unknown,
  ): UpdatePositionStopsRequest {
    const body =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};

    const tradingAccountId = String(body.tradingAccountId || '').trim();
    const normalizedTicket = String(ticket || '').trim();
    const stopLoss = this.optionalPositiveNumber(body.stopLoss);
    const takeProfit = this.optionalPositiveNumber(body.takeProfit);

    if (!normalizedTicket) {
      throw new BadRequestException('ticket is required');
    }
    if (!tradingAccountId) {
      throw new BadRequestException('tradingAccountId is required');
    }
    if (stopLoss === null) {
      throw new BadRequestException('stopLoss must be a positive number');
    }
    if (takeProfit === null) {
      throw new BadRequestException('takeProfit must be a positive number');
    }
    if (body.dryRun !== true && body.dryRun !== false) {
      throw new BadRequestException('dryRun must be true or false');
    }

    return {
      tradingAccountId,
      ticket: normalizedTicket,
      stopLoss,
      takeProfit,
      dryRun: body.dryRun === true,
      confirmationText:
        body.confirmationText === null || body.confirmationText === undefined
          ? null
          : String(body.confirmationText),
    };
  }

  private assertRealExecutionAllowed(
    account: TradingAccountContext,
    confirmationText?: string | null,
  ): void {
    if (!this.isRealExecutionEnabled()) {
      throw new ForbiddenException('Real trading execution is disabled');
    }

    if (!this.isDemoAccount(account)) {
      throw new ForbiddenException(
        'Real trading is only allowed for demo accounts in this phase.',
      );
    }

    if (confirmationText !== REAL_EXECUTION_CONFIRMATION) {
      throw new BadRequestException(
        `confirmationText must be ${REAL_EXECUTION_CONFIRMATION}`,
      );
    }
  }

  private isRealExecutionEnabled(): boolean {
    return (
      this.configService.get<boolean>('TRADING_REAL_EXECUTION_ENABLED') === true ||
      this.configService.get<string>('TRADING_REAL_EXECUTION_ENABLED') === 'true'
    );
  }

  private isDemoAccount(account: TradingAccountContext): boolean {
    const accountType = account.accountType.toLowerCase();
    const server = String(account.server || '').toLowerCase();
    return (
      accountType === 'demo' ||
      accountType === 'sandbox' ||
      server.includes('demo') ||
      server.includes('trial') ||
      server.includes('sandbox')
    );
  }

  private auditExecution(event: {
    userId: string;
    tradingAccountId: string;
    provider: string;
    action: 'open_order' | 'close_position' | 'update_stops';
    dryRun: boolean;
    symbol?: string;
    ticket?: string;
    success: boolean;
    message?: string;
  }): void {
    this.logger.log({
      event: 'trading_execution_attempt',
      ...event,
      timestamp: new Date().toISOString(),
    });
  }
}
