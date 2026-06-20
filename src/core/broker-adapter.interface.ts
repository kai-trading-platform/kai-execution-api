import type {
  BrokerCapabilities,
  BrokerCapability,
  BrokerProviderKey,
  PlaceOrderRequest,
  PlaceOrderResult,
  ClosePositionRequest,
  ClosePositionResult,
  TradingAccountContext,
  TradingPosition,
  UpdatePositionStopsRequest,
  UpdatePositionStopsResult,
} from './types';

export interface BrokerAdapter {
  readonly provider: BrokerProviderKey;
  readonly capabilities: BrokerCapabilities;

  supports(capability: BrokerCapability): boolean;

  listPositions(account: TradingAccountContext): Promise<TradingPosition[]>;

  placeOrder(
    account: TradingAccountContext,
    request: PlaceOrderRequest,
  ): Promise<PlaceOrderResult>;

  closePosition(
    account: TradingAccountContext,
    request: ClosePositionRequest,
  ): Promise<ClosePositionResult>;

  updatePositionStops(
    account: TradingAccountContext,
    request: UpdatePositionStopsRequest,
  ): Promise<UpdatePositionStopsResult>;
}
