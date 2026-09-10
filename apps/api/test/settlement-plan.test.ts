/**
 * Transfer plan tests.
 *
 * This is the module where floating-point units become whole tinybar, so it is
 * where money can be created or destroyed. The property that matters is a
 * single integer identity:
 *
 *     deposit + Σ bonds  ==  Σ transfers
 *
 * Exact, not approximate. It is checked here over hand-built cases and over a
 * hundred random markets driven through the real mechanism.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAMS,
  honestPool,
  makeLiarAgent,
  requiredDeposit,
  simulateMarket,
  UNIFORM_PRIOR,
  type MarketParams,
  type Settlement,
} from '@ethonline/core';
import { assertPlanBalances, buildTransferPlan, chunkPlan } from '../src/settlement-plan.js';
import { depositTinybar, unitsToTinybar } from '../src/pricing.js';

const HBAR_PER_UNIT = 1;

function accountsFor(ids: readonly string[]): Map<string, string> {
  return new Map(ids.map((id, i) => [id, `0.0.${200000 + i}`]));
}

/** Runs a real market and turns its settlement into a plan. */
function planFromSimulation(seed: number, params: MarketParams = DEFAULT_PARAMS, withLiar = false) {
  const agents = withLiar
    ? [...honestPool(19, 0.75, seed), makeLiarAgent({ id: 'liar-01', truth: 0.75, seed: seed + 900 })]
    : honestPool(20, 0.75, seed);
  const { state, settlement } = simulateMarket(params, agents, UNIFORM_PRIOR, seed);

  const bondAccounts = accountsFor(agents.map((a) => a.id));
  const drawn = new Set(state.drawnAgents);
  return {
    state,
    settlement,
    plan: buildTransferPlan({
      marketId: state.id,
      settlement,
      params,
      hbarPerUnit: HBAR_PER_UNIT,
      bondAccounts,
      timedOutAgents: state.timedOutAgents,
      notDrawnAgents: [...bondAccounts.keys()].filter((id) => !drawn.has(id)),
      askerAccountId: '0.0.999',
      depositTinybar: depositTinybar(params, UNIFORM_PRIOR, HBAR_PER_UNIT),
    }),
  };
}

describe('buildTransferPlan — the accounting identity', () => {
  it('balances exactly, over 100 random markets', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { plan } = planFromSimulation(seed);
      // Integer equality. A tolerance here would hide a real leak.
      expect(plan.totalOutTinybar).toBe(plan.totalInTinybar);
      expect(() => assertPlanBalances(plan)).not.toThrow();
    }
  });

  it('balances with a liar in the pool, where scores go negative', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { plan } = planFromSimulation(seed, DEFAULT_PARAMS, true);
      expect(plan.totalOutTinybar).toBe(plan.totalInTinybar);
    }
  });

  it('never pays any agent a negative amount', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { plan } = planFromSimulation(seed, DEFAULT_PARAMS, true);
      for (const line of plan.lines) expect(line.amountTinybar).toBeGreaterThan(0n);
    }
  });

  it('takes in exactly the deposit plus every bond', () => {
    const { plan } = planFromSimulation(7);
    const expected =
      depositTinybar(DEFAULT_PARAMS, UNIFORM_PRIOR, HBAR_PER_UNIT) +
      unitsToTinybar(DEFAULT_PARAMS.bondAmount, HBAR_PER_UNIT) * 20n;
    expect(plan.totalInTinybar).toBe(expected);
  });
});

describe('buildTransferPlan — who gets what', () => {
  const bondTb = unitsToTinybar(DEFAULT_PARAMS.bondAmount, HBAR_PER_UNIT);

  function minimalPlan(settlement: Settlement, opts: Partial<Parameters<typeof buildTransferPlan>[0]> = {}) {
    const bondAccounts = accountsFor(['a1', 'a2', 'a3']);
    return buildTransferPlan({
      marketId: 'm1',
      settlement,
      params: DEFAULT_PARAMS,
      hbarPerUnit: HBAR_PER_UNIT,
      bondAccounts,
      timedOutAgents: [],
      notDrawnAgents: [],
      askerAccountId: '0.0.999',
      depositTinybar: depositTinybar(DEFAULT_PARAMS, UNIFORM_PRIOR, HBAR_PER_UNIT),
      ...opts,
    });
  }

  const emptySettlement: Settlement = {
    marketId: 'm1',
    payouts: [],
    deposit: requiredDeposit(DEFAULT_PARAMS, UNIFORM_PRIOR),
    totalBonds: 3,
    scoreTotal: 0,
    bondsReturned: 3,
    timeoutSlash: 0,
    scoreSlash: 0,
    totalToAgents: 3,
    askerRefund: requiredDeposit(DEFAULT_PARAMS, UNIFORM_PRIOR),
  };

  it('returns the bond in full to an agent that was never drawn', () => {
    const plan = minimalPlan(emptySettlement, { notDrawnAgents: ['a1', 'a2', 'a3'] });
    for (const id of ['a1', 'a2', 'a3']) {
      const line = plan.lines.find((l) => l.beneficiary === id)!;
      expect(line.amountTinybar).toBe(bondTb);
      expect(line.kind).toBe('not-drawn');
    }
  });

  it('pays a timed-out agent nothing, and the slash goes to the asker', () => {
    // PLAN section 5, rule 4: a slashed bond never reaches another agent.
    const plan = minimalPlan(emptySettlement, { timedOutAgents: ['a2'] });
    expect(plan.lines.find((l) => l.beneficiary === 'a2')).toBeUndefined();
    expect(plan.slashedTinybar).toBe(bondTb);

    const asker = plan.lines.find((l) => l.beneficiary === 'asker')!;
    const deposit = depositTinybar(DEFAULT_PARAMS, UNIFORM_PRIOR, HBAR_PER_UNIT);
    expect(asker.amountTinybar).toBe(deposit + bondTb);
  });

  it('nets a negative score against the bond rather than billing the agent', () => {
    const settlement: Settlement = {
      ...emptySettlement,
      payouts: [
        { agentId: 'a1', position: 1, kind: 'scored', amount: -0.25 },
        { agentId: 'a2', position: 2, kind: 'scored', amount: 0.1 },
        { agentId: 'a3', position: 3, kind: 'flat-fee', amount: DEFAULT_PARAMS.R },
      ],
      scoreTotal: -0.25 + 0.1 + DEFAULT_PARAMS.R,
      scoreSlash: 0.25,
    };
    const plan = minimalPlan(settlement);
    // Explicit constants, not `unitsToTinybar`: that helper rounds UP because
    // it prices things, and payouts round DOWN. 1.1 HBAR is 110000000.00000001
    // in float, so the two helpers differ by one tinybar here — which is
    // exactly the asymmetry the rounding rule is built on.
    expect(plan.lines.find((l) => l.beneficiary === 'a1')!.amountTinybar).toBe(75_000_000n);
    expect(plan.lines.find((l) => l.beneficiary === 'a2')!.amountTinybar).toBe(110_000_000n);
    expect(plan.totalOutTinybar).toBe(plan.totalInTinybar);
  });

  it('refuses a plan that cannot be funded rather than paying part of it', () => {
    const impossible: Settlement = {
      ...emptySettlement,
      payouts: [{ agentId: 'a1', position: 1, kind: 'scored', amount: 1000 }],
    };
    expect(() => minimalPlan(impossible)).toThrow(/cannot be funded|budget bound/);
  });

  it('drops zero-value lines instead of sending empty transfers', () => {
    const plan = minimalPlan(emptySettlement, { timedOutAgents: ['a1', 'a2', 'a3'] });
    expect(plan.lines.every((l) => l.amountTinybar > 0n)).toBe(true);
    expect(plan.lines).toHaveLength(1); // just the asker
  });
});

describe('rounding', () => {
  it('rounds agents DOWN and gives the asker the remainder', () => {
    // Rounding up, or to nearest, can make the payouts exceed what the
    // treasury holds — it holds the deposit plus the bonds and nothing else.
    const settlement: Settlement = {
      marketId: 'm1',
      payouts: [
        { agentId: 'a1', position: 1, kind: 'scored', amount: 1 / 3 },
        { agentId: 'a2', position: 2, kind: 'scored', amount: 1 / 7 },
        { agentId: 'a3', position: 3, kind: 'scored', amount: 1 / 11 },
      ],
      deposit: requiredDeposit(DEFAULT_PARAMS, UNIFORM_PRIOR),
      totalBonds: 3,
      scoreTotal: 1 / 3 + 1 / 7 + 1 / 11,
      bondsReturned: 3,
      timeoutSlash: 0,
      scoreSlash: 0,
      totalToAgents: 3 + 1 / 3 + 1 / 7 + 1 / 11,
      askerRefund: 0,
    };
    const plan = buildTransferPlan({
      marketId: 'm1',
      settlement,
      params: DEFAULT_PARAMS,
      hbarPerUnit: HBAR_PER_UNIT,
      bondAccounts: accountsFor(['a1', 'a2', 'a3']),
      timedOutAgents: [],
      notDrawnAgents: [],
      askerAccountId: '0.0.999',
      depositTinybar: depositTinybar(DEFAULT_PARAMS, UNIFORM_PRIOR, HBAR_PER_UNIT),
    });

    expect(plan.lines.find((l) => l.beneficiary === 'a1')!.amountTinybar).toBe(133_333_333n);
    expect(plan.totalOutTinybar).toBe(plan.totalInTinybar);
  });
});

describe('chunkPlan', () => {
  it('splits into transactions the network will accept', () => {
    const { plan } = planFromSimulation(3);
    const chunks = chunkPlan(plan, 9);
    expect(chunks.flat()).toHaveLength(plan.lines.length);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(9);
  });

  it('loses nothing in the split', () => {
    const { plan } = planFromSimulation(5);
    const total = chunkPlan(plan, 4)
      .flat()
      .reduce((s, l) => s + l.amountTinybar, 0n);
    expect(total).toBe(plan.totalOutTinybar);
  });

  it('rejects a nonsense chunk size', () => {
    const { plan } = planFromSimulation(1);
    expect(() => chunkPlan(plan, 0)).toThrow(/maxCreditsPerTransaction/);
  });
});
