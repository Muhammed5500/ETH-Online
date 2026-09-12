/**
 * Tests for the pool.
 *
 * The one that matters is "no two agents share a slice set". Everything else
 * here is bookkeeping. Two agents on identical evidence are one agent with two
 * votes as far as the mechanism is concerned: Assumption 4 breaks, the
 * Bhattacharyya coefficient goes to 1, and the `k` Theorem 1 demands goes with
 * it. That failure is invisible at runtime — the market runs perfectly and its
 * honesty guarantee is worth nothing — so it has to be caught here.
 */
import { describe, expect, it } from 'vitest';
import type { AgentAccount } from '@ethonline/hedera';
import { POOL_SLICE_IDS, buildAgentPool, buildPersona, sliceSubsets } from '../src/pool.js';

function accounts(n: number): AgentAccount[] {
  return Array.from({ length: n }, (_, i) => ({
    agentId: `agent-${String(i + 1).padStart(2, '0')}`,
    accountId: `0.0.${1000 + i}`,
    privateKey: `priv-${i}`,
    publicKey: `pub-${i}`,
    evmAddress: `0x${String(i).padStart(40, '0')}`,
  }));
}

describe('sliceSubsets', () => {
  it('enumerates every non-empty subset of the five slices', () => {
    expect(sliceSubsets()).toHaveLength(2 ** POOL_SLICE_IDS.length - 1);
  });

  it('puts the singletons first, so a pool of five covers every slice alone', () => {
    const first5 = sliceSubsets().slice(0, 5);
    expect(first5.every((s) => s.length === 1)).toBe(true);
    expect(first5.flat().sort()).toEqual([...POOL_SLICE_IDS].sort());
  });

  it('never repeats a subset', () => {
    const keys = sliceSubsets().map((s) => s.join('+'));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('buildAgentPool', () => {
  it('builds twenty agents from twenty accounts', () => {
    expect(buildAgentPool(accounts(20))).toHaveLength(20);
  });

  it('ASSUMPTION 4: no two agents look at the same set of slices', () => {
    const pool = buildAgentPool(accounts(20));
    const keys = pool.map((a) => [...a.sliceIds].sort().join('+'));
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes, `agents sharing a slice set: ${dupes.join(', ')}`).toEqual([]);
  });

  it('uses every slice, so no view of the question goes unread', () => {
    const used = new Set(buildAgentPool(accounts(20)).flatMap((a) => a.sliceIds));
    expect([...used].sort()).toEqual([...POOL_SLICE_IDS].sort());
  });

  it('carries the Hedera account through unchanged — payouts depend on it', () => {
    const pool = buildAgentPool(accounts(3));
    expect(pool[0]).toMatchObject({
      id: 'agent-01',
      accountId: '0.0.1000',
      privateKey: 'priv-0',
      publicKey: 'pub-0',
    });
  });

  it('gives every agent its own persona', () => {
    const personas = buildAgentPool(accounts(20)).map((a) => a.persona);
    expect(new Set(personas).size).toBe(personas.length);
  });

  it('defaults to honest and never writes the field', () => {
    expect(buildAgentPool(accounts(1))[0]!.behavior).toBeUndefined();
  });

  it('applies staged behaviours by agent id, for the demo scenarios only', () => {
    const pool = buildAgentPool(accounts(3), { behaviors: { 'agent-02': 'liar' } });
    expect(pool[0]!.behavior).toBeUndefined();
    expect(pool[1]!.behavior).toBe('liar');
  });

  it('REFUSES to run out of distinct subsets rather than quietly reusing one', () => {
    // 31 subsets exist. A 32nd agent would have to duplicate, and duplicating
    // silently is the exact failure this file prevents.
    expect(() => buildAgentPool(accounts(32))).toThrow(/distinct slice subsets/);
  });

  it('honours a limit smaller than the account list', () => {
    expect(buildAgentPool(accounts(20), { limit: 6 })).toHaveLength(6);
  });
});

describe('buildPersona', () => {
  it('names what a single-slice agent looks at', () => {
    expect(buildPersona(['liquidity'])).toMatch(/exactly one thing/);
    expect(buildPersona(['liquidity'])).toMatch(/pool depth/);
  });

  it('tells every agent that its own view is partial', () => {
    // Without this the model treats its slice as the whole picture and stops
    // updating on the earlier reports, which is the behaviour the market needs.
    expect(buildPersona(['holders', 'activity'])).toMatch(/do not see what the other analysts see/i);
  });
});
