/**
 * Scenario tests (STEP 11) — the three behaviours the demo claims, proved
 * off-chain before anything touches a chain.
 *
 * A note on how these are written. Draw order is random by design: the agent
 * that gets pulled next, and the round the market stops on, are both decided
 * by the stopping rule. So "the liar lost money" cannot be a single-seed
 * assertion — on some seeds the liar lands in the flat-fee tail and is never
 * scored at all, which is a correct outcome and not the one under test.
 *
 * These tests therefore sweep many seeds and assert properties over the runs
 * where the claim is actually exercised. That is the same discipline the
 * telescoping and budget invariants use, and it is stronger than pinning one
 * lucky seed: a property that holds across 60 independent markets is a
 * property of the mechanism, not of the fixture.
 */
import { describe, expect, it } from 'vitest';
import {
  closingPrice,
  computeSettlement,
  DEFAULT_PARAMS,
  honestPool,
  kl,
  makeHonestAgent,
  makeLazyAgent,
  makeLiarAgent,
  maxTotalPayout,
  simulateMarket,
  UNIFORM_PRIOR,
  type MarketParams,
  type Payout,
  type SimAgent,
} from '../src/index.js';

/** ROADMAP STEP 11 asks for exactly this on the lazy scenario. */
const EXACT = 1e-10;

const TRUTH = 0.75;
const SEEDS = Array.from({ length: 60 }, (_, i) => 1000 + i * 7);

/** Scored payouts only. Flat-fee agents are paid R for standing at the end. */
function scored(payouts: readonly Payout[]): Payout[] {
  return payouts.filter((p) => p.kind === 'scored');
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function idsOf(payouts: readonly Payout[], prefix: string): Payout[] {
  return payouts.filter((p) => p.agentId.startsWith(prefix));
}

describe('simulateMarket — harness', () => {
  it('runs a market to settlement and is deterministic under a seed', () => {
    const agents = honestPool(20, TRUTH, 1);
    const a = simulateMarket(DEFAULT_PARAMS, agents, UNIFORM_PRIOR, 42);
    const b = simulateMarket(DEFAULT_PARAMS, honestPool(20, TRUTH, 1), UNIFORM_PRIOR, 42);

    expect(a.state.status).toBe('closed');
    expect(a.state.reports.length).toBeGreaterThan(0);
    expect(a.state.reports.map((r) => r.agentId)).toEqual(b.state.reports.map((r) => r.agentId));
    expect(a.settlement.payouts).toEqual(b.settlement.payouts);
  });

  it('different seeds produce different markets', () => {
    const a = simulateMarket(DEFAULT_PARAMS, honestPool(20, TRUTH, 1), UNIFORM_PRIOR, 1);
    const b = simulateMarket(DEFAULT_PARAMS, honestPool(20, TRUTH, 1), UNIFORM_PRIOR, 2);
    const order = (r: typeof a) => r.state.reports.map((x) => x.agentId).join(',');
    expect(order(a)).not.toBe(order(b));
  });

  it('the reference is always the terminal agent', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const { state } = simulateMarket(DEFAULT_PARAMS, honestPool(20, TRUTH, 1), UNIFORM_PRIOR, seed);
      const last = state.reports[state.reports.length - 1]!;
      expect(state.referenceReport?.agentId).toBe(last.agentId);
      expect(state.referenceReport?.belief).toEqual(last.belief);
    }
  });

  it('no agent ever reports twice', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const { state } = simulateMarket(DEFAULT_PARAMS, honestPool(20, TRUTH, 1), UNIFORM_PRIOR, seed);
      const ids = state.reports.map((r) => r.agentId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('rejects a pool smaller than minPoolSize instead of settling a cancelled market', () => {
    expect(() => simulateMarket(DEFAULT_PARAMS, honestPool(5, TRUTH, 1), UNIFORM_PRIOR, 1)).toThrow(
      /minPoolSize/,
    );
  });

  it('rejects duplicate agent ids', () => {
    const dup: SimAgent[] = [
      ...honestPool(19, TRUTH, 1),
      makeHonestAgent({ id: 'honest-01', truth: TRUTH, seed: 999 }),
    ];
    expect(() => simulateMarket(DEFAULT_PARAMS, dup, UNIFORM_PRIOR, 1)).toThrow(/unique/);
  });

  it('market length matches the geometric stopping rule on average', () => {
    // alpha = 1/8 -> E[length] = 8, capped by the 20-agent pool.
    const lengths = SEEDS.map(
      (seed) =>
        simulateMarket(DEFAULT_PARAMS, honestPool(20, TRUTH, 1), UNIFORM_PRIOR, seed).state.reports
          .length,
    );
    expect(mean(lengths)).toBeGreaterThan(5);
    expect(mean(lengths)).toBeLessThan(11);
  });
});

describe('SCENARIO 1 — 20 honest agents', () => {
  it('the price converges toward the truth', () => {
    const finals = SEEDS.map((seed) => {
      const { state } = simulateMarket(DEFAULT_PARAMS, honestPool(20, TRUTH, seed), UNIFORM_PRIOR, seed);
      return closingPrice(state)[1];
    });

    // The prior sits at 0.5 and the truth at 0.75. The market has to end up
    // meaningfully closer to the truth than to where it started.
    const avgFinal = mean(finals);
    expect(Math.abs(avgFinal - TRUTH)).toBeLessThan(Math.abs(0.5 - TRUTH));
    expect(Math.abs(avgFinal - TRUTH)).toBeLessThan(0.1);
  });

  it('every closing price sits above the prior — the evidence points one way', () => {
    for (const seed of SEEDS) {
      const { state } = simulateMarket(DEFAULT_PARAMS, honestPool(20, TRUTH, seed), UNIFORM_PRIOR, seed);
      expect(closingPrice(state)[1]).toBeGreaterThan(0.5);
    }
  });

  it('honest agents are paid on the whole', () => {
    const totals = SEEDS.map((seed) => {
      const { settlement } = simulateMarket(
        DEFAULT_PARAMS,
        honestPool(20, TRUTH, seed),
        UNIFORM_PRIOR,
        seed,
      );
      return scored(settlement.payouts).reduce((a, p) => a + p.amount, 0);
    });
    expect(mean(totals)).toBeGreaterThan(0);
  });

  it('total scored payout never exceeds the budget bound b·H(r, prior)', () => {
    // The invariant `computeSettlement` already asserts, restated at the
    // scenario level: this is what caps the asker's cost.
    for (const seed of SEEDS) {
      const { state, settlement } = simulateMarket(
        DEFAULT_PARAMS,
        honestPool(20, TRUTH, seed),
        UNIFORM_PRIOR,
        seed,
      );
      const total = scored(settlement.payouts).reduce((a, p) => a + p.amount, 0);
      const bound = maxTotalPayout(DEFAULT_PARAMS.b, state.prior, closingPrice(state));
      expect(total).toBeLessThanOrEqual(bound + EXACT);
    }
  });

  it('the asker never pays more than the deposit', () => {
    for (const seed of SEEDS) {
      const { settlement } = simulateMarket(
        DEFAULT_PARAMS,
        honestPool(20, TRUTH, seed),
        UNIFORM_PRIOR,
        seed,
      );
      expect(settlement.askerRefund).toBeGreaterThanOrEqual(-EXACT);
    }
  });
});

describe('SCENARIO 2 — 19 honest and 1 liar', () => {
  function run(seed: number) {
    const agents: SimAgent[] = [
      ...honestPool(19, TRUTH, seed),
      makeLiarAgent({ id: 'liar-01', truth: TRUTH, seed: seed + 500 }),
    ];
    return simulateMarket(DEFAULT_PARAMS, agents, UNIFORM_PRIOR, seed);
  }

  it('the liar loses money every single time it is scored', () => {
    let scoredRuns = 0;
    for (const seed of SEEDS) {
      const { settlement } = run(seed);
      const liar = settlement.payouts.find((p) => p.agentId === 'liar-01');
      if (!liar || liar.kind !== 'scored') continue;
      scoredRuns++;
      expect(liar.amount).toBeLessThan(0);
    }
    // Guard against a vacuous pass: the claim has to actually be exercised.
    expect(scoredRuns).toBeGreaterThan(10);
  });

  it('the liar does worse than the honest agents around it', () => {
    const liarPayouts: number[] = [];
    const honestPayouts: number[] = [];
    for (const seed of SEEDS) {
      const s = scored(run(seed).settlement.payouts);
      for (const p of s) {
        if (p.agentId === 'liar-01') liarPayouts.push(p.amount);
        else honestPayouts.push(p.amount);
      }
    }
    expect(mean(liarPayouts)).toBeLessThan(0);
    expect(mean(honestPayouts)).toBeGreaterThan(0);
    expect(mean(honestPayouts)).toBeGreaterThan(mean(liarPayouts));
  });

  it('the loss never exceeds the bond — the move limit holds', () => {
    for (const seed of SEEDS) {
      for (const p of run(seed).settlement.payouts) {
        expect(p.amount).toBeGreaterThanOrEqual(-DEFAULT_PARAMS.bondAmount - EXACT);
      }
    }
  });

  it('the money the liar loses goes back to the asker, not to other agents', () => {
    // PLAN section 5, rule 1: an agent's profit comes from the asker's fee,
    // never from a rival's bond. Otherwise this stops being a prediction
    // market and becomes a skill contest between agents.
    //
    // Stated so that redistributing the slash would break it: the asker's
    // refund has to carry the slashed money in full, and agents receive only
    // their own bonds plus their own scores.
    let slashRuns = 0;
    for (const seed of SEEDS) {
      const { settlement } = run(seed);
      const positiveTotal = settlement.payouts.reduce((a, p) => a + Math.max(0, p.amount), 0);

      expect(settlement.askerRefund - settlement.scoreSlash - settlement.timeoutSlash).toBeCloseTo(
        settlement.deposit - positiveTotal,
        9,
      );
      expect(settlement.totalToAgents).toBeCloseTo(
        settlement.bondsReturned + settlement.scoreTotal,
        9,
      );

      if (settlement.scoreSlash > 0) slashRuns++;
    }
    // The rule has to actually be exercised, not just be true vacuously.
    expect(slashRuns).toBeGreaterThan(10);
  });
});

describe('why the honest agent uses a constant self-weight', () => {
  // A regression guard for a real bug found while writing STEP 11, kept as a
  // test so nobody "improves" the agent back into it.
  //
  // The first version weighted the agent's own signal at 1/(t+1) — the naive
  // Bayesian move, which assumes every earlier report was honest. Late in a
  // market that weight goes to nearly zero, agents stop being able to move the
  // price, and one liar's push stands until the close. The market then settles
  // near the lie, and the liar collects for having moved the price toward the
  // reference. Exactly backwards.
  it('inert agents let a liar profit; agents that can still move the price do not', () => {
    function liarPayouts(selfWeight: number): number[] {
      const out: number[] = [];
      for (const seed of SEEDS) {
        const agents: SimAgent[] = [
          ...Array.from({ length: 19 }, (_, i) =>
            makeHonestAgent({
              id: `honest-${String(i + 1).padStart(2, '0')}`,
              truth: TRUTH,
              seed: seed + i,
              selfWeight,
            }),
          ),
          makeLiarAgent({ id: 'liar-01', truth: TRUTH, seed: seed + 500 }),
        ];
        const { settlement } = simulateMarket(DEFAULT_PARAMS, agents, UNIFORM_PRIOR, seed);
        const liar = settlement.payouts.find((p) => p.agentId === 'liar-01');
        if (liar?.kind === 'scored') out.push(liar.amount);
      }
      return out;
    }

    const inert = liarPayouts(0.05);
    const responsive = liarPayouts(0.4);

    // With near-inert agents the liar turns a profit on a real share of runs.
    expect(inert.filter((x) => x > 0).length).toBeGreaterThan(0);
    // With agents that can still correct the record, it never does.
    expect(responsive.filter((x) => x > 0).length).toBe(0);
    expect(mean(responsive)).toBeLessThan(mean(inert));
  });
});

describe('SCENARIO 3 — everyone is lazy (paper Theorem 7)', () => {
  // The critical one. Copying pays exactly zero, so there is no way to draw a
  // fee out of this mechanism without doing work.

  /** Non-degenerate form: the first agent moves the price, the rest copy it. */
  function lazyPool(): SimAgent[] {
    return Array.from({ length: 20 }, (_, i) =>
      makeLazyAgent({
        id: `lazy-${String(i + 1).padStart(2, '0')}`,
        whenFirst: [0.3, 0.7],
      }),
    );
  }

  it('every copier is paid EXACTLY zero', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const { settlement } = simulateMarket(DEFAULT_PARAMS, lazyPool(), UNIFORM_PRIOR, seed);
      for (const p of scored(settlement.payouts)) {
        if (p.position === 1) continue;
        checked++;
        expect(Math.abs(p.amount)).toBeLessThan(EXACT);
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('the first agent is paid exactly KL(r || prior)', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const { state, settlement } = simulateMarket(DEFAULT_PARAMS, lazyPool(), UNIFORM_PRIOR, seed);
      const first = settlement.payouts.find((p) => p.position === 1);
      if (!first || first.kind !== 'scored') continue;
      checked++;
      const expected = DEFAULT_PARAMS.b * kl(closingPrice(state), state.prior);
      expect(Math.abs(first.amount - expected)).toBeLessThan(EXACT);
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('the whole market never converges anywhere — the price never moves again', () => {
    const { state } = simulateMarket(DEFAULT_PARAMS, lazyPool(), UNIFORM_PRIOR, 7);
    const prices = state.reports.map((r) => r.belief[1]);
    for (const p of prices) expect(p).toBeCloseTo(0.7, 12);
  });

  it('with nothing to copy at all, the entire market pays zero', () => {
    // Default lazy agent reports the prior, so even the first agent moves
    // nothing: KL(prior || prior) = 0.
    const pool = Array.from({ length: 20 }, (_, i) =>
      makeLazyAgent({ id: `lazy-${String(i + 1).padStart(2, '0')}` }),
    );
    for (const seed of SEEDS.slice(0, 20)) {
      const { settlement } = simulateMarket(DEFAULT_PARAMS, pool, UNIFORM_PRIOR, seed);
      for (const p of scored(settlement.payouts)) {
        expect(Math.abs(p.amount)).toBeLessThan(EXACT);
      }
    }
  });

  it('the asker gets the whole deposit back minus the flat fees', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const { settlement } = simulateMarket(DEFAULT_PARAMS, lazyPool(), UNIFORM_PRIOR, seed);
      const flats = settlement.payouts.filter((p) => p.kind === 'flat-fee');
      const firstAgentPay = settlement.payouts.find((p) => p.position === 1 && p.kind === 'scored');
      const expected =
        settlement.deposit - flats.length * DEFAULT_PARAMS.R - (firstAgentPay?.amount ?? 0);
      expect(settlement.askerRefund).toBeCloseTo(expected, 9);
    }
  });
});

describe('SCENARIO 4 — 10 honest, 5 liars, 5 lazy', () => {
  function run(seed: number) {
    const agents: SimAgent[] = [
      ...honestPool(10, TRUTH, seed),
      ...Array.from({ length: 5 }, (_, i) =>
        makeLiarAgent({ id: `liar-0${i + 1}`, truth: TRUTH, seed: seed + 500 + i }),
      ),
      ...Array.from({ length: 5 }, (_, i) => makeLazyAgent({ id: `lazy-0${i + 1}` })),
    ];
    return simulateMarket(DEFAULT_PARAMS, agents, UNIFORM_PRIOR, seed);
  }

  it('honest agents earn the most, liars the least, lazy exactly nothing', () => {
    const honest: number[] = [];
    const liar: number[] = [];
    const lazy: number[] = [];

    for (const seed of SEEDS) {
      const s = scored(run(seed).settlement.payouts);
      for (const p of idsOf(s, 'honest-')) honest.push(p.amount);
      for (const p of idsOf(s, 'liar-')) liar.push(p.amount);
      // A lazy agent drawn first has nothing to copy and reports the prior,
      // which is still a zero-length move.
      for (const p of idsOf(s, 'lazy-')) lazy.push(p.amount);
    }

    expect(honest.length).toBeGreaterThan(20);
    expect(liar.length).toBeGreaterThan(10);
    expect(lazy.length).toBeGreaterThan(10);

    expect(mean(honest)).toBeGreaterThan(mean(lazy));
    expect(mean(lazy)).toBeGreaterThan(mean(liar));
    expect(mean(honest)).toBeGreaterThan(0);
    expect(mean(liar)).toBeLessThan(0);
  });

  it('every lazy agent is paid exactly zero regardless of who spoke before it', () => {
    for (const seed of SEEDS) {
      for (const p of idsOf(scored(run(seed).settlement.payouts), 'lazy-')) {
        expect(Math.abs(p.amount)).toBeLessThan(EXACT);
      }
    }
  });

  it('when a liar happens to BE the reference agent, the lie wins — this is the k=3 gap', () => {
    // Measured, not assumed. Split the same runs by who set the closing price.
    //
    // The mechanism scores everyone against the terminal agent's report. If
    // that agent is a liar, the market resolves to the lie and the honest
    // agents who fought it are the ones who pay. Theorem 1 is what bounds this,
    // and at k=3 the bound is 0.278 — loose enough that this is visible rather
    // than theoretical.
    //
    // It does not overturn scenario 4's headline (honest still wins on
    // average), but it is the empirical face of the k gap PLAN section 14
    // documents, and it belongs in the README next to the number.
    const byRef = { honest: [] as number[], liar: [] as number[] };
    let liarReferenceRuns = 0;

    for (const seed of SEEDS) {
      const { state, settlement } = run(seed);
      const refId = state.referenceReport?.agentId ?? '';
      if (!refId.startsWith('liar-')) continue;
      liarReferenceRuns++;
      for (const p of scored(settlement.payouts)) {
        if (p.agentId.startsWith('honest-')) byRef.honest.push(p.amount);
        if (p.agentId.startsWith('liar-')) byRef.liar.push(p.amount);
      }
    }

    expect(liarReferenceRuns).toBeGreaterThan(5);
    expect(mean(byRef.honest)).toBeLessThan(0);
    expect(mean(byRef.liar)).toBeGreaterThan(0);
  });

  it('the accounting still closes with all three behaviours mixed', () => {
    for (const seed of SEEDS) {
      const { state, settlement } = run(seed);
      const inflow = settlement.deposit + settlement.totalBonds;
      const outflow = settlement.totalToAgents + settlement.askerRefund;
      expect(inflow).toBeCloseTo(outflow, 9);
      // computeSettlement asserts the invariants itself; recomputing proves
      // the harness did not hand it a state it would have rejected.
      expect(() => computeSettlement(state)).not.toThrow();
    }
  });
});

describe('scenarios respect the shipped configuration', () => {
  it('all four scenarios run on DEFAULT_PARAMS, not on a friendlier setting', () => {
    const p: MarketParams = DEFAULT_PARAMS;
    expect(p.k).toBe(3);
    expect(p.T).toBe(5);
    expect(p.alpha).toBeCloseTo(1 / 8, 12);
    expect(p.minPoolSize).toBe(20);
  });

  it('exactly min(k, n) agents collect the flat fee in every run', () => {
    for (const seed of SEEDS) {
      const { state, settlement } = simulateMarket(
        DEFAULT_PARAMS,
        honestPool(20, TRUTH, seed),
        UNIFORM_PRIOR,
        seed,
      );
      const flats = settlement.payouts.filter((p) => p.kind === 'flat-fee').length;
      expect(flats).toBe(Math.min(DEFAULT_PARAMS.k, state.reports.length));
    }
  });
});
