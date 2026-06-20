import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  recommendedRiskMultiplier?: number;
  mode?: string;
}

@Injectable()
export class RiskGuardClient {
  private readonly logger = new Logger(RiskGuardClient.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(configService: ConfigService) {
    this.baseUrl = (configService.get<string>('KAI_BACKEND_INTERNAL_URL') || 'http://localhost:3000').replace(/\/$/, '');
    this.apiKey = configService.get<string>('KAI_BACKEND_INTERNAL_API_KEY') || '';
    this.timeoutMs = 10000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-API-Key': this.apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`kai-backend ${method} ${path} failed: ${response.status} ${text}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async checkRiskLimits(params: {
    userId: string;
    accountId: string;
    symbol: string;
    side: 'buy' | 'sell';
    volume: number;
  }): Promise<RiskCheckResult> {
    try {
      return await this.request<RiskCheckResult>('POST', '/internal/risk/check-limits', params);
    } catch (error) {
      this.logger.error(`checkRiskLimits failed: ${error instanceof Error ? error.message : String(error)}`);
      return { allowed: false, reason: 'RiskGuard unavailable' };
    }
  }

  async recordTradeExecuted(userId: string, accountId: string): Promise<void> {
    try {
      await this.request('POST', '/internal/risk/record-trade', { userId, accountId });
    } catch (error) {
      this.logger.warn(`recordTradeExecuted failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getDailyTradeCounter(userId: string): Promise<{ count: number; lastReset: string }> {
    try {
      return await this.request<{ count: number; lastReset: string }>('GET', `/internal/risk/daily-counter/${userId}`);
    } catch (error) {
      this.logger.warn(`getDailyTradeCounter failed: ${error instanceof Error ? error.message : String(error)}`);
      return { count: 0, lastReset: new Date().toISOString() };
    }
  }
}
