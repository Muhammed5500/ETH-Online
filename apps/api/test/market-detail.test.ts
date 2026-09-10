/**
 * The two endpoints the live market page reads.
 *
 * `/market/:id/reports` and `/market/:id/randomness` exist so a reader can
 * check the market rather than take its word for it. The tests that carry
 * weight are the ones about what is NOT published:
 *
 *   The draw for an agent that has been picked but has not reported is
 *   hidden. Publishing it would say who is about to speak, and the whole
 *   reason the draw happens one round at a time is that nobody may learn the
 *   order in advance (PLAN section 6.4). Get this wrong and the last agent
 *   knows it is the reference before it reports — which is exactly the
 *   information the mechanism is built to withhold.
 *
 *   Reasoning is not signed and must never look like it is. The signature
 *   covers the probability; prose is an agent's account of itself.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { DEFAULT_PARAMS } from '@ethonline/core';
import { hashToUnitInterval, fromHex, verifyStoppingDecision } from '@ethonline/hedera';
import { createApp, type Api } from '../src/app.js';
import { Orchestrator, type AgentTransport, type Payer } from '../src/orchestrator.js';
import { agentPool, createFakeLedger, type FakeLedger, type TestAgent } from './helpers.js';

let ledger: FakeLedger;
let api: Api;
let agents: TestAgent[];

function transport(extra?: (position: number) => Record<string, unknown>): AgentTransport {
  return {
    async requestReport(agent, req) {
      const testAgent = agents.find((a) => a.agentId === agent.agentId)!;
      const probability = 0.3 + req.position * 0.05;
      return {
        probability,
        signature: testAgent.sign({
          marketId: req.marketId,
          agentId: agent.agentId,
          position: req.position,
          belief: [1 - probability, probability],
        }),
        ...extra?.(req.position),
      };
    },
  };
}

const silentPayer: Payer = {
  async send() {
    return { transactionId: 'tx', status: 'SUCCESS' };
  },
};

function orchestrator(t: AgentTransport): Orchestrator {
  return new Orchestrator({
    markets: api.markets,
    registry: api.registry,
    ledger,
    transport: t,
    payer: silentPayer,
    hbarPerUnit: 1,
    reportTimeoutMs: 50,
  });
}

async function seedMarket(): Promise<string> {
  agents = agentPool(DEFAULT_PARAMS.minPoolSize);
  for (const a of agents) {
    await request(api.app)
      .post('/agents/register')
      .send({
        agentId: a.agentId,
        accountId: a.accountId,
        publicKey: a.publicKey,
        endpoint: `http://localhost:9/${a.agentId}`,
      })
      .expect(201);
  }
  const res = await request(api.app).post('/market').send({ question: 'q?' }).expect(201);
  const marketId = res.body.marketId as string;
  for (const a of agents) {
    await request(api.app).post(`/market/${marketId}/bond`).send({ agentId: a.agentId }).expect(201);
  }
  return marketId;
}

/** Runs rounds until the market closes or `max` reports exist. */
async function runSome(marketId: string, orch: Orchestrator, max: number): Promise<void> {
  await orch.closeBonding(marketId);
  for (let i = 0; i < max; i++) {
    if (api.markets.get(marketId)!.market.status !== 'running') break;
    await orch.runRound(marketId);
  }
}

beforeEach(() => {
  ledger = createFakeLedger();
  api = createApp({ ledger });
});

describe('GET /market/:id/reports', () => {
  it('404s for a market that does not exist', async () => {
    await request(api.app).get('/market/nope/reports').expect(404);
  });

  it('chains previousBelief from the prior through every report', async () => {
    // The scoring rule pays for the MOVE, not the level. A report without the
    // price it moved from is a number with nothing to compare it to.
    const marketId = await seedMarket();
    await runSome(marketId, orchestrator(transport()), 3);

    const res = await request(api.app).get(`/market/${marketId}/reports`).expect(200);
    const reports = res.body.reports as Array<{
      position: number;
      belief: [number, number];
      previousBelief: [number, number];
    }>;

    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]!.previousBelief).toEqual(res.body.prior);
    for (let i = 1; i < reports.length; i++) {
      expect(reports[i]!.previousBelief).toEqual(reports[i - 1]!.belief);
    }
  });

  it('carries the agent notes when an agent supplied them', async () => {
    const marketId = await seedMarket();
    await runSome(
      marketId,
      orchestrator(
        transport((position) => ({
          reasoning: `position ${position}: pool depth is thin relative to volume`,
          sliceIds: ['liquidity', 'activity'],
          evidenceCostUsd: 0.008,
          evidenceDigest: 'sha256:abc123',
        })),
      ),
      2,
    );

    const res = await request(api.app).get(`/market/${marketId}/reports`).expect(200);
    const first = res.body.reports[0];
    expect(first.reasoning).toContain('pool depth');
    expect(first.sliceIds).toEqual(['liquidity', 'activity']);
    expect(first.evidenceCostUsd).toBe(0.008);
    expect(first.evidenceDigest).toBe('sha256:abc123');
  });

  it('omits the note fields entirely when an agent supplied none', async () => {
    // Absent, not null. A page that renders "reasoning: null" is worse than
    // one that renders nothing.
    const marketId = await seedMarket();
    await runSome(marketId, orchestrator(transport()), 1);

    const first = (await request(api.app).get(`/market/${marketId}/reports`).expect(200)).body
      .reports[0];
    expect('reasoning' in first).toBe(false);
    expect('sliceIds' in first).toBe(false);
    expect('evidenceCostUsd' in first).toBe(false);
  });

  it('puts the evidence digest on the HCS record but not the reasoning', async () => {
    // A hash can be checked afterwards. Prose cannot, and an unbounded string
    // on the ledger buys nothing while spending the single-message budget.
    const marketId = await seedMarket();
    await runSome(
      marketId,
      orchestrator(
        transport(() => ({ reasoning: 'a long account of itself', evidenceDigest: 'sha256:xyz' })),
      ),
      1,
    );

    const stored = api.markets.get(marketId)!;
    const reportMessages = (ledger.topics.get(stored.topicId) ?? []).filter(
      (m) => m.type === 'report',
    );
    expect(reportMessages.length).toBeGreaterThan(0);
    const first = reportMessages[0] as unknown as Record<string, unknown>;
    expect(first['evidenceDigest']).toBe('sha256:xyz');
    expect('reasoning' in first).toBe(false);
  });

  it('marks a report that had to be clipped', async () => {
    const marketId = await seedMarket();
    const orch = orchestrator({
      async requestReport(agent, req) {
        const testAgent = agents.find((a) => a.agentId === agent.agentId)!;
        // Far outside what the bond can carry, so the move limit bites.
        const probability = 0.999;
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
    });
    await runSome(marketId, orch, 1);

    const first = (await request(api.app).get(`/market/${marketId}/reports`).expect(200)).body
      .reports[0];
    expect(first.clipped).toBe(true);
    expect(first.rawBelief[1]).toBeGreaterThan(first.belief[1]);
  });
});

describe('GET /market/:id/randomness', () => {
  it('404s for a market that does not exist', async () => {
    await request(api.app).get('/market/nope/randomness').expect(404);
  });

  it('publishes a stopping roll with the hash and the comparison', async () => {
    const marketId = await seedMarket();
    await runSome(marketId, orchestrator(transport()), 3);

    const res = await request(api.app).get(`/market/${marketId}/randomness`).expect(200);
    const stops = (res.body.draws as Array<Record<string, unknown>>).filter(
      (d) => d['purpose'] === 'stop',
    );

    expect(stops.length).toBeGreaterThan(0);
    for (const s of stops) {
      expect(typeof s['runningHash']).toBe('string');
      expect(s['alpha']).toBe(DEFAULT_PARAMS.alpha);
      expect(typeof s['stopped']).toBe('boolean');
    }
  });

  it('the published value is what the published hash produces', async () => {
    // The point of the endpoint: a sceptic recomputes this and gets the same
    // number, or the orchestrator is lying.
    const marketId = await seedMarket();
    await runSome(marketId, orchestrator(transport()), 3);

    const res = await request(api.app).get(`/market/${marketId}/randomness`).expect(200);
    for (const d of res.body.draws as Array<Record<string, unknown>>) {
      const bytes = fromHex(String(d['runningHash']));
      const recomputed = hashToUnitInterval(bytes, d['purpose'] as 'stop' | 'draw');
      expect(recomputed).toBe(d['value']);
      if (d['purpose'] === 'stop') {
        expect(
          verifyStoppingDecision(bytes, DEFAULT_PARAMS.alpha, d['stopped'] as boolean),
        ).toBe(true);
      }
    }
  });

  it('agrees with the market about whether it closed', async () => {
    const marketId = await seedMarket();
    await runSome(marketId, orchestrator(transport()), 25);

    const stored = api.markets.get(marketId)!;
    const res = await request(api.app).get(`/market/${marketId}/randomness`).expect(200);
    const stops = (res.body.draws as Array<Record<string, unknown>>).filter(
      (d) => d['purpose'] === 'stop',
    );
    const anyStopped = stops.some((d) => d['stopped'] === true);

    // A market that closed on the dice must have exactly one roll that landed
    // below alpha; one that ran out of agents must have none.
    if (stored.market.getState().closedReason === 'stopping-rule') {
      expect(stops.filter((d) => d['stopped'] === true)).toHaveLength(1);
    } else {
      expect(anyStopped).toBe(false);
    }
  });

  it('HIDES THE DRAW FOR AN AGENT THAT HAS NOT REPORTED YET', async () => {
    // The load-bearing test. Publishing this draw alongside the pool would
    // say who is about to speak, and the reason the draw is lazy in the first
    // place is that nobody may learn the order in advance.
    const marketId = await seedMarket();
    await runSome(marketId, orchestrator(transport()), 2);

    const stored = api.markets.get(marketId)!;
    if (stored.market.status !== 'running') return; // dice closed it; nothing to hide

    const reportsBefore = stored.market.reportCount;
    const pending = stored.market.drawNextAgent();
    expect(pending).not.toBeNull();
    expect(stored.market.getState().pendingAgentId).toBe(pending);

    const res = await request(api.app).get(`/market/${marketId}/randomness`).expect(200);
    const draws = res.body.draws as Array<Record<string, unknown>>;

    // Nothing published for the position that has not reported.
    expect(draws.every((d) => Number(d['position']) <= reportsBefore)).toBe(true);
    expect(res.body.pendingHidden).toBe(true);

    // And the market view still does not name the pending agent.
    const view = await request(api.app).get(`/market/${marketId}`).expect(200);
    expect(JSON.stringify(view.body)).not.toContain(pending!);
  });

  it('says how to check it, rather than asking to be believed', async () => {
    const marketId = await seedMarket();
    await runSome(marketId, orchestrator(transport()), 1);
    const res = await request(api.app).get(`/market/${marketId}/randomness`).expect(200);
    expect(res.body.howToVerify).toMatch(/mirror node/);
    expect(res.body.howToVerify).toMatch(/top 53 bits/);
  });

  it('is empty and honest for a market that has not started', async () => {
    const marketId = await seedMarket();
    const res = await request(api.app).get(`/market/${marketId}/randomness`).expect(200);
    expect(res.body.draws).toEqual([]);
  });
});
