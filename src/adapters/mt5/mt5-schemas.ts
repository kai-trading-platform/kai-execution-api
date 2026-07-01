import { z } from 'zod';

/**
 * Zod schemas for the (untyped) MT5 bridge responses.
 *
 * The bridge returns whatever the MT5 Expert Advisor produces, so these
 * schemas exist to fail loudly when the shape drifts — instead of silently
 * coercing missing fields to `NaN` / `"undefined"`. They are intentionally
 * tolerant: numeric fields accept number-or-string (MT5 mixes both), only the
 * position identity (`ticketId`, `symbol`) is required, and unknown extra
 * fields pass through untouched.
 */

const numberOrString = z.union([z.number(), z.string()]);
const optionalNumeric = numberOrString.nullish();

// The MT5 bridge (FastAPI + MetaTrader5 lib) emits snake_case-ish keys
// (`ticket`, `price_open`, `sl`, `tp`, `profit`, `time` as unix SECONDS). Earlier
// code expected camelCase (`ticketId`, `entryPrice`, ...) which silently produced
// "undefined"/NaN. We now accept both spellings; the adapter coalesces them.
export const mt5PositionSchema = z
  .object({
    ticket: numberOrString.optional(),
    ticketId: numberOrString.optional(),
    symbol: z.string(),
    type: z.string().optional().default(''),
    volume: optionalNumeric,
    price_open: optionalNumeric,
    openPrice: optionalNumeric,
    entryPrice: optionalNumeric,
    currentPrice: optionalNumeric,
    sl: optionalNumeric,
    stopLoss: optionalNumeric,
    tp: optionalNumeric,
    takeProfit: optionalNumeric,
    profit: optionalNumeric,
    profitLoss: optionalNumeric,
    time: optionalNumeric,
    openTime: z.union([z.string(), z.number()]).nullish(),
    comment: z.string().nullish(),
    magic: z.number().nullish(),
    contractSize: optionalNumeric,
  })
  .passthrough()
  .refine((p) => p.ticket != null || p.ticketId != null, {
    message: 'position is missing a ticket identifier',
  });

export const mt5PositionsSchema = z.array(mt5PositionSchema);

export type Mt5PositionRaw = z.infer<typeof mt5PositionSchema>;

/** Result payload of a market-order placement (PLACE_ORDER on the bridge). */
export const mt5OrderResultSchema = z
  .object({
    ticket: optionalNumeric,
    deal: optionalNumeric,
    order_id: optionalNumeric,
    orderId: optionalNumeric,
    position: optionalNumeric,
    price: optionalNumeric,
    sl: optionalNumeric,
    tp: optionalNumeric,
  })
  .passthrough();
