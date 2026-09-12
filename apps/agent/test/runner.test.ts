/**
 * Tests for the runner.
 *
 * Two groups matter more than the rest. The behaviour tests pin the three demo
 * scenarios to observable facts rather than to prose in a slide: a lazy agent
 * must buy nothing and copy exactly, because that is what makes its payout
 * exactly zero under Theorem 7. And the evidence-failure test pins the rule
 * that a broken slice must never become a refusal to answer — a silent agent
 * loses its whole bond, which is strictly worse than answering from thinner
 * evidence and saying so.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SliceEvidence } from '@ethonline/graph';
import { stubLlm } from '../src/llm.js';
import {
  Agent,
  buildUserPrompt,
  evidenceDigest,
  type AgentConfig,
  type ReportInput,
} from '../src/runner.js';

const BASE: AgentConfig = {
  id: 'agent-01',
  accountId: '0.0.1',
  privateKey: 'k',
  publicKey: 'p',
  sliceIds: ['liquidity'],
  persona: 'You look at pool depth.',
};

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    marketId: 'mkt-1',
    question: 'Is this protocol growth organic?',
    position: 1,
    prior: [0.5, 0.5],
    history: [],
    ...over,
  };
}

function evidence(over: Partial<SliceEvidence> = {}): SliceEvidence {
  return {
    sliceId: 'liquidity',
    summary: 'Liquidity view',
    signals: [{ key: 'tvl_hhi', value: 0.42, unit: 'ratio', note: 'concentration' }],
    raw: {},
    queryCostUsd: 0.01,
    sources: ['subgraph-a'],
    queryCount: 1,
    caveats: [],
    ...over,
  };
}

describe('behaviour: honest', () => {
  it('reports what the model said', async () => {
    const agent = new Agent({
      config: BASE,
      llm: stubLlm(() => ({ probability: 0.72, reasoning: 'because' })),
    });
    const r = await agent.produceReport(input());
    expect(r.probability).toBe(0.72);
    expect(r.reasoning).toBe('because');
  });

  it('is the default when no behaviour is configured', () => {
    const agent = new Agent({ config: BASE, llm: stubLlm(() => ({ probability: 0.5, reasoning: '' })) });
    expect(agent.behavior).toBe('honest');
  });
});

describe('behaviour: liar', () => {
  it('inverts the model answer, so the market has something real to correct', async () => {
    const agent = new Agent({
      config: { ...BASE, behavior: 'liar' },
      llm: stubLlm(() => ({ probability: 0.8, reasoning: 'evidence says yes' })),
    });
    const r = await agent.produceReport(input());
    expect(r.probability).toBeCloseTo(0.2, 12);
  });

  it('still does the work first — it pays for evidence like anyone else', async () => {
    const judge = vi.fn(() => ({ probability: 0.9, reasoning: 'x' }));
    const agent = new Agent({ config: { ...BASE, behavior: 'liar' }, llm: stubLlm(judge) });
    await agent.produceReport(input());
    expect(judge).toHaveBeenCalledOnce();
  });
});

describe('behaviour: lazy', () => {
  it('copies the previous report EXACTLY — Theorem 7 depends on the exactness', async () => {
    // Not "approximately the previous price". S_CEM(r, q, q) is log(q/q) = 0
    // for every r, which is why the uninformed equilibrium pays exactly zero.
    // A lazy agent that drifted by a thousandth would be paid a thousandth,
    // and scenario 3 would show a number that is nearly zero instead of zero.
    const agent = new Agent({
      config: { ...BASE, behavior: 'lazy' },
      llm: stubLlm(() => {
        throw new Error('a lazy agent must not call the model');
      }),
    });
    const r = await agent.produceReport(
      input({
        position: 3,
        history: [
          { position: 1, agentId: 'a', belief: [0.3, 0.7] },
          { position: 2, agentId: 'b', belief: [0.37, 0.63] },
        ],
      }),
    );
    expect(r.probability).toBe(0.63);
  });

  it('buys no evidence at all, so it costs the market nothing to run', async () => {
    const agent = new Agent({
      config: { ...BASE, behavior: 'lazy' },
      llm: stubLlm(() => ({ probability: 0.1, reasoning: '' })),
    });
    const r = await agent.produceReport(input({ history: [] }));
    expect(r.evidenceCostUsd).toBe(0);
    expect(r.sliceIds).toEqual([]);
    expect(r.caveats.join(' ')).toMatch(/no evidence/i);
  });

  it('falls back to the prior when it is first and has nothing to copy', async () => {
    const agent = new Agent({
      config: { ...BASE, behavior: 'lazy' },
      llm: stubLlm(() => ({ probability: 0.1, reasoning: '' })),
    });
    const r = await agent.produceReport(input({ prior: [0.6, 0.4], history: [] }));
    expect(r.probability).toBe(0.4);
  });
});

describe('evidence failure is a caveat, never a refusal', () => {
  it('answers anyway when no gateway is configured, and says so', async () => {
    const agent = new Agent({
      config: BASE,
      llm: stubLlm((req) => {
        expect(req.user).toMatch(/LIMITS ON YOUR EVIDENCE/);
        return { probability: 0.5, reasoning: 'thin' };
      }),
    });
    const r = await agent.produceReport(input());
    expect(r.probability).toBe(0.5);
    expect(r.caveats.length).toBeGreaterThan(0);
  });

  it('names the slice that failed so an operator can fix the right thing', async () => {
    const gateway = {
      query: async () => {
        throw new Error('bad indexers');
      },
    } as never;
    const agent = new Agent({
      config: BASE,
      llm: stubLlm(() => ({ probability: 0.5, reasoning: '' })),
      gateway,
      targets: { subgraphId: 'sg-1' },
    });
    const { caveats } = await agent.gatherEvidence('q');
    expect(caveats.join(' ')).toMatch(/liquidity/);
  });
});

describe('evidenceDigest', () => {
  it('does not change when signals are merely reordered', () => {
    const a = evidence({
      signals: [
        { key: 'b', value: 2, unit: 'ratio', note: '' },
        { key: 'a', value: 1, unit: 'ratio', note: '' },
      ],
    });
    const b = evidence({
      signals: [
        { key: 'a', value: 1, unit: 'ratio', note: '' },
        { key: 'b', value: 2, unit: 'ratio', note: '' },
      ],
    });
    expect(evidenceDigest([a])).toBe(evidenceDigest([b]));
  });

  it('changes when a figure changes, which is the only thing it must do', () => {
    const a = evidence();
    const b = evidence({ signals: [{ key: 'tvl_hhi', value: 0.43, unit: 'ratio', note: 'c' }] });
    expect(evidenceDigest([a])).not.toBe(evidenceDigest([b]));
  });

  it('ignores the raw rows, which carry gateway noise that changes per call', () => {
    expect(evidenceDigest([evidence({ raw: { at: 1 } })])).toBe(
      evidenceDigest([evidence({ raw: { at: 2 } })]),
    );
  });
});

describe('the prompt an agent is given', () => {
  it('contains every earlier report, because the equilibrium assumes it does', () => {
    const text = buildUserPrompt(
      input({
        position: 3,
        history: [
          { position: 1, agentId: 'a', belief: [0.2, 0.8] },
          { position: 2, agentId: 'b', belief: [0.45, 0.55] },
        ],
      }),
      [evidence()],
      [],
    );
    expect(text).toMatch(/1\. a reported P\(yes\) = 0\.8/);
    expect(text).toMatch(/2\. b reported P\(yes\) = 0\.55/);
    expect(text).toMatch(/Liquidity view/);
  });

  it('says plainly when the agent is first', () => {
    expect(buildUserPrompt(input(), [], [])).toMatch(/You are first/);
  });
});

describe('decideToBond', () => {
  it('joins when it has a slice to bring', () => {
    const agent = new Agent({ config: BASE, llm: stubLlm(() => ({ probability: 0.5, reasoning: '' })) });
    expect(agent.decideToBond('is it organic?')).toBe(true);
  });

  it('declines an empty question', () => {
    const agent = new Agent({ config: BASE, llm: stubLlm(() => ({ probability: 0.5, reasoning: '' })) });
    expect(agent.decideToBond('   ')).toBe(false);
  });

  it('declines when it has no slices and nothing to say', () => {
    const agent = new Agent({
      config: { ...BASE, sliceIds: [] },
      llm: stubLlm(() => ({ probability: 0.5, reasoning: '' })),
    });
    expect(agent.decideToBond('is it organic?')).toBe(false);
  });
});
