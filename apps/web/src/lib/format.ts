/**
 * Formatting, and the deposit figure the ask page shows live.
 *
 * THE DEPOSIT IS NOT RE-IMPLEMENTED HERE. It comes from `requiredDeposit` in
 * `@ethonline/core` — the same function the API prices the x402 challenge with
 * and the same one settlement checks itself against. `core` is pure TypeScript
 * with no Node imports, so the browser can run it unchanged.
 *
 * That matters more than it looks. The number on screen is what the asker is
 * about to pay, and it is only meaningful because it equals the bound that
 * makes their cost provably finite (paper §6.2): `b · max_i(-log q⁰_i) + k·R`,
 * the worst case over where the reference agent lands. A second copy of that
 * formula in the frontend would be a copy that can drift, and the first sign
 * of drift would be a market quoted at one price and charged at another.
 */
import { requiredDeposit, UNIFORM_PRIOR, type Belief, type MarketParams } from '@ethonline/core';

export const TINYBAR_PER_HBAR = 100_000_000n;

export function tinybarToHbar(tinybar: string | bigint): number {
  return Number(BigInt(tinybar)) / Number(TINYBAR_PER_HBAR);
}

export function formatHbar(tinybar: string | bigint, places = 4): string {
  return `${tinybarToHbar(tinybar).toFixed(places)} ℏ`;
}

/**
 * Mechanism units to tinybar, rounding UP.
 *
 * Up, not nearest: rounding down would quote a price a fraction below the
 * deposit bound, and the bound is the only thing standing between the asker
 * and an unbounded payout. Mirrors `unitsToTinybar` in the API.
 */
export function unitsToTinybar(units: number, hbarPerUnit = 1): bigint {
  return BigInt(Math.ceil(units * hbarPerUnit * Number(TINYBAR_PER_HBAR)));
}

export interface DepositBreakdown {
  readonly units: number;
  readonly tinybar: bigint;
  /**
   * The whole CE-MSR side of the bound.
   *
   * `b · max_i(-log q⁰_i)`, which is `b·log2` at a uniform prior and larger
   * anywhere else — opening a market confident costs more, not less.
   */
  readonly scoringUnits: number;
  /** `k · R` — the flat fees for the last k agents. */
  readonly flatFeeUnits: number;
}

/** What opening a market costs, split into the two terms it is made of. */
export function depositBreakdown(
  params: MarketParams,
  prior: Belief = UNIFORM_PRIOR,
  hbarPerUnit = 1,
): DepositBreakdown {
  const units = requiredDeposit(params, prior);
  const flatFeeUnits = params.k * params.R;
  return {
    units,
    tinybar: unitsToTinybar(units, hbarPerUnit),
    scoringUnits: units - flatFeeUnits,
    flatFeeUnits,
  };
}

export function percent(p: number, places = 1): string {
  return `${(p * 100).toFixed(places)}%`;
}

/** How long until a timestamp, or how long since. Short enough for a badge. */
export function relativeTime(target: number, now = Date.now()): string {
  const delta = target - now;
  const abs = Math.abs(delta);
  const unit =
    abs < 60_000
      ? `${Math.round(abs / 1000)}s`
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)}m`
        : abs < 86_400_000
          ? `${Math.round(abs / 3_600_000)}h`
          : `${Math.round(abs / 86_400_000)}d`;
  return delta >= 0 ? `in ${unit}` : `${unit} ago`;
}

/**
 * Expected number of reports before the market closes.
 *
 * The stopping rule is geometric with parameter alpha, so the mean is `1/alpha`
 * — which is `T + k` when alpha follows the paper's `1/(T+k)`.
 */
export function expectedLength(params: MarketParams): number {
  return 1 / params.alpha;
}

/**
 * The chance the pool runs out before the dice stop the market: `(1-alpha)^(N-1)`.
 *
 * Worth showing on screen rather than hiding in a README. It is the one place
 * a finite pool breaks the mechanism's assumption that the stopping time is
 * unpredictable: at the last position, whoever is there knows they are the
 * reference.
 */
export function poolExhaustionRisk(params: MarketParams, poolSize: number): number {
  if (poolSize < 1) return 1;
  return (1 - params.alpha) ** (poolSize - 1);
}

/** A short, stable colour class per data slice, so a badge means something. */
export const SLICE_COLORS: Readonly<Record<string, string>> = {
  liquidity: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  holders: 'bg-violet-500/15 text-violet-300 ring-violet-500/30',
  activity: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  bridge: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  comparative: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
};

export function sliceColor(id: string): string {
  return SLICE_COLORS[id] ?? 'bg-slate-500/15 text-slate-300 ring-slate-500/30';
}
