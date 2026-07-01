/**
 * Standard Symbol Info - Normalized across all trading venues
 * This interface abstracts venue-specific differences into a common format
 */
export interface StandardSymbolInfo {
  symbol: string;
  venue: Venue;
  digits: number;
  tickSize: number;        // Minimum price increment (point)
  tickValue: number;       // Monetary value per tick (in account currency)
  contractSize: number;   // Units per lot
  lotSize: number;         // Volume unit (usually 1 lot = contractSize units)
  minVolume: number;       // Minimum lot volume
  maxVolume: number;       // Maximum lot volume
  volumeStep: number;      // Volume granularity
}

export type Venue =
  | 'MT5'
  | 'Tradovate'
  | 'AMP'
  | 'Optimus'
  | 'NinjaTrader'
  | 'IBKR'
  | 'WebullFutures'
  | 'BinanceFutures'
  | string; // fallback for unknown venues

export interface PipCalculation {
  pipSize: number;        // Price increment represented as 1 pip
  pipValue: number;        // Monetary value per pip per lot
  tickValue: number;       // Monetary value per tick per lot
  isPipSimulation: boolean; // True if pip is simulated (MT5 style: 1 pip = 10 ticks)
}

/**
 * Venue-specific pip calculation rules
 * Each venue has different conventions for how pip/tick is defined
 */
export interface VenuePipRules {
  /**
   * Calculate pip size from tick size
   * MT5: 1 pip = 10 ticks for most instruments
   * Futures: pipSize equals tickSize (1 pip = 1 tick)
   */
  pipSizeFromTick(tickSize: number, digits: number): number;

  /**
   * Calculate monetary value per pip from tick value
   * MT5: pipValue = tickValue * pipMultiplier (usually 10)
   * Futures: pipValue = tickValue (already in monetary terms)
   */
  pipValueFromTick(tickValue: number, pipSize: number, tickSize: number): number;

  /**
   * Whether this venue simulates "pips" as 10 ticks (MT5 style)
   * or uses direct tick/point as pip (futures style)
   */
  simulatesPips: boolean;
}

const MT5_PIP_RULES: VenuePipRules = {
  pipSizeFromTick(tickSize: number, digits: number): number {
    // MT5 convention: 1 pip = 10 ticks for all instruments
    // This applies to Forex (5-digit), metals, and most CFDs
    return tickSize * 10;
  },

  pipValueFromTick(tickValue: number, pipSize: number, tickSize: number): number {
    // MT5: tickValue is per tick, pipValue = tickValue * (pipSize / tickSize)
    // Since pipSize = tickSize * 10, this equals tickValue * 10
    if (tickSize <= 0) return 0;
    return (pipSize / tickSize) * tickValue;
  },

  simulatesPips: true,
};

const FUTURES_PIP_RULES: VenuePipRules = {
  pipSizeFromTick(tickSize: number, _digits: number): number {
    // Futures convention: 1 pip = 1 tick = 1 point
    // tickValue is already in monetary terms per point
    return tickSize;
  },

  pipValueFromTick(tickValue: number, _pipSize: number, _tickSize: number): number {
    // Futures: tickValue already represents the monetary value per tick/point
    // No conversion needed
    return tickValue;
  },

  simulatesPips: false,
};

const VENUE_RULES: Record<string, VenuePipRules> = {
  MT5: MT5_PIP_RULES,
  Tradovate: FUTURES_PIP_RULES,
  AMP: FUTURES_PIP_RULES,
  Optimus: FUTURES_PIP_RULES,
  NinjaTrader: FUTURES_PIP_RULES,
  IBKR: FUTURES_PIP_RULES,
  WebullFutures: FUTURES_PIP_RULES,
  BinanceFutures: FUTURES_PIP_RULES,
};

const DEFAULT_RULES = FUTURES_PIP_RULES;

/**
 * Get pip rules for a specific venue
 */
export function getVenuePipRules(venue: Venue): VenuePipRules {
  return VENUE_RULES[venue] ?? DEFAULT_RULES;
}

/**
 * Calculate pip-related values for a symbol
 * Uses venue-specific rules to compute pipSize and pipValue
 */
export function calculatePips(input: {
  tickSize: number;
  tickValue: number;
  digits: number;
  venue: Venue;
}): PipCalculation {
  const { tickSize, tickValue, digits, venue } = input;

  if (tickSize <= 0 || tickValue <= 0) {
    return {
      pipSize: 0,
      pipValue: 0,
      tickValue: 0,
      isPipSimulation: false,
    };
  }

  const rules = getVenuePipRules(venue);
  const pipSize = rules.pipSizeFromTick(tickSize, digits);
  const pipValue = rules.pipValueFromTick(tickValue, pipSize, tickSize);

  return {
    pipSize,
    pipValue,
    tickValue, // Original tick value for reference
    isPipSimulation: rules.simulatesPips,
  };
}

/**
 * Calculate position size based on risk parameters
 * Uses venue-specific pip calculations
 */
export function calculatePositionSizeWithVenue(
  balance: number,
  riskPercent: number,
  entryPrice: number,
  slPrice: number,
  symbolInfo: StandardSymbolInfo,
): {
  lots: number;
  riskAmount: number;
  slPips: number;
  pipValue: number;
  riskActual: number;
  isValid: boolean;
  error?: string;
} {
  const { tickSize, tickValue, digits, venue, minVolume, maxVolume, volumeStep } = symbolInfo;

  // Validation
  if (balance <= 0) {
    return { lots: 0, riskAmount: 0, slPips: 0, pipValue: 0, riskActual: 0, isValid: false, error: 'Balance must be positive' };
  }
  if (riskPercent <= 0 || riskPercent > 100) {
    return { lots: 0, riskAmount: 0, slPips: 0, pipValue: 0, riskActual: 0, isValid: false, error: 'Risk percent must be between 0 and 100' };
  }
  if (entryPrice <= 0 || slPrice <= 0) {
    return { lots: 0, riskAmount: 0, slPips: 0, pipValue: 0, riskActual: 0, isValid: false, error: 'Entry and SL prices must be positive' };
  }
  if (slPrice === entryPrice) {
    return { lots: 0, riskAmount: 0, slPips: 0, pipValue: 0, riskActual: 0, isValid: false, error: 'SL cannot equal entry price' };
  }
  if (tickValue <= 0 || tickSize <= 0) {
    return { lots: 0, riskAmount: 0, slPips: 0, pipValue: 0, riskActual: 0, isValid: false, error: 'tickValue or tickSize missing or zero' };
  }
  if (minVolume <= 0 || volumeStep <= 0) {
    return { lots: 0, riskAmount: 0, slPips: 0, pipValue: 0, riskActual: 0, isValid: false, error: 'volumeMin or volumeStep is invalid' };
  }
  if (maxVolume < minVolume) {
    return { lots: 0, riskAmount: 0, slPips: 0, pipValue: 0, riskActual: 0, isValid: false, error: 'volumeMax is less than volumeMin' };
  }

  // Calculate pip values using venue-specific rules
  const pipCalc = calculatePips({ tickSize, tickValue, digits, venue });

  if (pipCalc.pipSize <= 0 || pipCalc.pipValue <= 0) {
    return { lots: 0, riskAmount: 0, slPips: 0, pipValue: 0, riskActual: 0, isValid: false, error: 'pipValue calculated to zero' };
  }

  // Calculate SL distance in pips
  const slDistance = Math.abs(entryPrice - slPrice);
  const slPips = slDistance / pipCalc.pipSize;

  if (slPips < 1) {
    return { lots: 0, riskAmount: 0, slPips: 0, pipValue: 0, riskActual: 0, isValid: false, error: 'SL is too close to entry (< 1 pip)' };
  }

  // Calculate risk amount and lot size
  const riskAmount = balance * (riskPercent / 100);
  const rawLots = riskAmount / (slPips * pipCalc.pipValue);

  if (!Number.isFinite(rawLots) || rawLots <= 0) {
    return { lots: 0, riskAmount, slPips, pipValue: pipCalc.pipValue, riskActual: 0, isValid: false, error: 'Calculated lot size is invalid' };
  }

  // Apply volume constraints
  let lots = Math.floor(rawLots / volumeStep) * volumeStep;
  lots = Math.max(minVolume, lots);
  lots = Math.min(maxVolume, lots);

  const riskActual = lots * slPips * pipCalc.pipValue;

  return {
    lots: Number(lots.toFixed(6)),
    riskAmount: Number(riskAmount.toFixed(2)),
    slPips: Number(slPips.toFixed(2)),
    pipValue: Number(pipCalc.pipValue.toFixed(4)),
    riskActual: Number(riskActual.toFixed(2)),
    isValid: true,
  };
}
