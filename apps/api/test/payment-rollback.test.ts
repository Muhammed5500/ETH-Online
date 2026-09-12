/**
 * What happens when a handler succeeds and the payment behind it does not.
 *
 * WHY THIS FILE EXISTS. `@x402/express` runs the handler BEFORE it settles,
 * and on a settlement failure it discards the handler's response and answers
 * 402 — leaving whatever the handler wrote behind. On 2026-09-12 a live run
 * recorded twenty bonds against eighteen payments; two agents were in the pool
 * for nothing and settlement paid their bonds back. The treasury closed 2 HBAR
 * short.
 *
 * The gate below is a stand-in for that library behaviour, not for the
 * library: it swallows the handler's response exactly the way the middleware
 * buffers it, then answers 402 the way a failed settlement does. That is the
 * shape the rollback has to survive, and reproducing it here means the fix is
 * tested without a facilitator, a key or a network.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import type { RequestHandler, Response } from 'express';
import { createApp, type Api } from '../src/app.js';
import { onlyPaidRoutes } from '../src/payment.js';
import { withPaymentRollback, type RollbackReport } from '../src/payment-rollback.js';
import { agentPool, createFakeLedger, type FakeLedger, type TestAgent } from './helpers.js';

/**
 * A gate that lets the handler run and then fails the settlement.
 *
 * The handler's `res.json` is swallowed while it runs, so nothing it wrote
 * reaches the client, and the 402 goes out only once the handler has finished
 * — which is what makes the mutation land before the failure, the ordering
 * that caused the loss.
 */
function settlementFails(): RequestHandler {
  return (_req, res, next) => {
    const realStatus = res.status.bind(res);
    const realJson = res.json.bind(res);
    let handlerDone: () => void;
    const done = new Promise<void>((resolve) => {
      handlerDone = resolve;
    });

    const swallowing = res as Response & { status: unknown; json: unknown };
    swallowing.status = () => res;
    swallowing.json = () => {
      handlerDone();
      return res;
    };

    void done.then(() => {
      swallowing.status = realStatus;
      swallowing.json = realJson;
      realStatus(402).json({ error: 'settlement failed' });
    });

    next();
  };
}

/** A gate that settles fine: the handler's own response is delivered. */
const settlementWorks: RequestHandler = (_req, _res, next) => next();

let ledger: FakeLedger;
let rollbacks: RollbackReport[];

function buildApi(gate: RequestHandler): Api {
  rollbacks = [];
  return createApp({
    ledger,
    paymentGate: onlyPaidRoutes(
      withPaymentRollback(gate, { onRollback: (r) => rollbacks.push(r) }),
    ),
  });
}

async function registerAgent(api: Api, agent: TestAgent): Promise<void> {
  await request(api.app)
    .post('/agents/register')
    .send({ agentId: agent.agentId, accountId: agent.accountId, publicKey: agent.publicKey })
    .expect(201);
}

beforeEach(() => {
  ledger = createFakeLedger();
});

describe('a market whose deposit never settles', () => {
  it('is not left in the store', async () => {
    const api = buildApi(settlementFails());

    await request(api.app)
      .post('/market')
      .send({ question: 'Is this protocol growth organic?' })
      .expect(402);

    expect(api.markets.size).toBe(0);
    expect(rollbacks).toHaveLength(1);
    expect(rollbacks[0]?.ok).toBe(true);
  });

  it('does not hand its id to the next market', async () => {
    const api = buildApi(settlementFails());
    await request(api.app).post('/market').send({ question: 'A question about growth' }).expect(402);

    // Same store, a gate that settles this time.
    const paid = createApp({
      ledger,
      markets: api.markets,
      registry: api.registry,
      paymentGate: onlyPaidRoutes(withPaymentRollback(settlementWorks)),
    });
    const res = await request(paid.app)
      .post('/market')
      .send({ question: 'Another question about growth' })
      .expect(201);

    // -001 belonged to the market that was never paid for. Reusing it would
    // put two HCS topics under one id.
    expect(res.body.marketId.endsWith('-002')).toBe(true);
    expect(paid.markets.size).toBe(1);
  });

  it('survives in the store when the settlement works', async () => {
    const api = buildApi(settlementWorks);
    await request(api.app).post('/market').send({ question: 'Is this growth organic?' }).expect(201);

    expect(api.markets.size).toBe(1);
    expect(rollbacks).toHaveLength(0);
  });
});

describe('a bond whose payment never settles', () => {
  let api: Api;
  let marketId: string;
  let agents: TestAgent[];

  beforeEach(async () => {
    // The market itself is opened through a gate that works, so the only
    // unsettled payment in the test is the bond.
    const paid = createApp({
      ledger,
      paymentGate: onlyPaidRoutes(withPaymentRollback(settlementWorks)),
    });
    const res = await request(paid.app)
      .post('/market')
      .send({ question: 'Is this protocol growth organic?' })
      .expect(201);
    marketId = res.body.marketId;

    api = buildApi(settlementFails());
    // Same stores, so the market opened above is the one being bonded into.
    api = createApp({
      ledger,
      markets: paid.markets,
      registry: paid.registry,
      paymentGate: onlyPaidRoutes(
        withPaymentRollback(settlementFails(), { onRollback: (r) => rollbacks.push(r) }),
      ),
    });
    rollbacks = [];

    agents = agentPool(2);
    for (const a of agents) await registerAgent(api, a);
  });

  it('leaves the agent out of the pool', async () => {
    await request(api.app)
      .post(`/market/${marketId}/bond`)
      .send({ agentId: agents[0]!.agentId })
      .expect(402);

    const stored = api.markets.get(marketId)!;
    expect(stored.bonds.size).toBe(0);
    expect(stored.market.getState().bondedAgents).toEqual([]);
    expect(rollbacks[0]?.ok).toBe(true);
  });

  it('lets the same agent bond again once its payment does settle', async () => {
    await request(api.app)
      .post(`/market/${marketId}/bond`)
      .send({ agentId: agents[0]!.agentId })
      .expect(402);

    // A rolled-back bond must not leave "already bonded" behind, or a retry
    // after a transient facilitator failure could never succeed.
    const retry = createApp({
      ledger,
      markets: api.markets,
      registry: api.registry,
      paymentGate: onlyPaidRoutes(withPaymentRollback(settlementWorks)),
    });
    await request(retry.app)
      .post(`/market/${marketId}/bond`)
      .send({ agentId: agents[0]!.agentId })
      .expect(201);

    const stored = retry.markets.get(marketId)!;
    expect(stored.bonds.size).toBe(1);
    expect(stored.market.getState().bondedAgents).toEqual([agents[0]!.agentId]);
  });

  it('keeps the bonds of agents whose payments did settle', async () => {
    const paid = createApp({
      ledger,
      markets: api.markets,
      registry: api.registry,
      paymentGate: onlyPaidRoutes(withPaymentRollback(settlementWorks)),
    });
    await request(paid.app)
      .post(`/market/${marketId}/bond`)
      .send({ agentId: agents[0]!.agentId })
      .expect(201);

    await request(api.app)
      .post(`/market/${marketId}/bond`)
      .send({ agentId: agents[1]!.agentId })
      .expect(402);

    const stored = api.markets.get(marketId)!;
    expect([...stored.bonds.keys()]).toEqual([agents[0]!.agentId]);
    expect(stored.market.getState().bondedAgents).toEqual([agents[0]!.agentId]);
  });
});

describe('the moment the undo happens', () => {
  it('runs before the 402 is written, not after', async () => {
    // The race this closes: a client that retries the instant it reads the
    // 402 must not find the old bond still there and be answered 409, which
    // it would read as "already paid".
    const order: string[] = [];
    const api = createApp({
      ledger,
      paymentGate: onlyPaidRoutes(
        withPaymentRollback((_req, res, next) => {
          res.on('finish', () => order.push('response-sent'));
          const realStatus = res.status.bind(res);
          const realJson = res.json.bind(res);
          let handlerDone: () => void;
          const done = new Promise<void>((resolve) => {
            handlerDone = resolve;
          });
          const swallowing = res as Response & { status: unknown; json: unknown };
          swallowing.status = () => res;
          swallowing.json = () => {
            handlerDone();
            return res;
          };
          void done.then(() => {
            swallowing.status = realStatus;
            swallowing.json = realJson;
            realStatus(402).json({ error: 'settlement failed' });
          });
          next();
        }, { onRollback: () => order.push('rolled-back') }),
      ),
    });

    await request(api.app).post('/market').send({ question: 'Is this growth organic?' }).expect(402);

    expect(order).toEqual(['rolled-back', 'response-sent']);
  });
});

describe('an unpaid request', () => {
  it('rolls nothing back, because the handler never ran', async () => {
    // 402 with no handler behind it: the gate refuses before `next`.
    const api = createApp({
      ledger,
      paymentGate: onlyPaidRoutes(
        withPaymentRollback((_req, res) => void res.status(402).json({ error: 'payment required' }), {
          onRollback: (r) => rollbacks.push(r),
        }),
      ),
    });
    rollbacks = [];

    await request(api.app).post('/market').send({ question: 'Is this growth organic?' }).expect(402);

    expect(api.markets.size).toBe(0);
    expect(rollbacks).toHaveLength(0);
  });
});
