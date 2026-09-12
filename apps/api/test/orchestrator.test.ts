/**
 * Orchestrator tests — the whole market lifecycle, offline.
 *
 * The cases that carry weight are about ORDER and about what a timeout may
 * not do:
 *
 *   the stopping dice must come from the hash of the report just written
 *   a timeout must not roll the dice at all
 *   an unusable answer must be slashed like silence, not tolerated
 *
 * Get any of those wrong and the market still runs, still pays out, and is
 * quietly manipulable.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { DEFAULT_PARAMS, type MarketParams } from '@ethonline/core';
import { createApp, type Api } from '../src/app.js';
import { Orchestrator, type AgentTransport, type Payer, type PayerReceipt } from '../src/orchestrator.js';
import type { TransferLine } from '../src/settlement-plan.js';
import { agentPool, createFakeLedger, type FakeLedger, type TestAgent } from './helpers.js';

let ledger: FakeLedger;
let api: Api;
let agents: TestAgent[];
let sent: Array<{ lines: readonly TransferLine[]; memo: string }>;

/** Answers honestly, signing whatever it is asked for. */
function honestTransport(behaviour?: (agentId: string, position: number) => number): AgentTransport {
  return {
    async requestReport(agent, req) {
      const testAgent = agents.find((a) => a.agentId === agent.agentId)!;
      const probability = behaviour?.(agent.agentId, req.position) ?? 0.7;
      return {
        probability,
        signature: testAgent.sign({
          marketId: req.marketId,
          agentId: agent.agentId,
          position: req.position,
          belief: [1 - probability, probability],
        }),
      };
    },
  };
}

function recordingPayer(): Payer {
  return {
    async send(lines, memo): Promise<PayerReceipt> {
      sent.push({ lines, memo });
      return { transactionId: `0.0.1@${sent.length}`, status: 'SUCCESS' };
    },
  };
}

function makeOrchestrator(transport: AgentTransport, params?: Partial<OrchestratorOverrides>) {
  return new Orchestrator({
    markets: api.markets,
    registry: api.registry,
    ledger,
    transport,
    payer: recordingPayer(),
    hbarPerUnit: 1,
    reportTimeoutMs: 50,
    ...params,
  });
}
interface OrchestratorOverrides {
  reportTimeoutMs: number;
  maxCreditsPerTransaction: number;
  onEvent: (event: string, detail: Record<string, unknown>) => void;
}

async function seedMarket(marketParams?: Partial<MarketParams>): Promise<string> {
  agents = agentPool(DEFAULT_PARAMS.minPoolSize);
  for (const a of agents) {
    await request(api.app)
      .post('/agents/register')
      .send(a.registration({ endpoint: `http://localhost:9/${a.agentId}` }))
      .expect(201);
  }
  const res = await request(api.app)
    .post('/market')
    .send({ question: 'Is this protocol growth organic?', params: marketParams })
    .expect(201);
  const marketId = res.body.marketId as string;
  for (const a of agents) {
    await request(api.app).post(`/market/${marketId}/bond`).send({ agentId: a.agentId }).expect(201);
  }
  return marketId;
}

beforeEach(() => {
  ledger = createFakeLedger();
  api = createApp({ ledger });
  sent = [];
});

describe('closeBonding', () => {
  it('starts a market with a full pool', async () => {
    const marketId = await seedMarket();
    const orch = makeOrchestrator(honestTransport());
    expect(await orch.closeBonding(marketId)).toBe('running');
  });

  it('cancels a market that never filled its pool', async () => {
    // Below minPoolSize the pool runs out almost immediately and the stopping
    // time stops being unpredictable, which is the assumption everything rests
    // on. Better to refund than to run a market that cannot mean anything.
    agents = agentPool(2);
    for (const a of agents) {
      await request(api.app)
        .post('/agents/register')
        .send(a.registration())
        .expect(201);
    }
    const res = await request(api.app).post('/market').send({ question: 'q' }).expect(201);
    await request(api.app)
      .post(`/market/${res.body.marketId}/bond`)
      .send({ agentId: agents[0]!.agentId })
      .expect(201);

    const orch = makeOrchestrator(honestTransport());
    expect(await orch.closeBonding(res.body.marketId)).toBe('cancelled');
  });
});

describe('runRound — ordering', () => {
  it('writes the report to the ledger BEFORE rolling the dice', async () => {
    // If the dice were rolled first they would come from the previous message's
    // hash, which already existed — and a stopping decision anyone could have
    // computed in advance is not a stopping decision.
    const marketId = await seedMarket();
    const orch = makeOrchestrator(honestTransport());
    await orch.closeBonding(marketId);

    const stored = api.markets.get(marketId)!;
    const hashBefore = stored.rng.runningHash;
    await orch.runRound(marketId);

    const stopDraws = stored.rng.draws.filter((d) => d.purpose === 'stop');
    expect(stopDraws).toHaveLength(1);
    // The stopping roll used the NEW hash, not the one that existed before.
    expect(stopDraws[0]!.runningHashHex).not.toBe(
      Buffer.from(hashBefore!).toString('hex'),
    );
    expect(stopDraws[0]!.runningHashHex).toBe(Buffer.from(stored.rng.runningHash!).toString('hex'));
  });

  it('records the report on the ledger with both beliefs', async () => {
    const marketId = await seedMarket();
    const orch = makeOrchestrator(honestTransport());
    await orch.closeBonding(marketId);
    const result = await orch.runRound(marketId);

    const stored = api.markets.get(marketId)!;
    const messages = ledger.topics.get(stored.topicId)!;
    expect(messages[0]).toMatchObject({ type: 'market-open' });
    expect(messages[1]).toMatchObject({ type: 'report', agentId: result.agentId, position: 1 });
  });
});

describe('runRound — a timeout is not a round', () => {
  const silentTransport: AgentTransport = {
    async requestReport() {
      throw new Error('agent did not answer');
    },
  };

  it('does NOT roll the stopping dice when an agent goes silent', async () => {
    // Otherwise any agent could close a market early just by staying quiet.
    const marketId = await seedMarket();
    const orch = makeOrchestrator(silentTransport);
    await orch.closeBonding(marketId);
    const result = await orch.runRound(marketId);

    expect(result.outcome).toBe('timed-out');
    const stored = api.markets.get(marketId)!;
    expect(stored.rng.draws.filter((d) => d.purpose === 'stop')).toHaveLength(0);
    expect(stored.market.status).toBe('running');
  });

  it('writes a timeout to the ledger and still advances the randomness', async () => {
    const marketId = await seedMarket();
    const orch = makeOrchestrator(silentTransport);
    await orch.closeBonding(marketId);

    const stored = api.markets.get(marketId)!;
    const before = Buffer.from(stored.rng.runningHash!).toString('hex');
    await orch.runRound(marketId);

    expect(ledger.topics.get(stored.topicId)![1]).toMatchObject({ type: 'timeout' });
    // Fresh entropy for the next draw, even though no dice were rolled.
    expect(Buffer.from(stored.rng.runningHash!).toString('hex')).not.toBe(before);
  });

  it('drops the agent from the pool so it cannot be drawn again', async () => {
    const marketId = await seedMarket();
    const orch = makeOrchestrator(silentTransport);
    await orch.closeBonding(marketId);

    const first = await orch.runRound(marketId);
    const second = await orch.runRound(marketId);
    expect(second.agentId).not.toBe(first.agentId);
  });
});

describe('runRound — an unusable answer is slashed like silence', () => {
  it('slashes a bad signature', async () => {
    // If a bad signature were merely refused, an agent that disliked its
    // position could send garbage, escape scoring and keep its bond.
    const marketId = await seedMarket();
    const forger: AgentTransport = {
      async requestReport(agent, req) {
        const other = agents.find((a) => a.agentId !== agent.agentId)!;
        return {
          probability: 0.7,
          signature: other.sign({
            marketId: req.marketId,
            agentId: agent.agentId,
            position: req.position,
            belief: [0.3, 0.7],
          }),
        };
      },
    };
    const orch = makeOrchestrator(forger);
    await orch.closeBonding(marketId);
    const result = await orch.runRound(marketId);

    expect(result.outcome).toBe('timed-out');
    expect(result.reason).toMatch(/signature/i);
    expect(api.markets.get(marketId)!.market.getState().timedOutAgents).toHaveLength(1);
  });

  it('slashes a probability outside [0,1]', async () => {
    const marketId = await seedMarket();
    const nonsense: AgentTransport = {
      async requestReport(agent, req) {
        const testAgent = agents.find((a) => a.agentId === agent.agentId)!;
        return {
          probability: 42,
          signature: testAgent.sign({
            marketId: req.marketId,
            agentId: agent.agentId,
            position: req.position,
            belief: [0.5, 0.5],
          }),
        };
      },
    };
    const orch = makeOrchestrator(nonsense);
    await orch.closeBonding(marketId);
    const result = await orch.runRound(marketId);
    expect(result.outcome).toBe('timed-out');
    expect(result.reason).toMatch(/\[0, 1\]/);
  });
});

describe('runMarket', () => {
  it('runs to a close and writes market-close exactly once', async () => {
    const marketId = await seedMarket();
    const orch = makeOrchestrator(honestTransport());
    const state = await orch.runMarket(marketId);

    expect(state.status).toBe('closed');
    expect(state.reports.length).toBeGreaterThan(0);

    const stored = api.markets.get(marketId)!;
    const messages = ledger.topics.get(stored.topicId)!;
    expect(messages.filter((m) => m.type === 'market-close')).toHaveLength(1);
    expect(messages[messages.length - 1]).toMatchObject({ type: 'market-close' });
  });

  it('puts every event on the ledger in order', async () => {
    const marketId = await seedMarket();
    const orch = makeOrchestrator(honestTransport());
    const state = await orch.runMarket(marketId);

    const stored = api.markets.get(marketId)!;
    const types = ledger.topics.get(stored.topicId)!.map((m) => m.type);
    expect(types[0]).toBe('market-open');
    expect(types[types.length - 1]).toBe('market-close');
    expect(types.filter((t) => t === 'report')).toHaveLength(state.reports.length);
  });

  it('the reference is the last agent to report', async () => {
    const marketId = await seedMarket();
    const orch = makeOrchestrator(honestTransport());
    const state = await orch.runMarket(marketId);
    const last = state.reports[state.reports.length - 1]!;
    expect(state.referenceReport?.agentId).toBe(last.agentId);
  });

  it('survives a pool where every agent goes silent', async () => {
    const marketId = await seedMarket();
    const orch = makeOrchestrator({
      async requestReport() {
        throw new Error('nobody home');
      },
    });
    const state = await orch.runMarket(marketId);
    expect(state.status).toBe('closed');
    expect(state.closedReason).toBe('pool-exhausted');
    expect(state.reports).toHaveLength(0);
    expect(state.timedOutAgents).toHaveLength(DEFAULT_PARAMS.minPoolSize);
  });
});

describe('settle', () => {
  it('records the settlement on the ledger BEFORE moving money', async () => {
    // If a transfer fails, what should have happened is already public and can
    // be compared with what actually moved.
    const marketId = await seedMarket();
    const orch = makeOrchestrator(honestTransport());
    await orch.runMarket(marketId);

    const order: string[] = [];
    const stored = api.markets.get(marketId)!;
    const originalAppend = ledger.append.bind(ledger);
    ledger.append = async (topicId, message) => {
      order.push(`ledger:${message.type}`);
      return originalAppend(topicId, message);
    };
    const orch2 = new Orchestrator({
      markets: api.markets,
      registry: api.registry,
      ledger,
      transport: honestTransport(),
      payer: {
        async send(lines, memo) {
          order.push('payer');
          sent.push({ lines, memo });
          return { transactionId: 'tx', status: 'SUCCESS' };
        },
      },
      hbarPerUnit: 1,
    });
    await orch2.settle(marketId, '0.0.999');

    expect(order[0]).toBe('ledger:settlement');
    expect(order).toContain('payer');
    expect(order.indexOf('ledger:settlement')).toBeLessThan(order.indexOf('payer'));
    expect(stored.market.status).toBe('settled');
  });

  it('pays out exactly what came in', async () => {
    const marketId = await seedMarket();
    const orch = makeOrchestrator(honestTransport());
    await orch.runMarket(marketId);
    const { plan } = await orch.settle(marketId, '0.0.999');

    expect(plan.totalOutTinybar).toBe(plan.totalInTinybar);
    const actuallySent = sent
      .flatMap((s) => s.lines)
      .reduce((sum, l) => sum + l.amountTinybar, 0n);
    expect(actuallySent).toBe(plan.totalInTinybar);
  });

  it('pays every bonded agent and the asker', async () => {
    const marketId = await seedMarket();
    const orch = makeOrchestrator(honestTransport());
    await orch.runMarket(marketId);
    const { plan } = await orch.settle(marketId, '0.0.999');

    const beneficiaries = new Set(plan.lines.map((l) => l.beneficiary));
    expect(beneficiaries.has('asker')).toBe(true);
    // 20 agents bonded and none timed out, so all of them get something back.
    expect(beneficiaries.size).toBe(DEFAULT_PARAMS.minPoolSize + 1);
  });

  it('splits a 21-line settlement into several transactions', async () => {
    const marketId = await seedMarket();
    const orch = makeOrchestrator(honestTransport());
    await orch.runMarket(marketId);
    const { receipts, plan } = await orch.settle(marketId, '0.0.999');

    expect(receipts.length).toBe(Math.ceil(plan.lines.length / 9));
    expect(sent).toHaveLength(receipts.length);
    for (const s of sent) expect(s.lines.length).toBeLessThanOrEqual(9);
  });

  it('keeps a slashed bond away from the other agents', async () => {
    const marketId = await seedMarket();
    let calls = 0;
    const flaky: AgentTransport = {
      async requestReport(agent, req) {
        // First agent drawn goes silent; the rest answer.
        if (calls++ === 0) throw new Error('silent');
        const testAgent = agents.find((a) => a.agentId === agent.agentId)!;
        return {
          probability: 0.7,
          signature: testAgent.sign({
            marketId: req.marketId,
            agentId: agent.agentId,
            position: req.position,
            belief: [0.3, 0.7],
          }),
        };
      },
    };
    const orch = makeOrchestrator(flaky);
    const state = await orch.runMarket(marketId);
    expect(state.timedOutAgents).toHaveLength(1);

    const { plan } = await orch.settle(marketId, '0.0.999');
    const timedOutId = state.timedOutAgents[0]!;
    expect(plan.lines.find((l) => l.beneficiary === timedOutId)).toBeUndefined();
    expect(plan.slashedTinybar).toBe(100_000_000n);
    expect(plan.totalOutTinybar).toBe(plan.totalInTinybar);
  });

  it('refuses to settle a market that has not closed', async () => {
    const marketId = await seedMarket();
    const orch = makeOrchestrator(honestTransport());
    await orch.closeBonding(marketId);
    await expect(orch.settle(marketId, '0.0.999')).rejects.toThrow(/only a closed market/);
  });
});

describe('event stream', () => {
  it('reports what happened, for the live market page', async () => {
    const events: string[] = [];
    const marketId = await seedMarket();
    const orch = makeOrchestrator(honestTransport(), {
      onEvent: (e) => events.push(e),
    });
    await orch.runMarket(marketId);
    await orch.settle(marketId, '0.0.999');

    expect(events).toContain('bonding-closed');
    expect(events).toContain('agent-drawn');
    expect(events).toContain('report');
    expect(events).toContain('market-closed');
    expect(events).toContain('settled');
  });
});
