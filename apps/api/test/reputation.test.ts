/**
 * Counting what an agent did, across markets.
 *
 * The cases worth having are the ones where a naive count is wrong: an agent
 * that bonded and was never drawn still joined, an agent drawn and timed out
 * did not report, and a market that has closed but not settled has no payouts
 * to attribute yet.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, Market, type Settlement } from '@ethonline/core';
import { HcsRandomSource } from '@ethonline/hedera';
import { agentRecords, recordFor } from '../src/reputation.js';
import { MarketStore, type StoredMarket } from '../src/store.js';
import type { SettlementProgress } from '../src/settlement-progress.js';

const HASH = new Uint8Array(48).fill(3);
const PARAMS = { ...DEFAULT_PARAMS, minPoolSize: 3, k: 1, T: 1, alpha: 0.5 };

/**
 * A market driven straight through `core`, so the state is real rather than
 * assembled: drawn agents, reports and timeouts all come from the state
 * machine that produces them in production.
 */
function marketWith(
  id: string,
  agents: readonly string[],
  plan: readonly { agentId: string; p?: number }[],
): StoredMarket {
  const rng = new HcsRandomSource(HASH);
  const market = Market.create({ id, question: 'q', params: PARAMS }, rng);
  const bonds = new Map<string, StoredMarket['bonds'] extends Map<string, infer V> ? V : never>();
  for (const agentId of agents) {
    market.addBondedAgent(agentId);
    bonds.set(agentId, {
      agentId,
      accountId: `0.0.${agentId.length}`,
      paidTinybar: 100_000_000n,
      bondedAt: 0,
    });
  }
  market.closeBonding();

  // `drawNextAgent` picks with the rng; the plan says what happens to whoever
  // comes out, so the test does not depend on the draw order.
  for (const step of plan) {
    const drawn = market.drawNextAgent();
    if (drawn === null) break;
    if (step.p === undefined) market.handleTimeout(drawn);
    else {
      market.submitReport(drawn, [1 - step.p, step.p]);
      if (market.status === 'running') market.rollStoppingDice();
    }
    if (market.status !== 'running') break;
  }

  return {
    id,
    question: 'q',
    topicId: '0.0.1',
    params: PARAMS,
    prior: [0.5, 0.5],
    market,
    rng,
    depositTinybar: 1n,
    bondTinybar: 100_000_000n,
    createdAt: 0,
    bondingClosesAt: 0,
    minBondingClosesAt: 0,
    bonds,
    annotations: new Map(),
  };
}

/** Only the part of a settlement that the record reads. */
function withSettlement(stored: StoredMarket, payouts: Settlement['payouts']): StoredMarket {
  stored.settlementProgress = {
    settlement: { payouts } as Settlement,
  } as SettlementProgress;
  return stored;
}

function storeOf(...markets: StoredMarket[]): MarketStore {
  const store = new MarketStore();
  for (const m of markets) store.add(m);
  return store;
}

describe('what a record counts', () => {
  it('counts a bond even when the agent was never drawn', () => {
    const state = marketWith('m1', ['a', 'b', 'c'], [{ agentId: 'x', p: 0.6 }]);
    const records = agentRecords(storeOf(state));

    // Every bond is a market joined, drawn or not: `bondedAgents` on the state
    // shrinks as agents are drawn, so counting that would forget the players.
    for (const id of ['a', 'b', 'c']) expect(recordFor(records, id).bonded).toBe(1);
    const reported = ['a', 'b', 'c'].filter((id) => recordFor(records, id).reported === 1);
    expect(reported).toHaveLength(1);
  });

  it('records a timeout as a timeout and not as a report', () => {
    const state = marketWith('m1', ['a', 'b', 'c'], [{ agentId: 'x' }, { agentId: 'y', p: 0.4 }]);
    const records = agentRecords(storeOf(state));

    const timedOut = [...records.values()].reduce((n, r) => n + r.timedOut, 0);
    const reported = [...records.values()].reduce((n, r) => n + r.reported, 0);
    expect(timedOut).toBe(1);
    expect(reported).toBe(1);
  });

  it('marks exactly one agent as the reference', () => {
    const state = marketWith('m1', ['a', 'b', 'c'], [{ agentId: 'x', p: 0.6 }]);
    const records = agentRecords(storeOf(state));

    expect([...records.values()].reduce((n, r) => n + r.reference, 0)).toBe(1);
  });

  it('sums payouts across markets, negatives included', () => {
    const first = withSettlement(marketWith('m1', ['a', 'b', 'c'], [{ agentId: 'x', p: 0.6 }]), [
      { agentId: 'a', position: 1, kind: 'scored', amount: 0.25 },
      { agentId: 'b', position: 2, kind: 'flat-fee', amount: 0.1 },
    ]);
    const second = withSettlement(marketWith('m2', ['a', 'b', 'c'], [{ agentId: 'x', p: 0.4 }]), [
      { agentId: 'a', position: 1, kind: 'scored', amount: -0.4 },
    ]);

    const records = agentRecords(storeOf(first, second));
    expect(recordFor(records, 'a').net).toBeCloseTo(-0.15, 9);
    expect(recordFor(records, 'a').settledMarkets).toBe(2);
    expect(recordFor(records, 'b').flatFee).toBe(1);
    expect(recordFor(records, 'b').net).toBeCloseTo(0.1, 9);
  });

  it('attributes nothing from a market that has not settled', () => {
    // A market that closed a second ago has a price and no payments. Showing
    // zero would read as "scored nothing" rather than "not yet scored".
    const state = marketWith('m1', ['a', 'b', 'c'], [{ agentId: 'x', p: 0.6 }]);
    const records = agentRecords(storeOf(state));

    for (const r of records.values()) {
      expect(r.net).toBe(0);
      expect(r.settledMarkets).toBe(0);
    }
  });

  it('gives an agent nobody has heard of an empty record', () => {
    const records = agentRecords(new MarketStore());
    expect(recordFor(records, 'nobody')).toEqual({
      bonded: 0,
      reported: 0,
      reference: 0,
      timedOut: 0,
      flatFee: 0,
      net: 0,
      settledMarkets: 0,
    });
  });
});
