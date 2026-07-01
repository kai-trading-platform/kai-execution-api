import {
  calculatePositionSizeWithVenue,
  type StandardSymbolInfo,
  type Venue,
} from './symbolMetadata';

export interface PositionSizingInput {
  balance: number;
  riskPercent: number;
  entryPrice: number;
  slPrice: number;
  symbol: {
    contractSize: number;
    tickSize: number;
    tickValue: number;
    volumeMin: number;
    volumeMax: number;
    volumeStep: number;
    digits: number;
    venue?: Venue;  // Optional, defaults to MT5
  };
}

export interface PositionSizingResult {
  lots: number;
  riskAmount: number;
  slPips: number;
  pipValue: number;
  riskActual: number;
  isValid: boolean;
  error?: string;
}

/**
 * @deprecated Use calculatePositionSizeWithVenue from './symbolMetadata' instead
 */
export function calculatePositionSize(input: PositionSizingInput): PositionSizingResult {
  const { balance, riskPercent, entryPrice, slPrice, symbol } = input;
  const {
    contractSize,
    tickSize,
    tickValue,
    volumeMin,
    volumeMax,
    volumeStep,
    digits,
    venue = 'MT5',
  } = symbol;

  const symbolInfo: StandardSymbolInfo = {
    symbol: '',
    venue,
    digits,
    tickSize,
    tickValue,
    contractSize,
    lotSize: contractSize,
    minVolume: volumeMin,
    maxVolume: volumeMax,
    volumeStep,
  };

  const result = calculatePositionSizeWithVenue(
    balance,
    riskPercent,
    entryPrice,
    slPrice,
    symbolInfo,
  );

  // Map back to legacy interface
  return {
    lots: result.lots,
    riskAmount: result.riskAmount,
    slPips: result.slPips,
    pipValue: result.pipValue,
    riskActual: result.riskActual,
    isValid: result.isValid,
    error: result.error,
  };
}

export { calculatePositionSizeWithVenue } from './symbolMetadata';
export type { StandardSymbolInfo, Venue, PipCalculation } from './symbolMetadata';
