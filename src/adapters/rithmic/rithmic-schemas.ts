import { z } from 'zod';

/**
 * Zod schema for kai-backend's internal Rithmic positions response. kai-backend
 * already returns the provider-neutral RithmicOpenPosition shape; we still
 * validate here so a drift in the internal contract fails loudly instead of
 * coercing to NaN. Numeric fields tolerate number-or-string; the adapter
 * coalesces them.
 */
const numberOrString = z.union([z.number(), z.string()]);

export const rithmicPositionSchema = z
  .object({
    ticket: numberOrString,
    symbol: z.string(),
    securityCode: z.string().optional(),
    side: z.string(),
    volume: numberOrString,
    entryPrice: numberOrString,
    currentPrice: numberOrString,
    stopLoss: numberOrString.nullish(),
    takeProfit: numberOrString.nullish(),
    profitLoss: numberOrString,
    openedAt: z.string().nullish(),
  })
  .passthrough();

export const rithmicPositionsResponseSchema = z.object({
  positions: z.array(rithmicPositionSchema),
});

export type RithmicPositionRaw = z.infer<typeof rithmicPositionSchema>;
