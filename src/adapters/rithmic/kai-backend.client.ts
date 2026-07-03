import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Thin client for kai-backend's internal, READ-ONLY Rithmic endpoints. Reuses
 * the same internal channel as {@link RiskGuardClient} (KAI_BACKEND_INTERNAL_URL
 * + CRON_SECRET via the `x-cron-secret` header), so execution-api never touches
 * the Rithmic bridge directly — kai-backend's RithmicModule stays the single
 * owner of session/credential/spec logic.
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
}
