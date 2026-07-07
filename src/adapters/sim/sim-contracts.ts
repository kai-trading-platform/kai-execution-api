/**
 * Minimal futures-contract table for SIM (emulated funding) accounts.
 *
 * CONSCIOUS DUPLICATE: the canonical source of truth is
 * `kai-backend/src/sim/sim-contracts.ts` — the backend creates/settles SIM
 * trades with those specs, and this file must stay in sync with it. It is
 * copied here (instead of shared) because the two repos deploy independently
 * and don't share a package; keep any change mirrored in both.
 */

export interface SimContract {
  /** Contract root as traded in the terminal (e.g. 'MNQ'). */
  root: string;
  /** Yahoo Finance chart symbol used for pricing (e.g. 'MNQ=F'). */
  yahooSymbol: string;
  /** Dollar value of a 1.0 price move for one contract. */
  pointValue: number;
  /** Minimum price increment. */
  tickSize: number;
  /** Round-trip commission per contract, in dollars. */
  commissionRT: number;
}

export const SIM_CONTRACTS: SimContract[] = [
  { root: 'MNQ', yahooSymbol: 'MNQ=F', pointValue: 2, tickSize: 0.25, commissionRT: 1.34 },
  { root: 'NQ', yahooSymbol: 'NQ=F', pointValue: 20, tickSize: 0.25, commissionRT: 4.28 },
  { root: 'MES', yahooSymbol: 'MES=F', pointValue: 5, tickSize: 0.25, commissionRT: 1.34 },
  { root: 'ES', yahooSymbol: 'ES=F', pointValue: 50, tickSize: 0.25, commissionRT: 4.28 },
  { root: 'MYM', yahooSymbol: 'MYM=F', pointValue: 0.5, tickSize: 1, commissionRT: 1.34 },
  { root: 'YM', yahooSymbol: 'YM=F', pointValue: 5, tickSize: 1, commissionRT: 4.28 },
  { root: 'MGC', yahooSymbol: 'MGC=F', pointValue: 10, tickSize: 0.1, commissionRT: 1.5 },
  { root: 'GC', yahooSymbol: 'GC=F', pointValue: 100, tickSize: 0.1, commissionRT: 4.5 },
];

/**
 * Resolve a contract from a terminal symbol (e.g. 'MNQ', 'MNQU5', 'mnq=f') by
 * longest-prefix match on the root, case-insensitive. Longest first so 'MNQ'
 * wins over 'NQ' and 'MGC' over 'GC'. Returns null when no root matches.
 */
export function resolveSimContract(symbol: string): SimContract | null {
  const normalized = String(symbol ?? '').trim().toUpperCase();
  if (!normalized) return null;

  let best: SimContract | null = null;
  for (const contract of SIM_CONTRACTS) {
    if (
      normalized.startsWith(contract.root) &&
      (best === null || contract.root.length > best.root.length)
    ) {
      best = contract;
    }
  }
  return best;
}
