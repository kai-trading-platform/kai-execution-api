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

/**
 * Response envelope for the internal WRITE endpoints. `ok` is the bridge outcome
 * (a clean broker rejection is `ok:false` with a `message`). Place additionally
 * echoes the server-side clamped volume so the caller can surface the Apex cap.
 */
export const rithmicPlaceOrderResponseSchema = z
  .object({
    ok: z.boolean(),
    orderId: z.union([z.string(), z.number()]).nullish(),
    requestedVolume: z.number().optional(),
    volume: z.number().optional(),
    capApplied: z.boolean().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export const rithmicWriteResponseSchema = z
  .object({
    ok: z.boolean(),
    message: z.string().optional(),
  })
  .passthrough();
