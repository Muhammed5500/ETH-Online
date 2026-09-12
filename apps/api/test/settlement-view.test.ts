/**
 * The settlement endpoint.
 *
 * THE TWO THINGS WORTH TESTING HERE are the claims the settlement screen makes
 * on the mechanism's behalf, because both are checkable and both would be
 * embarrassing to state wrongly in front of a judge:
 *
 *   The budget bound holds. The paper's §6.2 telescoping argument caps the
 *   asker's whole CE-MSR subsidy at `b·H(r, q⁰)`, however long the market runs
 *   and however far the price swings. The endpoint publishes the cap and the
 *   spend side by side; if the spend ever exceeds the cap, the mechanism is
 *   broken and the screen must not say otherwise.
 *
 *   The accounting closes. `deposit + Σ bonds` equals `Σ transfers + slashed`,
 *   in integers, with no dust unaccounted for. `core` asserts this before a
 *   plan is built; this publishes the arithmetic so a reader can add it up
 *   rather than trust a tick.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { DEFAULT_PARAMS } from '@ethonline/core';
import { createApp, type Api } from '../src/app.js';
import { Orchestrator, type AgentTransport, type Payer } from '../src/orchestrator.js';
import { agentPool, createFakeLedger, type FakeLedger, type TestAgent } from './helpers.js';

let ledger: FakeLedger;
let api: Api;
let agents: TestAgent[];

/** Reports swing hard from one side to the other, to stress the bound. */
function swingingTransport(): AgentTransport {
  return {
    async requestReport(agent, req) {
      const testAgent = agents.find((a) => a.agentId === agent.agentId)!;
      const probability = req.position % 2 === 0 ? 0.82 : 0.19;
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

const payer: Payer = {
  async send(_lines, memo) {
    return { transactionId: `0.0.7@${memo.length}.000000001`, status: 'SUCCESS' };
  },
};

function orchestrator(transport: AgentTransport): Orchestrator {
  return new Orchestrator({
    markets: api.markets,
    registry: api.registry,
    ledger,
    transport,
    payer,
    hbarPerUnit: 1,
    reportTimeoutMs: 50,
    maxCreditsPerTransaction: 9,
  });
}

async function seedMarket(): Promise<string> {
  agents = agentPool(DEFAULT_PARAMS.minPoolSize);
  for (const a of agents) {
    await request(api.app)
      .post('/agents/register')
      .send(a.registration({ endpoint: `http://localhost:9/${a.agentId}` }))
      .expect(201);
  }
  const res = await request(api.app).post('/market').send({ question: 'q?' }).expect(201);
  const marketId = res.body.marketId as string;
  for (const a of agents) {
    await request(api.app).post(`/market/${marketId}/bond`).send({ agentId: a.agentId }).expect(201);
  }
  return marketId;
}

async function settledMarket(transport = swingingTransport()): Promise<string> {
  const marketId = await seedMarket();
  const orch = orchestrator(transport);
  await orch.runMarket(marketId);
  await orch.settle(marketId, '0.0.999');
  return marketId;
}

beforeEach(() => {
  ledger = createFakeLedger();
  api = createApp({ ledger });
});

describe('before a market has settled', () => {
  it('404s for a market that does not exist', async () => {
    await request(api.app).get('/market/nope/settlement').expect(404);
  });

  it('answers 200 and says so, rather than 404ing a page that is polling', async () => {
    const marketId = await seedMarket();
    const res = await request(api.app).get(`/market/${marketId}/settlement`).expect(200);
    expect(res.body.status).toBe('not-settled');
    expect(res.body.marketStatus).toBe('bonding');
    expect(res.body.payouts).toBeUndefined();
  });
});

describe('the budget bound', () => {
  it('publishes the cap and the spend, and the spend is under it', async () => {
    const marketId = await settledMarket();
    const res = await request(api.app).get(`/market/${marketId}/settlement`).expect(200);
    const bound = res.body.bound;

    expect(bound.withinBound).toBe(true);
    expect(bound.actualScoringUnits).toBeLessThanOrEqual(bound.maxScoringUnits + 1e-9);
  });

  it('holds even when every agent swings the price to the other extreme', async () => {
    // The whole point of telescoping: the intermediate terms cancel, so a
    // violent market costs the asker no more than a calm one.
    const marketId = await settledMarket();
    const res = await request(api.app).get(`/market/${marketId}/settlement`).expect(200);
    expect(res.body.bound.withinBound).toBe(true);
  });

  it('reports a deposit that covers the cap plus the flat fees', async () => {
    const marketId = await settledMarket();
    const bound = (await request(api.app).get(`/market/${marketId}/settlement`).expect(200)).body
      .bound;
    // requiredDeposit uses the referenceless worst case, which is at least as
    // large as the referenced bound, so this must never be tight the wrong way.
    expect(bound.requiredDepositUnits).toBeGreaterThanOrEqual(
      bound.actualScoringUnits + bound.flatFeeUnits - 1e-9,
    );
  });
});

describe('the accounting identity', () => {
  it('closes in integers, with the asker taking the dust', async () => {
    const marketId = await settledMarket();
    const a = (await request(api.app).get(`/market/${marketId}/settlement`).expect(200)).body
      .accounting;

    expect(a.balances).toBe(true);
    expect(BigInt(a.inTinybar)).toBe(BigInt(a.outTinybar));
    expect(BigInt(a.paidToAgentsTinybar) + BigInt(a.askerRefundTinybar) + BigInt(a.slashedTinybar)).toBe(
      BigInt(a.outTinybar),
    );
  });

  it('sends every tinybar somewhere', async () => {
    // No rounding remainder may go missing. `core` floors agents and gives the
    // exact remainder to the asker precisely so this holds.
    const marketId = await settledMarket();
    const body = (await request(api.app).get(`/market/${marketId}/settlement`).expect(200)).body;

    const transferred = (body.transfers as Array<{ amountTinybar: string }>).reduce(
      (sum, t) => sum + BigInt(t.amountTinybar),
      0n,
    );
    expect(transferred + BigInt(body.accounting.slashedTinybar)).toBe(
      BigInt(body.accounting.inTinybar),
    );
  });
});

describe('the payout table', () => {
  it('gives every report a row, and exactly k of them a flat fee', async () => {
    const marketId = await settledMarket();
    const body = (await request(api.app).get(`/market/${marketId}/settlement`).expect(200)).body;
    const reports = (await request(api.app).get(`/market/${marketId}/reports`).expect(200)).body
      .reports;

    expect(body.payouts).toHaveLength(reports.length);
    const flat = (body.payouts as Array<{ kind: string }>).filter((p) => p.kind === 'flat-fee');
    expect(flat).toHaveLength(Math.min(DEFAULT_PARAMS.k, reports.length));
  });

  it('carries the raw score for a scored agent and none for a flat fee', async () => {
    // The raw CE-MSR value is what an auditor recomputes; the amount is that
    // times b. A flat fee has no score behind it and must not pretend to.
    const marketId = await settledMarket();
    const payouts = (await request(api.app).get(`/market/${marketId}/settlement`).expect(200)).body
      .payouts as Array<{ kind: string; scoreRaw?: number; amount: number }>;

    for (const p of payouts) {
      if (p.kind === 'scored') expect(typeof p.scoreRaw).toBe('number');
      else expect(p.scoreRaw).toBeUndefined();
    }
  });

  it('puts the flat fees at the END of the market, not at the start', async () => {
    // The last k agents take the flat fee because there is not enough
    // information behind them to score against. Which agents those are is
    // decided by where the dice landed, not in advance.
    const marketId = await settledMarket();
    const payouts = (await request(api.app).get(`/market/${marketId}/settlement`).expect(200)).body
      .payouts as Array<{ kind: string; position: number }>;

    const flatPositions = payouts.filter((p) => p.kind === 'flat-fee').map((p) => p.position);
    const scoredPositions = payouts.filter((p) => p.kind === 'scored').map((p) => p.position);
    if (flatPositions.length > 0 && scoredPositions.length > 0) {
      expect(Math.min(...flatPositions)).toBeGreaterThan(Math.max(...scoredPositions));
    }
  });
});

describe('the transfer table', () => {
  it('ties each line to the transaction that carried it', async () => {
    const marketId = await settledMarket();
    const transfers = (await request(api.app).get(`/market/${marketId}/settlement`).expect(200))
      .body.transfers as Array<{ chunkState?: string; transactionId?: string }>;

    expect(transfers.length).toBeGreaterThan(0);
    for (const t of transfers) {
      expect(t.chunkState).toBe('sent');
      expect(typeof t.transactionId).toBe('string');
    }
  });

  it('has exactly one asker line, and it is last', async () => {
    const marketId = await settledMarket();
    const transfers = (await request(api.app).get(`/market/${marketId}/settlement`).expect(200))
      .body.transfers as Array<{ beneficiary: string }>;

    const askers = transfers.filter((t) => t.beneficiary === 'asker');
    expect(askers).toHaveLength(1);
    expect(transfers[transfers.length - 1]!.beneficiary).toBe('asker');
  });

  it('reports amounts as strings, because they are uint64', async () => {
    const marketId = await settledMarket();
    const transfers = (await request(api.app).get(`/market/${marketId}/settlement`).expect(200))
      .body.transfers as Array<{ amountTinybar: unknown }>;
    expect(typeof transfers[0]!.amountTinybar).toBe('string');
  });
});

describe('a settlement that stopped partway', () => {
  it('says it is blocked and which chunks are unaccounted for', async () => {
    const marketId = await seedMarket();
    let sends = 0;
    const flaky: Payer = {
      async send() {
        sends++;
        if (sends === 2) throw new Error('network went away mid-transfer');
        return { transactionId: `0.0.7@${sends}`, status: 'SUCCESS' };
      },
    };
    const orch = new Orchestrator({
      markets: api.markets,
      registry: api.registry,
      ledger,
      transport: swingingTransport(),
      payer: flaky,
      hbarPerUnit: 1,
      reportTimeoutMs: 50,
      maxCreditsPerTransaction: 3,
    });
    await orch.runMarket(marketId);
    await orch.settle(marketId, '0.0.999').catch(() => undefined);

    const body = (await request(api.app).get(`/market/${marketId}/settlement`).expect(200)).body;
    expect(body.status).toBe('blocked');
    expect(body.progress.unknown).toBe(1);
    expect(body.progress.sent).toBe(1);

    // The screen can still show what was supposed to happen — the plan exists
    // and is on the record even though the money is only partly moved.
    expect(body.payouts.length).toBeGreaterThan(0);
    expect(body.accounting.balances).toBe(true);
  });
});
