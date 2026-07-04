export type BrokerProviderKey = 'mt5' | 'rithmic';

export type TradingOrderSide = 'buy' | 'sell';

export type TradingOrderType = 'market';

export type BrokerCapability =
  | 'list_accounts'
  | 'list_positions'
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
