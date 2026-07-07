import { Injectable, Logger } from '@nestjs/common';

interface CacheEntry {
  price: number;
  at: number;
}

/**
 * Last-price client for SIM accounts backed by Yahoo Finance's public chart
 * API (no API key). Per-symbol 10s cache + single-flight so a burst of
 * position refreshes doesn't hammer Yahoo, and a query2 host fallback because
 * query1 occasionally rate-limits/hiccups.
 */
@Injectable()
export class YahooPriceClient {
  private readonly logger = new Logger(YahooPriceClient.name);
  private readonly cacheTtlMs = 10_000;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<number>>();

  async getLastPrice(yahooSymbol: string): Promise<number> {
    const cached = this.cache.get(yahooSymbol);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      return cached.price;
    }

    const pending = this.inflight.get(yahooSymbol);
    if (pending) return pending;

    const request = this.fetchPrice(yahooSymbol)
      .then((price) => {
        this.cache.set(yahooSymbol, { price, at: Date.now() });
        return price;
      })
      .finally(() => {
        this.inflight.delete(yahooSymbol);
      });

    this.inflight.set(yahooSymbol, request);
    return request;
  }

  private async fetchPrice(yahooSymbol: string): Promise<number> {
    try {
      return await this.fetchFromHost('query1.finance.yahoo.com', yahooSymbol);
    } catch (error) {
      this.logger.warn(
        `Yahoo query1 failed for ${yahooSymbol}, retrying on query2: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.fetchFromHost('query2.finance.yahoo.com', yahooSymbol);
    }
  }

  private async fetchFromHost(
    host: string,
    yahooSymbol: string,
  ): Promise<number> {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(
      yahooSymbol,
    )}?interval=1m&range=1d`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!response.ok) {
      throw new Error(`Yahoo chart HTTP ${response.status} for ${yahooSymbol}`);
    }

    const body: any = await response.json();
    const result = body?.chart?.result?.[0];

    const metaPrice = result?.meta?.regularMarketPrice;
    if (typeof metaPrice === 'number' && Number.isFinite(metaPrice)) {
      return metaPrice;
    }

    // Fallback: last non-null 1m close of the session.
    const closes: unknown[] = result?.indicators?.quote?.[0]?.close ?? [];
    for (let i = closes.length - 1; i >= 0; i--) {
      const close = closes[i];
      if (typeof close === 'number' && Number.isFinite(close)) {
        return close;
      }
    }

    throw new Error(`Yahoo chart returned no usable price for ${yahooSymbol}`);
  }
}
