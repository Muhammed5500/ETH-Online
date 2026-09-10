/**
 * k calculator — Theorem 1 and Theorem 4 of the paper.
 *
 * Source: Srinivasan, Karger, Chen — "Self-Resolving Prediction Markets for
 * Unverifiable Outcomes" (arXiv 2306.04305).
 *
 * WHY THIS FILE EXISTS. `k` is the number of independent signals the reference
 * agent holds that agent `t` cannot reach — the number of reports it takes for
 * a lie to dissolve. The paper gives lower bounds for it; we run the demo with
 * k=3, which is below what those bounds ask for. Hiding that would be the one
 * real mistake, so instead we ship the calculator: the README says "the bound
 * asks for k≈6, we run k=3 for a 20-agent pool, here is the tool that produces
 * both numbers". A documented gap is a much stronger position than a hardcoded
 * constant with no justification.
 *
 * All three formulas share one quantity, the spread of the likelihood ratio
 * implied by the minimum signal probability `eta`:
 *
 *   spread(eta) = (1-eta)/eta - eta/(1-eta)
 *
 * It measures how extreme a single signal is allowed to be. The larger it is,
 * the more a liar can gain in one step, and the more reports are needed to
 * wash that gain out.
 */
import { flatFeeProbability, poolExhaustionProbability } from './config.js';

/**
 * Re-exported from `config.ts`, where they are also used by parameter
 * validation. The roadmap lists them as part of the k calculator's surface;
 * they live in one place and are exposed from both.
 */
export { flatFeeProbability, poolExhaustionProbability };

/** `delta` — Bhattacharyya coefficient upper bound. How well a signal separates the outcome. */
function assertDelta(delta: number): void {
  if (!Number.isFinite(delta) || !(delta > 0 && delta < 1)) {
    throw new Error(
      `delta must be in (0, 1), got: ${delta}. It is the Bhattacharyya ` +
        `coefficient bound; delta=0 means a signal reveals the outcome outright, ` +
        `delta=1 means it carries no information and no finite k suffices.`,
    );
  }
}

/**
 * `eta` — minimum signal probability. Bounded by 0.5 because the paper's
 * expression takes `(1-eta)/eta >= 1`; at eta=0.5 the likelihood ratio is
 * pinned to 1 and no signal can move a belief at all.
 */
function assertEta(eta: number): void {
  if (!Number.isFinite(eta) || !(eta > 0 && eta <= 0.5)) {
    throw new Error(
      `eta must be in (0, 0.5], got: ${eta}. It is the minimum signal ` +
        `probability, so (1-eta)/eta >= 1 must hold.`,
    );
  }
}

/**
 * Spread of the likelihood ratio: `(1-eta)/eta - eta/(1-eta)`.
 *
 * This is the width of the interval a single signal can move a report across,
 * and it is what `(1-delta)^k` has to shrink. At eta=0.5 it is exactly 0: no
 * signal advantage exists, so no k is needed.
 */
export function signalSpread(eta: number): number {
  assertEta(eta);
  const ratio = (1 - eta) / eta;
  return ratio - 1 / ratio;
}

/**
 * Theorem 1, deviation bound — how much a strategic agent can gain by lying:
 *
 *   `|Delta| <= (1/4) · ((1-eta)/eta - eta/(1-eta)) · (1-delta)^k`
 *
 * The `(1-delta)^k` factor is the whole mechanism: every additional independent
 * signal between the agent and the reference agent multiplies the exploitable
 * gap by `(1-delta)`. Note the paper flags `delta` as the most effective knob —
 * signal quality buys far more than signal count.
 *
 * At k=0 this is just `spread/4`: nothing stands between the agent and the
 * reference, so the full signal advantage is exploitable.
 */
export function deviationBound(delta: number, eta: number, k: number): number {
  assertDelta(delta);
  if (!Number.isFinite(k) || k < 0) {
    throw new Error(`k must be a finite number >= 0, got: ${k}`);
  }
  return 0.25 * signalSpread(eta) * (1 - delta) ** k;
}

/**
 * Theorem 1, Equation 3 — the `k` that keeps the deviation bound under `epsilonPrime`:
 *
 *   `k >= ( 1 / -log(1-delta) ) · log( (1/(4·epsilonPrime)) · ((1-eta)/eta - eta/(1-eta)) )`
 *
 * This is the exact inverse of {@link deviationBound}: feeding the result back
 * in returns `epsilonPrime`. That round trip is asserted in the tests, and it
 * is the reason the two functions are allowed to be separate code.
 *
 * Returns a real number; take `Math.ceil` for an integer agent count.
 *
 * Clamped at 0 because k counts agents. A negative result means the target
 * `epsilonPrime` is already looser than the unattenuated signal advantage, so
 * no buffer agents are needed at all.
 */
export function kMinApprox(delta: number, eta: number, epsilonPrime: number): number {
  assertDelta(delta);
  if (!Number.isFinite(epsilonPrime) || epsilonPrime <= 0) {
    throw new Error(
      `epsilonPrime must be > 0, got: ${epsilonPrime}. It is the targeted upper ` +
        `bound on the deviation; 0 would demand infinite k.`,
    );
  }
  const spread = signalSpread(eta);
  // eta = 0.5 leaves no signal advantage to attenuate.
  if (spread <= 0) return 0;
  const k = Math.log(spread / (4 * epsilonPrime)) / -Math.log(1 - delta);
  return Math.max(0, k);
}

/**
 * Theorem 4, Equation 7 — strict truthfulness, which needs the signal-space
 * granularity `tau`:
 *
 *   `k > ( 1 / -log(1-delta) ) · log( |log((1-eta)/eta)| · ((1-eta)/eta - eta/(1-eta))
 *                                     / ( 8·(tau·eta·(1-eta))^2 ) )`
 *
 * Approximate truthfulness (Theorem 1) only bounds how much a lie pays. Strict
 * truthfulness says honesty is the unique best response, and that costs more
 * agents — the finer the signal space (`tau` small), the closer two distinct
 * beliefs can sit, and the more evidence it takes to tell them apart.
 *
 * Returns a real number; take `Math.ceil` for an integer agent count. Clamped
 * at 0 for the same reason as {@link kMinApprox}.
 */
export function kMinStrict(delta: number, eta: number, tau: number): number {
  assertDelta(delta);
  if (!Number.isFinite(tau) || tau <= 0) {
    throw new Error(`tau must be > 0, got: ${tau}. It is the signal-space granularity.`);
  }
  const spread = signalSpread(eta);
  if (spread <= 0) return 0;

  const ratio = (1 - eta) / eta;
  const numerator = Math.abs(Math.log(ratio)) * spread;
  const denominator = 8 * (tau * eta * (1 - eta)) ** 2;
  const k = Math.log(numerator / denominator) / -Math.log(1 - delta);
  return Math.max(0, k);
}
