/**
 * Route tests, run entirely offline against a fake ledger.
 *
 * These cover what the endpoints do once payment has been settled. The payment
 * flow itself is exercised for real against testnet in STEP 17 — the gate is
 * injected precisely so these two concerns can be tested separately instead of
 * neither being tested until day six.
 *
 * The cases worth reading are the ones about leakage and sequencing: a bond
 * response must not reveal a position, and a report must not be accepted from
 * an agent whose turn it is not.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { beliefFromProbability, DEFAULT_PARAMS } from '@ethonline/core';
import { createApp, isUpstreamFailure, type Api } from '../src/app.js';
import { isPaidRoute, onlyPaidRoutes, withFacilitatorErrors } from '../src/payment.js';
import { depositTinybar, bondTinybar } from '../src/pricing.js';
import { agentPool, createFakeLedger, makeTestAgent, type FakeLedger, type TestAgent } from './helpers.js';

let ledger: FakeLedger;
let api: Api;

beforeEach(() => {
  ledger = createFakeLedger();
  // No payment gate: these tests are about what happens after payment.
  api = createApp({ ledger });
});

async function registerAgent(agent: TestAgent): Promise<void> {
  await request(api.app)
    .post('/agents/register')
    .send(agent.registration())
    .expect(201);
}

async function openMarket(body: Record<string, unknown> = {}): Promise<string> {
  const res = await request(api.app)
    .post('/market')
    .send({ question: 'Is this protocol growth organic?', ...body })
    .expect(201);
  return res.body.marketId as string;
}

/** Opens a market with a full bonded pool and closes bonding. */
async function runningMarket(): Promise<{ marketId: string; agents: TestAgent[] }> {
  const agents = agentPool(DEFAULT_PARAMS.minPoolSize);
  for (const a of agents) await registerAgent(a);
  const marketId = await openMarket();
  for (const a of agents) {
    await request(api.app).post(`/market/${marketId}/bond`).send({ agentId: a.agentId }).expect(201);
  }
  api.markets.get(marketId)!.market.closeBonding();
  return { marketId, agents };
}

describe('GET /health', () => {
  it('reports what the server is attached to', async () => {
    const res = await request(api.app).get('/health').expect(200);
    expect(res.body).toMatchObject({ ok: true, network: 'testnet', markets: 0, agents: 0 });
  });
});

describe('POST /agents/register — open to anyone', () => {
  it('registers an agent with no allowlist in the way', async () => {
    const agent = makeTestAgent('someone-elses-agent');
    const res = await request(api.app)
      .post('/agents/register')
      .send(agent.registration())
      .expect(201);
    expect(res.body.agent.agentId).toBe('someone-elses-agent');
    expect(res.body.agentCount).toBe(1);
  });

  it('keeps optional profile fields', async () => {
    const agent = makeTestAgent('agent-01');
    const res = await request(api.app)
      .post('/agents/register')
      .send(
        agent.registration({
          endpoint: 'http://localhost:5001/report',
          sliceIds: ['liquidity', 'holders'],
        }),
      )
      .expect(201);
    expect(res.body.agent.endpoint).toBe('http://localhost:5001/report');
    expect(res.body.agent.sliceIds).toEqual(['liquidity', 'holders']);
  });

  it('refuses to move an identity onto a different key', async () => {
    const agent = makeTestAgent('agent-01');
    await registerAgent(agent);
    const impostor = makeTestAgent('agent-01', 99);
    await request(api.app)
      .post('/agents/register')
      .send(impostor.registration({ agentId: 'agent-01' }))
      .expect(409);
  });

  it('refuses a registration that is not signed', async () => {
    const agent = makeTestAgent('unsigned');
    const { signature, ...unsigned } = agent.registration() as Record<string, unknown>;
    expect(signature).toBeTruthy();
    await request(api.app).post('/agents/register').send(unsigned).expect(400);
  });

  it('refuses a registration signed by somebody else', async () => {
    // Squatting an id, or worse: re-registering a live agent's endpoint to a
    // server you control. The victim then gets drawn, answers nothing and
    // loses its whole bond.
    const victim = makeTestAgent('agent-01');
    const attacker = makeTestAgent('attacker', 2);
    const body = { ...victim.registration(), signature: (attacker.registration() as { signature: string }).signature };
    await request(api.app).post('/agents/register').send(body).expect(401);
  });

  it('refuses a stale registration', async () => {
    const agent = makeTestAgent('stale');
    const claim = agent.registration() as Record<string, unknown>;
    // A captured signature must not stay a standing licence to move an
    // agent's endpoint around.
    await request(api.app)
      .post('/agents/register')
      .send({ ...claim, issuedAt: Date.now() - 60 * 60 * 1000 })
      .expect(401);
  });

  it('refuses a registration whose endpoint was swapped after signing', async () => {
    const agent = makeTestAgent('agent-07');
    const claim = agent.registration({ endpoint: 'http://good.example/report' });
    await request(api.app)
      .post('/agents/register')
      .send({ ...claim, endpoint: 'http://attacker.example/report' })
      .expect(401);
  });

  it('rejects an incomplete registration', async () => {
    await request(api.app).post('/agents/register').send({ agentId: 'x' }).expect(400);
    await request(api.app).post('/agents/register').send({}).expect(400);
  });
});

describe('POST /market', () => {
  it('creates a topic, writes market-open, and returns the deposit it charged', async () => {
    const res = await request(api.app)
      .post('/market')
      .send({ question: 'Is this protocol growth organic?' })
      .expect(201);

    expect(res.body.marketId).toMatch(/^mkt-\d{4}-\d{2}-\d{2}-001$/);
    expect(res.body.topicId).toMatch(/^0\.0\.\d+$/);
    expect(res.body.depositTinybar).toBe(depositTinybar(DEFAULT_PARAMS, [0.5, 0.5]).toString());
    expect(res.body.bondTinybar).toBe(bondTinybar(DEFAULT_PARAMS).toString());

    const written = ledger.topics.get(res.body.topicId)!;
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ type: 'market-open', question: 'Is this protocol growth organic?' });
  });

  it('records the parameters on the ledger so it is self-contained', async () => {
    const marketId = await openMarket();
    const topicId = api.markets.get(marketId)!.topicId;
    expect(ledger.topics.get(topicId)![0]).toMatchObject({
      params: { k: 3, T: 5, alpha: 0.125, epsilon: 0.01 },
    });
  });

  it('accepts custom parameters and prices them accordingly', async () => {
    const res = await request(api.app)
      .post('/market')
      .send({ question: 'q', params: { b: 2 } })
      .expect(201);
    expect(res.body.params.b).toBe(2);
    expect(BigInt(res.body.depositTinybar)).toBeGreaterThan(
      depositTinybar(DEFAULT_PARAMS, [0.5, 0.5]),
    );
  });

  it('rejects parameters that would break the mechanism', async () => {
    // k=0 makes the reference agent score itself.
    await request(api.app).post('/market').send({ question: 'q', params: { k: 0 } }).expect(400);
    await request(api.app).post('/market').send({ question: 'q', params: { alpha: 0 } }).expect(400);
    await request(api.app).post('/market').send({ question: 'q', params: { epsilon: 0 } }).expect(400);
  });

  it('rejects a market with no question', async () => {
    await request(api.app).post('/market').send({}).expect(400);
    await request(api.app).post('/market').send({ question: '   ' }).expect(400);
  });

  it('reports a chain failure instead of pretending the market exists', async () => {
    ledger.failNextCreate();
    await request(api.app).post('/market').send({ question: 'q' }).expect(502);
    expect(api.markets.size).toBe(0);
  });
});

describe('POST /market/:id/bond', () => {
  it('adds a registered agent to the pool', async () => {
    const agent = makeTestAgent('agent-01');
    await registerAgent(agent);
    const marketId = await openMarket();

    const res = await request(api.app)
      .post(`/market/${marketId}/bond`)
      .send({ agentId: 'agent-01' })
      .expect(201);
    expect(res.body.bondedCount).toBe(1);
    expect(res.body.minPoolSize).toBe(DEFAULT_PARAMS.minPoolSize);
  });

  it('NEVER tells an agent its position', async () => {
    // Publishing the order would let the last agent know it is the reference
    // before it reports, which is the leak the lazy draw exists to prevent
    // (PLAN section 6.4).
    const agent = makeTestAgent('agent-01');
    await registerAgent(agent);
    const marketId = await openMarket();
    const res = await request(api.app)
      .post(`/market/${marketId}/bond`)
      .send({ agentId: 'agent-01' })
      .expect(201);
    expect(res.body.position).toBeNull();
  });

  it('rejects an unregistered agent', async () => {
    const marketId = await openMarket();
    await request(api.app).post(`/market/${marketId}/bond`).send({ agentId: 'ghost' }).expect(404);
  });

  it('rejects a second bond from the same agent', async () => {
    // One agent, one entry — otherwise an agent could report early and then
    // be drawn as the reference and score its own earlier report.
    const agent = makeTestAgent('agent-01');
    await registerAgent(agent);
    const marketId = await openMarket();
    await request(api.app).post(`/market/${marketId}/bond`).send({ agentId: 'agent-01' }).expect(201);
    await request(api.app).post(`/market/${marketId}/bond`).send({ agentId: 'agent-01' }).expect(409);
  });

  it('rejects a bond once the market is running', async () => {
    const { marketId, agents } = await runningMarket();
    const latecomer = makeTestAgent('agent-late', 99);
    await registerAgent(latecomer);
    expect(agents).toHaveLength(DEFAULT_PARAMS.minPoolSize);
    await request(api.app)
      .post(`/market/${marketId}/bond`)
      .send({ agentId: 'agent-late' })
      .expect(409);
  });

  it('404s for a market that does not exist', async () => {
    await request(api.app).post('/market/nope/bond').send({ agentId: 'a' }).expect(404);
  });
});

describe('POST /market/:id/report', () => {
  it('accepts a signed report from the agent whose turn it is', async () => {
    const { marketId, agents } = await runningMarket();
    const stored = api.markets.get(marketId)!;
    const drawnId = stored.market.drawNextAgent()!;
    const agent = agents.find((a) => a.agentId === drawnId)!;

    const claim = { marketId, agentId: drawnId, position: 1, belief: beliefFromProbability(0.72) };
    const res = await request(api.app)
      .post(`/market/${marketId}/report`)
      .send({ agentId: drawnId, probability: 0.72, signature: agent.sign(claim) })
      .expect(201);

    expect(res.body.position).toBe(1);
    expect(res.body.belief[1]).toBeCloseTo(0.72, 6);
    expect(res.body.sequenceNumber).toBe(2); // market-open was first
    expect(ledger.topics.get(stored.topicId)![1]).toMatchObject({ type: 'report', agentId: drawnId });
  });

  it('records both the clipped and the raw belief', async () => {
    const { marketId, agents } = await runningMarket();
    const stored = api.markets.get(marketId)!;
    const drawnId = stored.market.drawNextAgent()!;
    const agent = agents.find((a) => a.agentId === drawnId)!;

    // 0.999 is well past what the bond allows the price to be moved to.
    const claim = { marketId, agentId: drawnId, position: 1, belief: beliefFromProbability(0.999) };
    const res = await request(api.app)
      .post(`/market/${marketId}/report`)
      .send({ agentId: drawnId, probability: 0.999, signature: agent.sign(claim) })
      .expect(201);

    expect(res.body.clipped).toBe(true);
    expect(res.body.rawBelief[1]).toBeCloseTo(0.999, 6);
    expect(res.body.belief[1]).toBeLessThan(0.999);
  });

  it('REJECTS a report from an agent whose turn it is not', async () => {
    const { marketId, agents } = await runningMarket();
    const stored = api.markets.get(marketId)!;
    const drawnId = stored.market.drawNextAgent()!;
    const other = agents.find((a) => a.agentId !== drawnId)!;

    const claim = { marketId, agentId: other.agentId, position: 1, belief: beliefFromProbability(0.6) };
    await request(api.app)
      .post(`/market/${marketId}/report`)
      .send({ agentId: other.agentId, probability: 0.6, signature: other.sign(claim) })
      .expect(409);
  });

  it('REJECTS an unsigned or wrongly signed report', async () => {
    const { marketId, agents } = await runningMarket();
    const stored = api.markets.get(marketId)!;
    const drawnId = stored.market.drawNextAgent()!;
    const impostor = agents.find((a) => a.agentId !== drawnId)!;

    // Right agent id, wrong key: this is the attack the signature exists for.
    const claim = { marketId, agentId: drawnId, position: 1, belief: beliefFromProbability(0.6) };
    await request(api.app)
      .post(`/market/${marketId}/report`)
      .send({ agentId: drawnId, probability: 0.6, signature: impostor.sign(claim) })
      .expect(401);

    await request(api.app)
      .post(`/market/${marketId}/report`)
      .send({ agentId: drawnId, probability: 0.6, signature: 'deadbeef' })
      .expect(401);
  });

  it('REJECTS a signature made for a different probability', async () => {
    const { marketId, agents } = await runningMarket();
    const stored = api.markets.get(marketId)!;
    const drawnId = stored.market.drawNextAgent()!;
    const agent = agents.find((a) => a.agentId === drawnId)!;

    const claim = { marketId, agentId: drawnId, position: 1, belief: beliefFromProbability(0.6) };
    await request(api.app)
      .post(`/market/${marketId}/report`)
      .send({ agentId: drawnId, probability: 0.9, signature: agent.sign(claim) })
      .expect(401);
  });

  it('rejects a report before the market is running', async () => {
    const agent = makeTestAgent('agent-01');
    await registerAgent(agent);
    const marketId = await openMarket();
    const claim = { marketId, agentId: 'agent-01', position: 1, belief: beliefFromProbability(0.6) };
    await request(api.app)
      .post(`/market/${marketId}/report`)
      .send({ agentId: 'agent-01', probability: 0.6, signature: agent.sign(claim) })
      .expect(409);
  });

  it('rejects a probability outside [0,1]', async () => {
    const { marketId } = await runningMarket();
    await request(api.app)
      .post(`/market/${marketId}/report`)
      .send({ agentId: 'agent-01', probability: 1.5, signature: 'ab' })
      .expect(400);
  });

  it('advances the randomness source with every report', async () => {
    const { marketId, agents } = await runningMarket();
    const stored = api.markets.get(marketId)!;
    const before = stored.rng.runningHash;

    const drawnId = stored.market.drawNextAgent()!;
    const agent = agents.find((a) => a.agentId === drawnId)!;
    const claim = { marketId, agentId: drawnId, position: 1, belief: beliefFromProbability(0.7) };
    await request(api.app)
      .post(`/market/${marketId}/report`)
      .send({ agentId: drawnId, probability: 0.7, signature: agent.sign(claim) })
      .expect(201);

    // The next stopping roll has to come from the hash of the report that was
    // just written, not from the one before it.
    expect(stored.rng.runningHash).not.toEqual(before);
  });
});

describe('public reads', () => {
  it('exposes market state without leaking the draw order', async () => {
    const { marketId } = await runningMarket();
    api.markets.get(marketId)!.market.drawNextAgent();

    const res = await request(api.app).get(`/market/${marketId}`).expect(200);
    expect(res.body).toMatchObject({ marketId, status: 'running', bondedCount: 20 });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('pendingAgentId');
    expect(body).not.toContain('drawnAgents');
  });

  it('lists markets newest first', async () => {
    await openMarket({ question: 'first' });
    await openMarket({ question: 'second' });
    const res = await request(api.app).get('/markets').expect(200);
    expect(res.body.count).toBe(2);
    expect(res.body.markets[0].question).toBe('second');
  });

  it('serves the report history with the topic to check it against', async () => {
    const { marketId, agents } = await runningMarket();
    const stored = api.markets.get(marketId)!;
    const drawnId = stored.market.drawNextAgent()!;
    const agent = agents.find((a) => a.agentId === drawnId)!;
    const claim = { marketId, agentId: drawnId, position: 1, belief: beliefFromProbability(0.66) };
    await request(api.app)
      .post(`/market/${marketId}/report`)
      .send({ agentId: drawnId, probability: 0.66, signature: agent.sign(claim) })
      .expect(201);

    const res = await request(api.app).get(`/market/${marketId}/reports`).expect(200);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0]).toMatchObject({ position: 1, agentId: drawnId });
    expect(res.body.topicId).toBe(stored.topicId);
  });

  it('404s for markets that do not exist', async () => {
    await request(api.app).get('/market/nope').expect(404);
    await request(api.app).get('/market/nope/reports').expect(404);
  });
});

describe('when the payment infrastructure is down', () => {
  it('answers 503, not a bare 500', async () => {
    // STEP 17 hit this for real: with the facilitator unreachable the payment
    // middleware throws and Express answers `500 Internal Server Error`, which
    // a caller cannot distinguish from "your request was malformed". One means
    // fix the request, the other means wait — a client that cannot tell them
    // apart retries the wrong one.
    const brokenGate = withFacilitatorErrors(() => {
      throw new Error('fetch failed');
    }, 'https://facilitator.example');

    const down = createApp({ ledger, paymentGate: brokenGate });
    const res = await request(down.app).post('/market').send({ question: 'q' }).expect(503);
    expect(res.body.error).toMatch(/Payment infrastructure/);
    expect(res.body.detail).toMatch(/not a problem with your request/);
  });

  it('catches an async rejection too, which is the real middleware shape', async () => {
    const brokenGate = withFacilitatorErrors(async () => {
      throw new Error('fetch failed');
    }, 'https://facilitator.example');
    const down = createApp({ ledger, paymentGate: brokenGate });
    await request(down.app).post('/market').send({ question: 'q' }).expect(503);
  });

  it('leaves reads working, so the ledger stays verifiable during an outage', async () => {
    // A market already written to HCS can still be checked by anyone. There is
    // no reason an outage in the payment rail should stop that: nobody can
    // open a NEW market, which is right, and the record stays readable.
    const brokenGate = onlyPaidRoutes(
      withFacilitatorErrors(async () => {
        throw new Error('fetch failed');
      }, 'https://facilitator.example'),
    );
    const down = createApp({ ledger, paymentGate: brokenGate });

    await request(down.app).get('/health').expect(200);
    await request(down.app).get('/markets').expect(200);
    await request(down.app)
      .post('/agents/register')
      .send(makeTestAgent('a').registration())
      .expect(201);
    // ...while the paid route correctly refuses.
    await request(down.app).post('/market').send({ question: 'q' }).expect(503);
  });

  it('knows which routes cost money', async () => {
    expect(isPaidRoute('POST', '/market')).toBe(true);
    expect(isPaidRoute('POST', '/market/mkt-1/bond')).toBe(true);
    expect(isPaidRoute('POST', '/resolve')).toBe(true);

    expect(isPaidRoute('GET', '/market/mkt-1')).toBe(false);
    expect(isPaidRoute('GET', '/market/mkt-1/reports')).toBe(false);
    expect(isPaidRoute('POST', '/market/mkt-1/report')).toBe(false);
    expect(isPaidRoute('POST', '/agents/register')).toBe(false);
    expect(isPaidRoute('GET', '/health')).toBe(false);
  });
});

describe('errors reach the caller as something actionable', () => {
  it('turns a next(err) from the gate into 503, not a bare 500', async () => {
    // The gap the wrapper did not cover. Middleware can fail two ways: by
    // throwing, which `withFacilitatorErrors` catches, or by calling
    // `next(err)` — and that path runs straight past it into Express's default
    // handler. STEP 17 hit exactly this and got a bodyless 500.
    const gate: import('express').RequestHandler = (_req, _res, next) => {
      next(new Error('fetch failed'));
    };
    const down = createApp({ ledger, paymentGate: gate });
    const res = await request(down.app).post('/market').send({ question: 'q' }).expect(503);
    expect(res.body.error).toMatch(/Upstream temporarily unavailable/);
    expect(res.body.cause).toMatch(/fetch failed/);
  });

  it('still says 500 for a genuine bug, with the reason attached', async () => {
    const gate: import('express').RequestHandler = () => {
      throw new TypeError('x.y is not a function');
    };
    const down = createApp({ ledger, paymentGate: gate });
    const res = await request(down.app).post('/market').send({ question: 'q' }).expect(500);
    expect(res.body.detail).toMatch(/not a function/);
  });

  it('classifies upstream failures apart from programming errors', async () => {
    expect(isUpstreamFailure(new Error('fetch failed'))).toBe(true);
    expect(isUpstreamFailure(new Error('UND_ERR_CONNECT_TIMEOUT'))).toBe(true);
    expect(isUpstreamFailure(new Error('no supported payment kinds loaded'))).toBe(true);
    expect(isUpstreamFailure(new TypeError('undefined is not an object'))).toBe(false);
  });
});
