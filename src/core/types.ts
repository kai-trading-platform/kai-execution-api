export type BrokerProviderKey = 'mt5';

export type TradingOrderSide = 'buy' | 'sell';

export type TradingOrderType = 'market';

export type BrokerCapability =
  | 'list_accounts'
  | 'list_positions'
  | 'place_market_order'
  | 'close_position'
  | 'update_position_stops';

export interface BrokerCapabilities {
  listAccounts: boolean;
  listPositions: boolean;
  placeMarketOrder: boolean;
  closePosition: boolean;
  updateStops: boolean;
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
}
