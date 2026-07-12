import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ExecuteMarketOrderParams {
  accountId: string;
  /**
   * Docker slot of the per-account MT5 bridge (mt5_accounts.bridge_instance).
   * Routes the call to that account's bridge container; null/undefined falls
   * back to the default MT5_BRIDGE_URL.
   */
  bridgeInstance?: number | null;
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
  bridgeInstance?: number | null;
  ticket: string;
  sl: number;
  tp: number;
}

export interface ClosePositionParams {
  accountId: string;
  bridgeInstance?: number | null;
  ticket: string;
  volume?: number;
}

/** Resolved base URL + API key for one MT5 bridge container. */
interface Mt5BridgeEndpoint {
  baseUrl: string;
  apiKey: string;
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

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = (configService.get<string>('MT5_BRIDGE_URL') || 'http://localhost:8001').replace(/\/$/, '');
    this.apiKey = configService.get<string>('MT5_BRIDGE_API_KEY') || '';
    this.timeoutMs = 15000;
  }

  /**
   * Clamp a bridge-instance value to a sane routing range. Mirrors
   * backend-kai's Mt5BridgeEndpointService: routing identity uses a FIXED
   * ceiling (env MT5_MAX_INSTANCES_ABSOLUTE, default 512), never a dynamic
   * capacity value, so an already-assigned slot always resolves.
   */
  private normalizeBridgeInstance(value: unknown): number | null {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    const normalized = Math.floor(parsed);
    const ceilingRaw = Number(
      this.configService.get<string>('MT5_MAX_INSTANCES_ABSOLUTE', ''),
    );
    const ceiling =
      Number.isFinite(ceilingRaw) && ceilingRaw >= 1
        ? Math.floor(ceilingRaw)
        : 512;
    if (normalized < 1 || normalized > ceiling) return null;
    return normalized;
  }

  /**
   * Resolve the bridge container for one account. MT5 bridges are PER-ACCOUNT
   * Docker instances (mt5-bridge-1, mt5-bridge-2, …), so a single fixed
   * MT5_BRIDGE_URL only ever reaches the account that happens to live on that
   * slot — every other account silently sees no positions and, worse, would
   * route orders/closes to the WRONG account's bridge. Resolution order per
   * instance (mirrors backend-kai's Mt5BridgeEndpointService):
   *   1. MT5_BRIDGE_URL_{n}            (explicit per-slot override)
   *   2. MT5_BRIDGE_URL_TEMPLATE       ("http://mt5-bridge-{instance}:8001")
   *   3. derived from MT5_BRIDGE_URL   (host ending in "-<digits>" has its
   *      slot number swapped, e.g. http://mt5-bridge-1:8001 → ...-4:8001, so
   *      routing works without new env vars in the current deployment)
   *   4. MT5_BRIDGE_URL as-is          (default/single-bridge fallback)
   * API key: MT5_BRIDGE_API_KEY_{n} over the shared MT5_BRIDGE_API_KEY.
   */
  private resolveEndpoint(bridgeInstance?: number | null): Mt5BridgeEndpoint {
    const instance = this.normalizeBridgeInstance(bridgeInstance);
    if (!instance) {
      return { baseUrl: this.baseUrl, apiKey: this.apiKey };
    }

    const explicitUrl = String(
      this.configService.get<string>(`MT5_BRIDGE_URL_${instance}`, ''),
    ).trim();
    const templateUrl = String(
      this.configService.get<string>('MT5_BRIDGE_URL_TEMPLATE', ''),
    ).trim();

    let baseUrl = explicitUrl;
    if (!baseUrl && templateUrl) {
      baseUrl = templateUrl.replace('{instance}', String(instance));
    }
    if (!baseUrl) {
      // Derive from the default URL when it targets a numbered slot
      // (e.g. http://mt5-bridge-1:8001): swap the trailing slot number.
      baseUrl = this.baseUrl.replace(/-\d+(?=(?::\d+)?$)/, `-${instance}`);
    }
    baseUrl = (baseUrl || this.baseUrl).replace(/\/$/, '');

    const explicitApiKey = String(
      this.configService.get<string>(`MT5_BRIDGE_API_KEY_${instance}`, ''),
    ).trim();

    return { baseUrl, apiKey: explicitApiKey || this.apiKey };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    bridgeInstance?: number | null,
  ): Promise<T> {
    const endpoint = this.resolveEndpoint(bridgeInstance);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${endpoint.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': endpoint.apiKey,
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
      const { idempotencyKey, bridgeInstance, ...orderParams } = params;
      // The bridge exposes market order placement at POST /orders (the
      // /orders/market alias isn't present on the deployed bridge build).
      const data = await this.request<{ ticket?: number; deal?: number; price?: number; sl?: number; tp?: number }>(
        'POST',
        '/orders',
        orderParams,
        idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
        bridgeInstance,
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
        undefined,
        params.bridgeInstance,
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
        undefined,
        params.bridgeInstance,
      );
      return { ok: true, data };
    } catch (error) {
      this.logger.warn(`closePosition failed: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async fetchPositions(
    accountId: string,
    bridgeInstance?: number | null,
  ): Promise<unknown[]> {
    try {
      const data = await this.request<unknown[]>(
        'GET',
        `/positions?accountId=${encodeURIComponent(accountId)}`,
        undefined,
        undefined,
        bridgeInstance,
      );
      return data;
    } catch (error) {
      // Rethrow so QueryService.listPositions can surface a 503
      // (TRADING_POSITIONS_UNAVAILABLE) instead of a silent "no positions" —
      // returning [] here made a mis-routed/offline bridge indistinguishable
      // from a flat account.
      this.logger.warn(`fetchPositions failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async fetchOrders(bridgeInstance?: number | null): Promise<unknown[]> {
    try {
      // The bridge is per-instance (one MT5 terminal per bridge), so working
      // orders need no accountId filter — GET /orders returns this terminal's
      // pending orders. Rethrow so QueryService can surface a 503 rather than an
      // empty list that hides a mis-routed/offline bridge.
      const data = await this.request<unknown[]>(
        'GET',
        '/orders',
        undefined,
        undefined,
        bridgeInstance,
      );
      return data;
    } catch (error) {
      this.logger.warn(`fetchOrders failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}
