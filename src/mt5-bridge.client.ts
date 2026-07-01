import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ExecuteMarketOrderParams {
  accountId: string;
  symbol: string;
  type: 'buy' | 'sell';
  volume: number;
  sl?: number;
  tp?: number;
  comment?: string;
  magic?: number;
  requireStops?: boolean;
  allowStopFallback?: boolean;
  idempotencyKey?: string;
}

export interface ExecuteMarketOrderResult {
  ok: boolean;
  data?: {
    ticket?: number;
    deal?: number;
    price?: number;
    sl?: number;
    tp?: number;
  };
  error?: string;
}

export interface ModifyPositionParams {
  accountId: string;
  ticket: string;
  sl: number;
  tp: number;
}

export interface ClosePositionParams {
  accountId: string;
  ticket: string;
  volume?: number;
}

export interface ClosePositionResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

@Injectable()
export class Mt5BridgeClient {
  private readonly logger = new Logger(Mt5BridgeClient.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(configService: ConfigService) {
    this.baseUrl = (configService.get<string>('MT5_BRIDGE_URL') || 'http://localhost:8001').replace(/\/$/, '');
    this.apiKey = configService.get<string>('MT5_BRIDGE_API_KEY') || '';
    this.timeoutMs = 15000;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          ...(extraHeaders ?? {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`MT5 bridge ${method} ${path} failed: ${response.status} ${text}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async executeMarketOrder(params: ExecuteMarketOrderParams): Promise<ExecuteMarketOrderResult> {
    try {
      const { idempotencyKey, ...orderParams } = params;
      // The bridge exposes market order placement at POST /orders (the
      // /orders/market alias isn't present on the deployed bridge build).
      const data = await this.request<{ ticket?: number; deal?: number; price?: number; sl?: number; tp?: number }>(
        'POST',
        '/orders',
        orderParams,
        idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
      );
      return { ok: true, data };
    } catch (error) {
      this.logger.warn(`executeMarketOrder failed: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async modifyPosition(params: ModifyPositionParams): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
    try {
      const data = await this.request<Record<string, unknown>>(
        'PATCH',
        `/positions/${params.ticket}`,
        { sl: params.sl, tp: params.tp },
      );
      return { ok: true, data };
    } catch (error) {
      this.logger.warn(`modifyPosition failed: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async closePosition(params: ClosePositionParams): Promise<ClosePositionResult> {
    try {
      // The deployed bridge closes via DELETE /positions/{ticket} (optional
      // {volume} body for partial closes); there is no POST .../close route.
      const data = await this.request<Record<string, unknown>>(
        'DELETE',
        `/positions/${params.ticket}`,
        params.volume != null ? { volume: params.volume } : undefined,
      );
      return { ok: true, data };
    } catch (error) {
      this.logger.warn(`closePosition failed: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async fetchPositions(accountId: string): Promise<unknown[]> {
    try {
      const data = await this.request<unknown[]>(
        'GET',
        `/positions?accountId=${encodeURIComponent(accountId)}`,
      );
      return data;
    } catch (error) {
      this.logger.warn(`fetchPositions failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
}
