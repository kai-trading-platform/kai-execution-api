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

function pipsForSymbol(entryPrice: number, slPrice: number, tickSize: number, digits: number): number {
  const slDistance = Math.abs(entryPrice - slPrice);
  if (slDistance <= 0) return 0;

  const isForex = digits === 5;
  const pipSize = isForex ? tickSize * 10 : tickSize;

  if (pipSize <= 0) return 0;
  return slDistance / pipSize;
}

function pipValueForSymbol(tickSize: number, tickValue: number, digits: number): number {
  const isForex = digits === 5;
  const pipSize = isForex ? tickSize * 10 : tickSize;
  if (tickSize <= 0) return 0;
  return (pipSize / tickSize) * tickValue;
}

function roundDownToStep(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.floor(value / step) * step;
}

export function calculatePositionSize(input: PositionSizingInput): PositionSizingResult {
  const { balance, riskPercent, entryPrice, slPrice, symbol } = input;
  const { contractSize, tickSize, tickValue, volumeMin, volumeMax, volumeStep, digits } = symbol;

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
    return { lots: 0, riskAmount: 0, slPips: 0, pipValue: 0, riskActual: 0, isValid: false, error: 'Symbol tickValue or tickSize is missing or zero' };
  }

  if (volumeMin <= 0 || volumeStep <= 0) {
    return { lots: 0, riskAmount: 0, slPips: 0, pipValue: 0, riskActual: 0, isValid: false, error: 'Symbol volumeMin or volumeStep is invalid' };
  }

  if (volumeMax < volumeMin) {
    return { lots: 0, riskAmount: 0, slPips: 0, pipValue: 0, riskActual: 0, isValid: false, error: 'Symbol volumeMax is less than volumeMin' };
  }

  const riskAmount = balance * (riskPercent / 100);
  const slPips = pipsForSymbol(entryPrice, slPrice, tickSize, digits);

  if (slPips < 1) {
    return { lots: 0, riskAmount, slPips: 0, pipValue: 0, riskActual: 0, isValid: false, error: 'SL is too close to entry price (< 1 pip)' };
  }

  const pipValue = pipValueForSymbol(tickSize, tickValue, digits);

  if (pipValue <= 0) {
    return { lots: 0, riskAmount, slPips, pipValue: 0, riskActual: 0, isValid: false, error: 'pipValue calculated to zero' };
  }

  const rawLots = riskAmount / (slPips * pipValue);

  if (!Number.isFinite(rawLots) || rawLots <= 0) {
    return { lots: 0, riskAmount, slPips, pipValue, riskActual: 0, isValid: false, error: 'Calculated lot size is invalid' };
  }

  let lots = roundDownToStep(rawLots, volumeStep);
  lots = Math.max(volumeMin, lots);
  lots = Math.min(volumeMax, lots);

  const riskActual = lots * slPips * pipValue;

  return {
    lots: Number(lots.toFixed(6)),
    riskAmount: Number(riskAmount.toFixed(2)),
    slPips: Number(slPips.toFixed(2)),
    pipValue: Number(pipValue.toFixed(4)),
    riskActual: Number(riskActual.toFixed(2)),
    isValid: true,
  };
}
