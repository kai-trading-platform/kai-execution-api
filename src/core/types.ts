export type BrokerProviderKey = 'mt5' | 'rithmic' | 'sim';

export type TradingOrderSide = 'buy' | 'sell';

export type TradingOrderType = 'market';

export type BrokerCapability =
  | 'list_accounts'
  | 'list_positions'
  | 'list_orders'
  | 'place_market_order'
  | 'close_position'
  | 'update_position_stops'
  | 'flatten_all'
  | 'cancel_all_orders'
  | 'reverse_position';

export interface BrokerCapabilities {
  listAccounts: boolean;
  listPositions: boolean;
  placeMarketOrder: boolean;
  closePosition: boolean;
  updateStops: boolean;
  /**
   * Whether the provider can list WORKING (pending) orders — limit/stop orders
   * placed but not yet filled. Optional (treated as false when omitted): MT5
   * supports it via the bridge; sim/rithmic don't yet. QueryService returns an
   * empty list (not a 503) when a provider omits it, since a "pending orders"
   * panel showing empty is the correct read for a market-only account.
   */
  listOrders?: boolean;
  /**
   * Futures-terminal bulk/flip actions (Rithmic only). Optional: providers that
   * don't implement them omit the flag (treated as false). Gated by the same
   * RITHMIC_TERMINAL_ORDERS_ENABLED kill-switch as the other Rithmic writes.
   */
  flattenAll?: boolean;
  cancelAllOrders?: boolean;
  reversePosition?: boolean;
}

export interface ConnectedTradingAccount {
  id: string;
  provider: BrokerProviderKey;
  providerAccountId: string;
  name: string;
  server: string | null;
  status: string;
  accountType: string;
  isDefault: boolean;
  balance: number | null;
  equity: number | null;
  /**
   * Per-account contracts cap sourced from `system_configs` key
   * `autotrading:maxContracts:<accountId>` (matched by account UUID, falling
   * back to the broker login/ref). Undefined when unset/<=0 — "no cap".
   * Mirrors the same cap the backend auto-trading processor and the manual
   * Rithmic execution path enforce server-side; this is display-only so the
   * terminal's futures cap badge can show it ahead of an order being placed.
   */
  maxContracts?: number;
  /** Balance al inicio del día de trading actual (boundary 18:00 ET). */
  sodBalance?: number | null;
  /** PnL realizado del día de trading actual (suma de cierres desde SOD). */
  netDailyPnl?: number | null;
  capabilities: BrokerCapabilities;
}

export interface TradingPosition {
  id: string;
  tradingAccountId: string;
  provider: BrokerProviderKey;
  symbol: string;
  side: TradingOrderSide;
  volume: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  profitLoss: number;
  openedAt: string | null;
  comment?: string | null;
  magic?: number | null;
}

/** Trade cerrado (historial de la cuenta), de synced_trades status='filled'. */
export interface TradingHistoryItem {
  id: string;
  tradingAccountId: string;
  provider: BrokerProviderKey;
  symbol: string;
  side: TradingOrderSide;
  volume: number;
  entryPrice: number;
  exitPrice: number | null;
  /** SL/TP con los que se abrió el trade (para dibujar la caja LONG/SHORT en el
   * chart). Guardados en synced_trades; null si el trade cerró sin registrarlos. */
  stopLoss: number | null;
  takeProfit: number | null;
  profitLoss: number | null;
  openedAt: string | null;
  closedAt: string | null;
}

/** Clase de una orden pendiente (working order): a qué precio dispara. */
export type TradingOrderKind = 'limit' | 'stop' | 'stop_limit' | 'other';

/**
 * Orden PENDIENTE (working order) — colocada pero aún NO ejecutada. Distinta de
 * TradingPosition (ya en mercado) y de TradingHistoryItem (ya cerrada). Kai opera
 * a mercado, así que normalmente sólo aparecen aquí las que un usuario dejó
 * pendientes a mano.
 */
export interface TradingOrder {
  id: string;
  tradingAccountId: string;
  provider: BrokerProviderKey;
  symbol: string;
  side: TradingOrderSide;
  type: TradingOrderKind;
  volume: number;
  /** Precio de disparo/límite de la orden. */
  price: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  placedAt: string | null;
  comment?: string | null;
  magic?: number | null;
}

export interface PlaceOrderRequest {
  tradingAccountId: string;
  symbol: string;
  side: TradingOrderSide;
  type?: TradingOrderType;
  volume: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  /**
   * Reference/entry price (absolute). MT5 ignores it (the bridge takes absolute
   * SL/TP directly). Rithmic needs it to convert the absolute SL/TP into the
   * tick-distance bracket the futures bridge expects — without it the futures
   * SL/TP would be misread. Optional; the frontend does not send it yet (see the
   * Phase 5 pre-enable review list).
   */
  entry?: number | null;
  comment?: string | null;
  magic?: number | null;
  dryRun?: boolean;
  confirmationText?: string | null;
}

export interface PlaceOrderResult {
  ok: boolean;
  provider: BrokerProviderKey;
  tradingAccountId: string;
  orderId?: string | null;
  raw?: unknown;
  message?: string;
  dryRun?: boolean;
}

export interface ClosePositionRequest {
  tradingAccountId: string;
  ticket: string;
  /**
   * Optional partial-close volume (contracts). Only the SIM adapter honors it
   * today: absent/<=0 closes the whole position, a value below the open qty
   * closes that slice and leaves the remainder open. MT5/Rithmic ignore it
   * (their bridges close the full ticket).
   */
  volume?: number | null;
  dryRun?: boolean;
  confirmationText?: string | null;
}

export interface ClosePositionResult {
  success: boolean;
  provider: BrokerProviderKey;
  tradingAccountId: string;
  ticket: string;
  message?: string;
  dryRun?: boolean;
  raw?: unknown;
}

export interface UpdatePositionStopsRequest {
  tradingAccountId: string;
  ticket: string;
  stopLoss: number;
  takeProfit: number;
  dryRun?: boolean;
  confirmationText?: string | null;
}

export interface UpdatePositionStopsResult {
  success: boolean;
  provider: BrokerProviderKey;
  tradingAccountId: string;
  ticket: string;
  stopLoss: number;
  takeProfit: number;
  message?: string;
  dryRun?: boolean;
  raw?: unknown;
}

export interface FlattenAllPositionsRequest {
  tradingAccountId: string;
  dryRun?: boolean;
  confirmationText?: string | null;
}

export interface FlattenAllPositionsResult {
  success: boolean;
  provider: BrokerProviderKey;
  tradingAccountId: string;
  message?: string;
  dryRun?: boolean;
  raw?: unknown;
}

export interface CancelAllOrdersRequest {
  tradingAccountId: string;
  dryRun?: boolean;
  confirmationText?: string | null;
}

export interface CancelAllOrdersResult {
  success: boolean;
  provider: BrokerProviderKey;
  tradingAccountId: string;
  message?: string;
  dryRun?: boolean;
  raw?: unknown;
}

export interface ReversePositionRequest {
  tradingAccountId: string;
  ticket: string;
  /**
   * Absolute SL/TP/entry for the NEW (reversed) position. The Rithmic per-trade
   * risk gate is fail-closed and REQUIRES an SL (+ entry) to bound the flip's
   * loss; a reverse without SL is refused server-side by design.
   */
  stopLoss?: number | null;
  takeProfit?: number | null;
  entry?: number | null;
  dryRun?: boolean;
  confirmationText?: string | null;
}

export interface ReversePositionResult {
  success: boolean;
  provider: BrokerProviderKey;
  tradingAccountId: string;
  ticket: string;
  message?: string;
  dryRun?: boolean;
  raw?: unknown;
}

export interface ModifyProtectionRequest {
  tradingAccountId: string;
  positionId: string;
  stopLoss: number;
  takeProfit: number;
}

export interface TradingAccountContext {
  id: string;
  userId: string;
  provider: BrokerProviderKey;
  providerAccountId: string;
  name: string;
  server: string | null;
  status: string;
  accountType: string;
  isDefault: boolean;
  balance: number | null;
  equity: number | null;
  bridgeInstance: number | null;
  customComment: string | null;
  customMagicNumber: number | null;
  maxContracts?: number;
}
