/**
 * Turning mechanism units into HBAR.
 *
 * `core` works in abstract units: `b`, `R` and `bondAmount` are dimensionless
 * because the scoring rule does not care what money is. The chain does, so
 * exactly one place converts between the two — here — and both the x402 price
 * quoted to the client and the amount the handler validates come out of the
 * same function. If they were computed separately they would drift, and a
 * drift means a market that is underfunded relative to what it can pay out.
 *
 * PLAN section 5: the asker's deposit must satisfy `D >= b·log2 + k·R`, which
 * is what `requiredDeposit` in `core` computes. That bound is what makes the
 * asker's cost provably finite, so the price quoted here IS that bound.
 */
import { requiredDeposit, type Belief, type MarketParams } from '@ethonline/core';

/** Hedera's smallest unit. 1 HBAR = 100,000,000 tinybar. */
export const TINYBAR_PER_HBAR = 100_000_000n;

/**
 * How much HBAR one mechanism unit is worth.
 *
 * Configuration rather than a constant: the same market can run at any scale,
 * and the demo picks a scale where an agent's bond is affordable out of the
 * 10 HBAR each agent holds (STEP 12).
 */
export const DEFAULT_HBAR_PER_UNIT = 1;

/**
 * Converts a unit amount to tinybar, rounding UP.
 *
 * Rounding up on purpose. Rounding down would quote a price a fraction below
 * the deposit bound, and the bound is the only thing standing between the
 * asker and an unbounded payout.
 */
export function unitsToTinybar(units: number, hbarPerUnit = DEFAULT_HBAR_PER_UNIT): bigint {
  if (!Number.isFinite(units) || units < 0) {
    throw new Error(`units must be a finite number >= 0, got: ${units}`);
  }
  if (!Number.isFinite(hbarPerUnit) || hbarPerUnit <= 0) {
    throw new Error(`hbarPerUnit must be > 0, got: ${hbarPerUnit}`);
  }
  const tinybar = units * hbarPerUnit * Number(TINYBAR_PER_HBAR);
  return BigInt(Math.ceil(tinybar));
}

export function tinybarToHbar(tinybar: bigint): number {
  return Number(tinybar) / Number(TINYBAR_PER_HBAR);
}

/**
 * What opening a market costs: the deposit bound from PLAN section 5.
 *
 * `b · H_max(prior) + k · R`, in tinybar.
 */
export function depositTinybar(
  params: MarketParams,
  prior: Belief,
  hbarPerUnit = DEFAULT_HBAR_PER_UNIT,
): bigint {
  return unitsToTinybar(requiredDeposit(params, prior), hbarPerUnit);
}

/** What an agent locks up to join a market. */
export function bondTinybar(params: MarketParams, hbarPerUnit = DEFAULT_HBAR_PER_UNIT): bigint {
  return unitsToTinybar(params.bondAmount, hbarPerUnit);
}

/**
 * What the protocol charges the asker on top of the deposit.
 *
 * WHY A FEE CAN LIVE HERE AND NOWHERE ELSE. The mechanism's guarantee is about
 * the SCORING pot: total scored payout never exceeds `b·H(r, q⁰)`, which is
 * what makes an agent's expected payoff exactly `S_CEM` and honesty its best
 * strategy (paper Theorem 6). A fee taken out of agent payouts would change
 * that function and quietly sell the only claim this project has.
 *
 * This one is charged at the door instead. The asker pays `deposit + fee`; the
 * market is funded with the deposit and settles exactly as before, and the fee
 * never enters the pot the settlement pays out of. Nothing downstream can tell
 * the difference — which is the point.
 *
 * It is also quoted in the 402 before anybody pays, so it is a price rather
 * than a deduction.
 *
 * Zero by default: a deployment that wants to charge says so, and the demo
 * stays exactly as it was measured.
 */
export const DEFAULT_PROTOCOL_FEE_TINYBAR = 0n;

/**
 * What opening a market actually costs, fee included.
 *
 * The one number quoted to the asker. `depositTinybar` stays the mechanism's
 * number, because that is what settlement is allowed to spend.
 */
export function marketPriceTinybar(
  params: MarketParams,
  prior: Belief,
  hbarPerUnit = DEFAULT_HBAR_PER_UNIT,
  protocolFeeTinybar = DEFAULT_PROTOCOL_FEE_TINYBAR,
): bigint {
  if (protocolFeeTinybar < 0n) {
    throw new Error(`protocolFeeTinybar cannot be negative, got: ${protocolFeeTinybar}`);
  }
  return depositTinybar(params, prior, hbarPerUnit) + protocolFeeTinybar;
}

/**
 * The per-call price of the resolution service (STEP 22).
 *
 * Flat, unlike the other two: the caller is buying an answer, not funding a
 * market, so the price does not depend on mechanism parameters.
 */
export const DEFAULT_RESOLVE_PRICE_TINYBAR = 10_000_000n; // 0.1 HBAR

export function formatTinybar(tinybar: bigint): string {
  return `${tinybarToHbar(tinybar).toFixed(8)} HBAR (${tinybar} tinybar)`;
}
