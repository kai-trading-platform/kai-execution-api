import type {
  BrokerCapabilities,
  BrokerCapability,
  BrokerProviderKey,
  PlaceOrderRequest,
  PlaceOrderResult,
  ClosePositionRequest,
  ClosePositionResult,
  FlattenAllPositionsRequest,
  FlattenAllPositionsResult,
  CancelAllOrdersRequest,
  CancelAllOrdersResult,
  ReversePositionRequest,
  ReversePositionResult,
  TradingAccountContext,
  TradingOrder,
  TradingPosition,
  UpdatePositionStopsRequest,
  UpdatePositionStopsResult,
} from './types';

export interface BrokerAdapter {
  readonly provider: BrokerProviderKey;
  readonly capabilities: BrokerCapabilities;

  supports(capability: BrokerCapability): boolean;

  listPositions(account: TradingAccountContext): Promise<TradingPosition[]>;

  /**
   * List WORKING (pending) orders — limit/stop orders not yet filled. Optional:
   * only providers that advertise the `listOrders` capability implement it
   * (MT5). QueryService checks `supports('list_orders')` first and returns an
   * empty list for providers that omit it.
   */
  listOrders?(account: TradingAccountContext): Promise<TradingOrder[]>;

  placeOrder(
    account: TradingAccountContext,
    request: PlaceOrderRequest,
    idempotencyKey?: string,
  ): Promise<PlaceOrderResult>;

  closePosition(
    account: TradingAccountContext,
    request: ClosePositionRequest,
  ): Promise<ClosePositionResult>;

  updatePositionStops(
    account: TradingAccountContext,
    request: UpdatePositionStopsRequest,
  ): Promise<UpdatePositionStopsResult>;

  /**
   * Optional futures-terminal bulk/flip actions. Only providers that advertise
   * the matching capability implement them (Rithmic); the execution service
   * checks `supports()` before dispatching, so MT5 omits these entirely.
   */
  flattenAllPositions?(
    account: TradingAccountContext,
    request: FlattenAllPositionsRequest,
    idempotencyKey?: string,
  ): Promise<FlattenAllPositionsResult>;

  cancelAllOrders?(
    account: TradingAccountContext,
    request: CancelAllOrdersRequest,
    idempotencyKey?: string,
  ): Promise<CancelAllOrdersResult>;

  reversePosition?(
    account: TradingAccountContext,
    request: ReversePositionRequest,
    idempotencyKey?: string,
  ): Promise<ReversePositionResult>;
}
