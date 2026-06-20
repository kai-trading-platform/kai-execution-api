import { calculatePositionSize, PositionSizingInput } from './positionSizing';

const FOREX_EURUSD_5DIG = {
  balance: 10000,
  riskPercent: 1,
  entryPrice: 1.0850,
  slPrice: 1.0800,
  symbol: {
    contractSize: 100000,
    tickSize: 0.00001,
    tickValue: 0.1,
    volumeMin: 0.01,
    volumeMax: 500,
    volumeStep: 0.01,
    digits: 5,
  },
};

describe('calculatePositionSize', () => {
  it('returns invalid for zero balance', () => {
    const input: PositionSizingInput = {
      ...FOREX_EURUSD_5DIG,
      balance: 0,
    };
    const result = calculatePositionSize(input);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Balance');
  });

  it('returns invalid for negative balance', () => {
    const input: PositionSizingInput = {
      ...FOREX_EURUSD_5DIG,
      balance: -1000,
    };
    const result = calculatePositionSize(input);
    expect(result.isValid).toBe(false);
  });

  it('returns invalid for riskPercent out of range (0)', () => {
    const input: PositionSizingInput = {
      ...FOREX_EURUSD_5DIG,
      riskPercent: 0,
    };
    const result = calculatePositionSize(input);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Risk percent');
  });

  it('returns invalid for riskPercent > 100', () => {
    const input: PositionSizingInput = {
      ...FOREX_EURUSD_5DIG,
      riskPercent: 150,
    };
    const result = calculatePositionSize(input);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Risk percent');
  });

  it('returns invalid when entry and SL prices are equal', () => {
    const input: PositionSizingInput = {
      ...FOREX_EURUSD_5DIG,
      entryPrice: 1.0850,
      slPrice: 1.0850,
    };
    const result = calculatePositionSize(input);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('SL cannot equal entry');
  });

  it('returns invalid when tickValue is zero', () => {
    const input: PositionSizingInput = {
      ...FOREX_EURUSD_5DIG,
      symbol: { ...FOREX_EURUSD_5DIG.symbol, tickValue: 0 },
    };
    const result = calculatePositionSize(input);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('tickValue');
  });

  it('returns invalid when volumeMin is zero', () => {
    const input: PositionSizingInput = {
      ...FOREX_EURUSD_5DIG,
      symbol: { ...FOREX_EURUSD_5DIG.symbol, volumeMin: 0 },
    };
    const result = calculatePositionSize(input);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('volumeMin');
  });

  it('returns invalid when volumeMax < volumeMin', () => {
    const input: PositionSizingInput = {
      ...FOREX_EURUSD_5DIG,
      symbol: { ...FOREX_EURUSD_5DIG.symbol, volumeMin: 1.0, volumeMax: 0.5 },
    };
    const result = calculatePositionSize(input);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('volumeMax');
  });

  it('returns invalid when SL is too close to entry (0 pips)', () => {
    const input: PositionSizingInput = {
      ...FOREX_EURUSD_5DIG,
      entryPrice: 1.08501,
      slPrice: 1.08500,
    };
    const result = calculatePositionSize(input);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('too close');
  });

  it('calculates correct lots for EURUSD 5-digit forex BUY', () => {
    const result = calculatePositionSize(FOREX_EURUSD_5DIG);
    expect(result.isValid).toBe(true);
    expect(result.riskAmount).toBe(100); // 10000 * 1% = 100 USD
    // SL distance = 0.0050 (50 pips * 0.0001)
    // For 5-digit forex: pipSize = tickSize * 10 = 0.0001
    // pipValue = (pipSize/tickSize) * tickValue = (0.0001/0.00001) * 0.1 = 10 * 0.1 = 1 USD/pip
    // slPips = 0.0050 / 0.0001 = 50 pips
    // lots = 100 / (50 * 1) = 100 / 50 = 2.0 lots
    expect(result.slPips).toBe(50);
    expect(result.pipValue).toBe(1);
    expect(result.lots).toBe(2.0);
  });

  it('calculates correct lots for EURUSD SELL', () => {
    const input: PositionSizingInput = {
      ...FOREX_EURUSD_5DIG,
      entryPrice: 1.0800,
      slPrice: 1.0850, // SL above entry for sell
    };
    const result = calculatePositionSize(input);
    expect(result.isValid).toBe(true);
    expect(result.slPips).toBe(50);
    expect(result.lots).toBe(2.0);
  });

  it('clamps lots to volumeMax', () => {
    const input: PositionSizingInput = {
      ...FOREX_EURUSD_5DIG,
      balance: 10000000, // very large balance
      symbol: { ...FOREX_EURUSD_5DIG.symbol, volumeMax: 5.0 },
    };
    const result = calculatePositionSize(input);
    expect(result.isValid).toBe(true);
    expect(result.lots).toBeLessThanOrEqual(5.0);
    expect(result.lots).toBe(5.0); // should be clamped to max
  });

  it('clamps lots to volumeMin when balance is too small', () => {
    const input: PositionSizingInput = {
      ...FOREX_EURUSD_5DIG,
      balance: 10,
      riskPercent: 1,
    };
    const result = calculatePositionSize(input);
    expect(result.isValid).toBe(true);
    expect(result.lots).toBeLessThanOrEqual(input.symbol.volumeMin);
  });

  it('rounds lots down to volumeStep', () => {
    // 10000 * 2% / 100 = 200 USD risk
    // 50 pips * 1 USD/pip = 50 USD per lot -> 200/50 = 4.0 lots
    // With volumeStep 0.01, should round down to nearest step
    const input: PositionSizingInput = {
      ...FOREX_EURUSD_5DIG,
      riskPercent: 2,
    };
    const result = calculatePositionSize(input);
    expect(result.isValid).toBe(true);
    expect(result.lots).toBe(4.0);
  });

  it('uses volumeMin when calculated lots would be below minimum', () => {
    const input: PositionSizingInput = {
      ...FOREX_EURUSD_5DIG,
      balance: 100,
      riskPercent: 0.1, // 0.1% of 100 = 0.1 USD risk
    };
    const result = calculatePositionSize(input);
    expect(result.isValid).toBe(true);
    expect(result.lots).toBeGreaterThanOrEqual(input.symbol.volumeMin);
  });

  it('calculates riskActual correctly', () => {
    const result = calculatePositionSize(FOREX_EURUSD_5DIG);
    expect(result.isValid).toBe(true);
    // riskActual = lots * slPips * pipValue = 2.0 * 50 * 1 = 100 USD
    expect(result.riskActual).toBeCloseTo(100, 2);
  });

  it('returns valid for typical GBPUSD 5-digit setup', () => {
    const input: PositionSizingInput = {
      balance: 5000,
      riskPercent: 1,
      entryPrice: 1.2650,
      slPrice: 1.2600,
      symbol: {
        contractSize: 100000,
        tickSize: 0.00001,
        tickValue: 0.1,
        volumeMin: 0.01,
        volumeMax: 500,
        volumeStep: 0.01,
        digits: 5,
      },
    };
    const result = calculatePositionSize(input);
    expect(result.isValid).toBe(true);
    expect(result.riskAmount).toBe(50);
    expect(result.slPips).toBe(50);
    expect(result.pipValue).toBe(1);
    expect(result.lots).toBe(1.0);
    expect(result.riskActual).toBeCloseTo(50, 2);
  });

  it('handles non-forex symbols (indices, 2-digit) correctly', () => {
    const input: PositionSizingInput = {
      balance: 10000,
      riskPercent: 1,
      entryPrice: 4500,
      slPrice: 4450,
      symbol: {
        contractSize: 10,
        tickSize: 0.01,
        tickValue: 0.05,
        volumeMin: 0.1,
        volumeMax: 100,
        volumeStep: 0.1,
        digits: 2,
      },
    };
    const result = calculatePositionSize(input);
    expect(result.isValid).toBe(true);
    // For 2-digit: pipSize = tickSize = 0.01
    // pipValue = (0.01/0.01) * 0.05 = 1 * 0.05 = 0.05 USD/pip
    // slPips = 50 / 0.01 = 5000 (points/ticks, not forex pips)
    // lots = 100 / (5000 * 0.05) = 100 / 250 = 0.4 lots
    expect(result.slPips).toBe(5000);
    expect(result.pipValue).toBe(0.05);
    expect(result.lots).toBe(0.4);
  });
});
