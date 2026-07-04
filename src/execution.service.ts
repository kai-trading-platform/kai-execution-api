import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import { PrismaService } from './common/prisma.service';
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

// Confirmation token both UIs must send — only after the user confirms (exec-ui
// AlertDialog) or types it (kai-frontend) — before any real (dryRun:false)
// order/close/stop executes. Value kept as the existing shared phrase so both
// frontends pass without a coordinated rename (the "DEMO" wording is legacy and
// can be renamed later in lockstep across both UIs).
const REQUIRED_CONFIRMATION_TEXT = 'EJECUTAR DEMO';

@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);

  constructor(
    private readonly query: QueryService,
    private readonly brokerRegistry: BrokerRegistryService,
    private readonly riskGuard: RiskGuardClient,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Enforce the confirmation gate for real operations. Previously the backend
   * parsed confirmationText but never checked it, so dryRun:false executed with
   * no effective confirmation. Dry-runs are exempt (they never execute).
   */
  private assertRealConfirmation(req: {
    dryRun?: boolean;
    confirmationText?: string | null;
  }): void {
    if (req.dryRun === true) return;
    if ((req.confirmationText ?? '').trim() !== REQUIRED_CONFIRMATION_TEXT) {
      throw new BadRequestException(
        'Confirmación requerida para ejecutar una operación real',
      );
    }
  }

  async placeOrder(
    userId: string,
    payload: unknown,
    idempotencyKey?: string,
  ): Promise<PlaceOrderResult> {
    const request = this.parsePlaceOrderRequest(payload);
    this.assertRealConfirmation(request);
    const normalizedKey = (idempotencyKey ?? '').trim();

    // Real (non-dry-run) orders MUST carry an idempotency key so a client retry
    // after a timeout cannot place a second order. Dry-runs don't execute, so
    // they are exempt.
    if (request.dryRun !== true && !normalizedKey) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
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

    // Atomically claim the idempotency key. A retry with the same key either
    // replays the stored result or is rejected as in-progress — never executes twice.
    const requestHash = this.hashOrderRequest(account.id, request);
    const claim = await this.claimIdempotency(
      normalizedKey,
      userId,
      account.id,
      requestHash,
    );
    if (claim.replay) {
      return claim.response;
    }

    let result: PlaceOrderResult;
    try {
      result = await adapter.placeOrder(account, request, normalizedKey);
    } catch (error) {
      // AMBIGUOUS failure: a thrown error (network timeout, dropped connection
      // mid-send) means the order MAY already have reached the broker. We must
      // NOT mark the key FAILED, because that would let a retry re-send it under
      // the same key → DOUBLE execution. Instead we leave the key CLAIMED
      // (IN_PROGRESS) so any retry is rejected: the client must reconcile (check
      // open positions/orders) and, if needed, place a new order with a NEW key.
      // Only CLEAN broker rejections (result.ok === false, below) are marked
      // FAILED to allow a safe retry — there the order provably did not execute.
      throw error;
    }

    if (!result.ok) {
      await this.markIdempotencyFailed(normalizedKey);
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

    await this.markIdempotencyCompleted(normalizedKey, result);
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

  private hashOrderRequest(
    accountId: string,
    request: PlaceOrderRequest,
  ): string {
    const fingerprint = [
      accountId,
      request.symbol,
      request.side,
      request.volume,
      request.stopLoss ?? '',
      request.takeProfit ?? '',
    ].join('|');
    return createHash('sha256').update(fingerprint).digest('hex');
  }

  private async claimIdempotency(
    key: string,
    userId: string,
    tradingAccountId: string,
    requestHash: string,
  ): Promise<{ replay: false } | { replay: true; response: PlaceOrderResult }> {
    try {
      await this.prisma.orderIdempotency.create({
        data: { key, userId, tradingAccountId, requestHash, status: 'IN_PROGRESS' },
      });
      return { replay: false };
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') {
        throw error;
      }
    }

    // Key already exists — decide based on its current state.
    const existing = await this.prisma.orderIdempotency.findUnique({
      where: { key },
    });
    if (!existing) {
      // Row vanished between conflict and read (rare) — treat as a fresh claim.
      return { replay: false };
    }
    if (existing.requestHash !== requestHash) {
      throw new UnprocessableEntityException(
        'Idempotency-Key was reused with a different order payload',
      );
    }
    if (existing.status === 'COMPLETED') {
      return {
        replay: true,
        response: existing.responseJson as unknown as PlaceOrderResult,
      };
    }
    if (existing.status === 'IN_PROGRESS') {
      // Either a concurrent request is genuinely in flight, OR a prior attempt
      // failed ambiguously (the order may have reached the broker). In both
      // cases retrying under the same key is unsafe — block it. The client must
      // verify whether the order was placed and use a NEW key to retry.
      throw new ConflictException(
        'This Idempotency-Key is already claimed (request in flight or a prior attempt failed ambiguously). Verify whether the order was placed; retry only with a new Idempotency-Key.',
      );
    }
    // FAILED — allow a retry by reclaiming the key.
    await this.prisma.orderIdempotency.update({
      where: { key },
      data: { status: 'IN_PROGRESS', requestHash },
    });
    return { replay: false };
  }

  private async markIdempotencyCompleted(
    key: string,
    result: PlaceOrderResult,
  ): Promise<void> {
    if (!key) return;
    await this.prisma.orderIdempotency.update({
      where: { key },
      data: {
        status: 'COMPLETED',
        responseJson: result as unknown as object,
        orderId: result.orderId ?? null,
      },
    });
  }

  private async markIdempotencyFailed(key: string): Promise<void> {
    if (!key) return;
    await this.prisma.orderIdempotency
      .update({ where: { key }, data: { status: 'FAILED' } })
      .catch(() => undefined);
  }

  async closePosition(
    userId: string,
    ticket: string,
    payload: unknown,
  ): Promise<ClosePositionResult> {
    const request = this.parseClosePositionRequest(ticket, payload);
    this.assertRealConfirmation(request);
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
    this.assertRealConfirmation(request);
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
    // Optional reference/entry price. MT5 ignores it; Rithmic uses it to convert
    // absolute SL/TP into the bridge's tick-distance bracket. Additive + null by
    // default, so the MT5 path is unaffected.
    const entry = this.optionalPositiveNumber(body.entry);
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
      entry,
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
