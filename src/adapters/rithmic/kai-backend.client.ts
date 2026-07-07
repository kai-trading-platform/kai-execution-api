import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Thin client for kai-backend's internal, READ-ONLY Rithmic endpoints. Reuses
 * the same internal channel as {@link RiskGuardClient} (KAI_BACKEND_INTERNAL_URL
 * + CRON_SECRET via the `x-cron-secret` header), so execution-api never touches
 * the Rithmic bridge directly — kai-backend's RithmicModule stays the single
 * owner of session/credential/spec logic.
 *
 * Per-instance bridge routing (kai-rithmic-bridge vs kai-rithmic-bridge-2):
 * unlike MT5 (see Mt5BridgeClient's MT5_BRIDGE_URL_{n} resolution), there is
 * NO Rithmic bridge URL to resolve HERE. Every call carries the Kai trading-
 * account UUID and kai-backend resolves that account's
 * `mt5_accounts.bridge_instance` against RITHMIC_BRIDGE_URL_<n> server-side
 * (RithmicExecutionService / rithmic-endpoint.util). Do NOT add a
 * RITHMIC_BRIDGE_URL_* lookup in execution-api — it would bypass the single
 * owner of that routing rule.
 */
@Injectable()
export class KaiBackendRithmicClient {
  private readonly logger = new Logger(KaiBackendRithmicClient.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(configService: ConfigService) {
    this.baseUrl = (
      configService.get<string>('KAI_BACKEND_INTERNAL_URL') ||
      'http://localhost:3000'
    ).replace(/\/$/, '');
    this.apiKey = configService.get<string>('CRON_SECRET') || '';
    this.timeoutMs = 15000;
  }

  /**
   * Fetch a Rithmic account's open positions. Returns the raw `{ positions }`
   * envelope for the adapter to validate + map. Throws on any transport/HTTP
   * failure so the caller surfaces an outage instead of a misleading empty list.
   */
  async fetchPositions(accountId: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(
        `${this.baseUrl}/internal/rithmic/positions?account=${encodeURIComponent(accountId)}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'x-cron-secret': this.apiKey,
          },
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `kai-backend GET /internal/rithmic/positions failed: ${response.status} ${text}`,
        );
      }

      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Shared POST helper for the internal WRITE endpoints. Reuses the same
   * x-cron-secret channel. Throws on transport/HTTP failure so an ambiguous
   * write surfaces loudly (the caller never assumes success on error).
   */
  private async post(
    path: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cron-secret': this.apiKey,
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `kai-backend POST ${path} failed: ${response.status} ${text}`,
        );
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Place a MANUAL Rithmic market order (with optional SL/TP bracket). The Apex
   * `maxContracts` cap is applied server-side; the response echoes the clamped
   * volume. `account` is the Kai trading-account UUID.
   */
  async placeOrder(payload: {
    account: string;
    symbol: string;
    side: 'buy' | 'sell';
    volume: number;
    sl?: number | null;
    tp?: number | null;
    entry?: number | null;
    comment?: string | null;
  }): Promise<unknown> {
    return this.post('/internal/rithmic/orders', payload);
  }

  /** Close (flatten) a Rithmic position by symbol. */
  async closePosition(payload: {
    account: string;
    symbol: string;
  }): Promise<unknown> {
    return this.post('/internal/rithmic/positions/close', payload);
  }

  /** Modify a Rithmic position's SL/TP bracket (absolute prices) by symbol. */
  async modifyStops(payload: {
    account: string;
    symbol: string;
    sl?: number | null;
    tp?: number | null;
    volume?: number | null;
  }): Promise<unknown> {
    return this.post('/internal/rithmic/positions/bracket', payload);
  }

  /** FLATTEN ALL: close all positions AND cancel all working orders on an account. */
  async flattenAll(
    payload: { account: string },
    idempotencyKey?: string,
  ): Promise<unknown> {
    return this.post(
      '/internal/rithmic/positions/close-all',
      payload,
      idempotencyKey,
    );
  }

  /** CANCEL ALL: cancel all working orders (positions untouched) on an account. */
  async cancelAllOrders(
    payload: { account: string },
    idempotencyKey?: string,
  ): Promise<unknown> {
    return this.post(
      '/internal/rithmic/orders/cancel-all',
      payload,
      idempotencyKey,
    );
  }

  /**
   * REVERSE (flip) a Rithmic position by symbol. The maxContracts clamp and the
   * fail-closed per-trade risk gate are applied server-side; the response echoes
   * the clamped re-entry volume.
   */
  async reversePosition(
    payload: {
      account: string;
      symbol: string;
      sl?: number | null;
      tp?: number | null;
      entry?: number | null;
    },
    idempotencyKey?: string,
  ): Promise<unknown> {
    return this.post(
      '/internal/rithmic/positions/reverse',
      payload,
      idempotencyKey,
    );
  }
}
