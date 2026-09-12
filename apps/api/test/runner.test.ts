/**
 * The loop that turns an opened market into a settled one.
 *
 * WHAT IS BEING TESTED. Not the mechanism — that is `core`'s job — and not the
 * orchestrator, which has its own suite. This is the decision layer above
 * both: when bonding closes, what happens when the pool never fills, and what
 * the runner refuses to do. Those three were the difference between "the API
 * accepts a market" and "a market runs", and until now nothing exercised them
 * because a script always stood in for them.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMS, Market, type MarketState } from '@ethonline/core';
import { HcsRandomSource } from '@ethonline/hedera';
import { MarketRunner } from '../src/runner.js';
import { MarketStore, type StoredMarket } from '../src/store.js';
import type { Orchestrator } from '../src/orchestrator.js';

const HASH = new Uint8Array(48).fill(7);

function storedMarket(over: Partial<StoredMarket> = {}): StoredMarket {
  const params = { ...DEFAULT_PARAMS, minPoolSize: 3 as number, k: 1, T: 1, alpha: 0.5 };
  const rng = new HcsRandomSource(HASH);
  return {
    id: 'mkt-1',
    question: 'Is this growth organic?',
    topicId: '0.0.1',
    params,
    prior: [0.5, 0.5],
    market: Market.create({ id: 'mkt-1', question: 'q', params }, rng),
    rng,
    depositTinybar: 99_314_719n,
    bondTinybar: 100_000_000n,
    askerAccountId: '0.0.500',
    createdAt: 0,
    bondingClosesAt: 10_000,
    minBondingClosesAt: 0,
    bonds: new Map(),
    annotations: new Map(),
    ...over,
  };
}

function bond(stored: StoredMarket, count: number): void {
  for (let i = 1; i <= count; i++) {
    const agentId = `agent-${String(i).padStart(2, '0')}`;
    stored.market.addBondedAgent(agentId);
    stored.bonds.set(agentId, {
      agentId,
      accountId: `0.0.${1000 + i}`,
      paidTinybar: stored.bondTinybar,
      bondedAt: 0,
    });
  }
}

/** Records what it was asked to do, and does none of it. */
function fakeOrchestrator(over: Partial<Orchestrator> = {}): {
  orchestrator: Orchestrator;
  calls: string[];
} {
  const calls: string[] = [];
  const orchestrator = {
    closeBonding: vi.fn(async (id: string) => {
      calls.push(`closeBonding:${id}`);
      return 'running' as const;
    }),
    runMarket: vi.fn(async (id: string) => {
      calls.push(`runMarket:${id}`);
      return { reports: [], status: 'closed' } as unknown as MarketState;
    }),
    settle: vi.fn(async (id: string, asker: string) => {
      calls.push(`settle:${id}:${asker}`);
      return { receipts: [], plan: { totalOutTinybar: 0n } } as never;
    }),
    ...over,
  } as unknown as Orchestrator;
  return { orchestrator, calls };
}

function runnerFor(
  stored: StoredMarket,
  orchestrator: Orchestrator,
  extras: { now?: number; refund?: (m: StoredMarket) => Promise<void> } = {},
): MarketRunner {
  const markets = new MarketStore();
  markets.add(stored);
  return new MarketRunner({
    markets,
    orchestrator,
    now: () => extras.now ?? 0,
    ...(extras.refund ? { refund: extras.refund } : {}),
  });
}

describe('when bonding closes', () => {
  it('waits while the pool is short and the window is open', async () => {
    const stored = storedMarket();
    bond(stored, 2);
    const { orchestrator, calls } = fakeOrchestrator();

    expect(await runnerFor(stored, orchestrator).tick()).toBe('waiting');
    expect(calls).toEqual([]);
  });

  it('keeps the door open while the minimum window is still running', async () => {
    // The pool is full, and that is not enough. Our twenty agents bond within
    // seconds; closing on a full pool alone would mean a stranger's agent
    // never sees the market, while the code still claims registration is open
    // to anyone.
    const stored = storedMarket({ minBondingClosesAt: 5_000 });
    bond(stored, 3);
    const { orchestrator, calls } = fakeOrchestrator();

    expect(await runnerFor(stored, orchestrator, { now: 1_000 }).tick()).toBe('waiting');
    expect(calls).toEqual([]);
  });

  it('runs once the minimum window has passed and the pool is full', async () => {
    const stored = storedMarket({ minBondingClosesAt: 5_000 });
    bond(stored, 3);
    const { orchestrator, calls } = fakeOrchestrator();

    expect(await runnerFor(stored, orchestrator, { now: 6_000 }).tick()).toBe('ran');
    expect(calls[0]).toBe('closeBonding:mkt-1');
  });

  it('still closes at the hard deadline, minimum window or not', async () => {
    const stored = storedMarket({ minBondingClosesAt: 999_999 });
    bond(stored, 3);
    const { orchestrator } = fakeOrchestrator();

    // bondingClosesAt is 10_000; past it the market runs regardless.
    expect(await runnerFor(stored, orchestrator, { now: 20_000 }).tick()).toBe('ran');
  });

  it('runs as soon as the pool is full, without waiting out the window', async () => {
    const stored = storedMarket();
    bond(stored, 3);
    const { orchestrator, calls } = fakeOrchestrator();

    expect(await runnerFor(stored, orchestrator).tick()).toBe('ran');
    expect(calls).toEqual(['closeBonding:mkt-1', 'runMarket:mkt-1', 'settle:mkt-1:0.0.500']);
  });

  it('never picks the same market up twice', async () => {
    const stored = storedMarket();
    bond(stored, 3);
    const { orchestrator, calls } = fakeOrchestrator();
    const runner = runnerFor(stored, orchestrator);

    await runner.tick();
    expect(await runner.tick()).toBe('waiting');
    expect(calls.filter((c) => c.startsWith('runMarket')).length).toBe(1);
  });
});

describe('a market that never fills', () => {
  it('is cancelled and refunded once the window is over', async () => {
    const stored = storedMarket();
    bond(stored, 2);
    const refunded: string[] = [];
    const { orchestrator, calls } = fakeOrchestrator({
      closeBonding: vi.fn(async () => 'cancelled' as const),
    } as Partial<Orchestrator>);

    const outcome = await runnerFor(stored, orchestrator, {
      now: 20_000,
      refund: async (m) => void refunded.push(m.id),
    }).tick();

    expect(outcome).toBe('cancelled');
    expect(refunded).toEqual(['mkt-1']);
    // Never run, never settled: there is nothing to score in a cancelled market.
    expect(calls.some((c) => c.startsWith('runMarket'))).toBe(false);
  });

  it('says so loudly when there is no refund executor', async () => {
    const stored = storedMarket();
    bond(stored, 2);
    const events: string[] = [];
    const { orchestrator } = fakeOrchestrator({
      closeBonding: vi.fn(async () => 'cancelled' as const),
    } as Partial<Orchestrator>);
    const markets = new MarketStore();
    markets.add(stored);
    const runner = new MarketRunner({
      markets,
      orchestrator,
      now: () => 20_000,
      onEvent: (e) => events.push(e),
    });

    expect(await runner.tick()).toBe('cancelled');
    expect(events).toContain('runner-unsettled');
  });
});

describe('what the runner refuses to do', () => {
  it('does not settle a market with no asker account', async () => {
    const stored = storedMarket({ askerAccountId: undefined });
    bond(stored, 3);
    const { orchestrator, calls } = fakeOrchestrator();

    // Paying a refund to a guessed account is worse than leaving the money in
    // the treasury, where a person can send it on once the asker says where.
    expect(await runnerFor(stored, orchestrator).tick()).toBe('unsettled');
    expect(calls).toEqual(['closeBonding:mkt-1', 'runMarket:mkt-1']);
  });

  it('reports a failure instead of throwing out of the loop', async () => {
    const stored = storedMarket();
    bond(stored, 3);
    const { orchestrator } = fakeOrchestrator({
      runMarket: vi.fn(async () => {
        throw new Error('an agent endpoint vanished');
      }),
    } as Partial<Orchestrator>);

    expect(await runnerFor(stored, orchestrator).tick()).toBe('failed');
  });

  it('leaves a failed market alone afterwards', async () => {
    const stored = storedMarket();
    bond(stored, 3);
    const { orchestrator } = fakeOrchestrator({
      runMarket: vi.fn(async () => {
        throw new Error('the chain is down');
      }),
    } as Partial<Orchestrator>);
    const runner = runnerFor(stored, orchestrator);

    await runner.tick();
    // Re-running a half-run market would draw agents a second time.
    expect(await runner.tick()).toBe('waiting');
  });
});
