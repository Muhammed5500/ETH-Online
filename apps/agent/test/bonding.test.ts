/**
 * An agent deciding whether to join a market, and paying for it itself.
 *
 * The paying fetch is a stub here. What is being tested is the judgement
 * around the payment — what the agent joins, what it walks away from, and what
 * it refuses to pay — because those are the parts that spend real HBAR when
 * they are wrong.
 */
import { describe, expect, it, vi } from 'vitest';
import { BondingWatcher, type MarketSummary } from '../src/bonding.js';
import { Agent, type AgentConfig } from '../src/runner.js';
import { stubLlm } from '../src/llm.js';

function agentWith(sliceIds: string[]): Agent {
  const config: AgentConfig = {
    id: 'agent-01',
    accountId: '0.0.1001',
    privateKey: 'unused-here',
    publicKey: 'unused-here',
    sliceIds,
    persona: 'test',
  };
  return new Agent({
    config,
    llm: stubLlm(() => ({ probability: 0.5, reasoning: 'stub' })),
  });
}

function market(over: Partial<MarketSummary> = {}): MarketSummary {
  return {
    marketId: 'mkt-1',
    question: 'Is this protocol growth organic?',
    status: 'bonding',
    bondTinybar: '100000000',
    bondedCount: 0,
    ...over,
  };
}

function watcherFor(
  agent: Agent,
  payingFetch: ReturnType<typeof vi.fn>,
  maxBondTinybar = 500_000_000n,
): BondingWatcher {
  return new BondingWatcher({
    agent,
    agentId: 'agent-01',
    apiUrl: 'http://api.test',
    payingFetch: payingFetch as never,
    maxBondTinybar,
  });
}

const created = (): Response => new Response(JSON.stringify({ bondedCount: 1 }), { status: 201 });

describe('joining a market', () => {
  it('pays the bond and posts it', async () => {
    const pay = vi.fn(async () => created());
    const outcome = await watcherFor(agentWith(['liquidity']), pay).consider(market());

    expect(outcome).toBe('bonded');
    expect(pay).toHaveBeenCalledOnce();
    const [url, init] = pay.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/market/mkt-1/bond');
    expect(JSON.parse(String(init.body))).toEqual({ agentId: 'agent-01' });
  });

  it('walks away from a market it has nothing to say about', async () => {
    const pay = vi.fn(async () => created());
    // No slices: nothing to read, so nothing to add. Joining anyway would put
    // a bond behind a report made of noise.
    const outcome = await watcherFor(agentWith([]), pay).consider(market());

    expect(outcome).toBe('declined');
    expect(pay).not.toHaveBeenCalled();
  });

  it('refuses a bond above its own ceiling', async () => {
    const pay = vi.fn(async () => created());
    const outcome = await watcherFor(agentWith(['holders']), pay, 100_000_000n).consider(
      market({ bondTinybar: '900000000' }),
    );

    // A wrapped fetch pays whatever the 402 asks for, and the market sets that
    // price. Without the ceiling this is how an account gets drained.
    expect(outcome).toBe('too-expensive');
    expect(pay).not.toHaveBeenCalled();
  });

  it('treats a refusal as an answer, not as a reason to retry', async () => {
    const pay = vi.fn(async () => new Response('{}', { status: 409 }));
    const watcher = watcherFor(agentWith(['bridge']), pay);

    expect(await watcher.consider(market())).toBe('refused');
    // Same market again: already seen, so no second payment. A retry against a
    // bond that may have settled is how an agent pays twice.
    expect(await watcher.consider(market())).toBe('skipped');
    expect(pay).toHaveBeenCalledOnce();
  });

  it('survives a payment that throws', async () => {
    const pay = vi.fn(async () => {
      throw new Error('facilitator unreachable');
    });
    expect(await watcherFor(agentWith(['activity']), pay).consider(market())).toBe('error');
  });
});

describe('polling', () => {
  it('considers every market in bonding and ignores the rest', async () => {
    const pay = vi.fn(async () => created());
    const markets = [
      market({ marketId: 'mkt-1' }),
      market({ marketId: 'mkt-2', status: 'running' }),
      market({ marketId: 'mkt-3', status: 'settled' }),
      market({ marketId: 'mkt-4' }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ markets }), { status: 200 })),
    );

    const outcomes = await watcherFor(agentWith(['comparative']), pay).tick();

    expect(outcomes).toEqual(['bonded', 'bonded']);
    expect(pay).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('does not throw when the API is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );

    const events: string[] = [];
    const watcher = new BondingWatcher({
      agent: agentWith(['liquidity']),
      agentId: 'agent-01',
      apiUrl: 'http://api.test',
      payingFetch: vi.fn() as never,
      maxBondTinybar: 500_000_000n,
      onEvent: (e) => events.push(e),
    });

    expect(await watcher.tick()).toEqual([]);
    expect(events).toContain('bond-poll-failed');
    vi.unstubAllGlobals();
  });
});
