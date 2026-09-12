/**
 * Tests for the resolution service — STEP 22.
 *
 * THE CASE THAT MATTERS MOST is the one about a second market. Two markets
 * open on the same question split the agent pool and produce two prices, each
 * built from half the information. That is the parallel-markets design the
 * paper rejects (§6, and PLAN section 6.7), and the way it would sneak into
 * this system is not as a design decision — it is two buyers asking the same
 * question a second apart.
 *
 * The rest pins the honesty of the contract: an unanswered question is never
 * answered with a guess, and every answer carries the topic it can be checked
 * against.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import {
  Market,
  type Belief,
  type MarketParams,
  type RandomSource,
} from '@ethonline/core';
import { createApp, type Api } from '../src/app.js';
import { buildResolveAnswer, findAnsweredMarket, findPendingMarket, questionKey } from '../src/resolve.js';
import { bondTinybar, depositTinybar } from '../src/pricing.js';
import { createFakeLedger, type FakeLedger } from './helpers.js';

/** Small enough that three reports exhaust the pool and close the market. */
const SMALL: MarketParams = {
  k: 1,
  T: 2,
  alpha: 1 / 3,
  epsilon: 0.01,
  b: 1,
  R: 0.1,
  minPoolSize: 3,
  bondAmount: 1,
};

const PRIOR: Belief = [0.5, 0.5];

/** Never stops on the dice, so the market closes by running out of agents. */
const neverStops: RandomSource = { next: () => 0.99 };

let ledger: FakeLedger;
let api: Api;

beforeEach(() => {
  ledger = createFakeLedger();
  api = createApp({ ledger });
});

/**
 * Drops a fully closed market into the store.
 *
 * Built through the real `Market` state machine rather than hand-assembled:
 * the reference report has to be the terminal one, and only the state machine
 * decides that.
 */
function seedClosedMarket(question: string, beliefs: readonly number[]): string {
  const id = `mkt-test-${api.markets.size + 1}`;
  const market = Market.create({ id, question, params: SMALL, prior: PRIOR }, neverStops);

  for (let i = 0; i < beliefs.length; i++) market.addBondedAgent(`agent-${i + 1}`);
  market.closeBonding();

  const annotations = new Map<number, import('../src/store.js').ReportAnnotation>();
  for (const p of beliefs) {
    const drawn = market.drawNextAgent();
    if (!drawn) break;
    const report = market.submitReport(drawn, [1 - p, p]);
    annotations.set(report.position, {
      position: report.position,
      agentId: drawn,
      sliceIds: ['liquidity'],
      evidenceCostUsd: 0.01,
      reasoning: `${drawn} looked at pool depth.`,
    });
    if (market.status !== 'running') break;
    market.rollStoppingDice();
  }

  api.markets.add({
    id,
    question,
    topicId: '0.0.7777',
    params: SMALL,
    prior: PRIOR,
    market,
    rng: { update: () => {}, next: () => 0.5 } as never,
    depositTinybar: depositTinybar(SMALL, PRIOR),
    bondTinybar: bondTinybar(SMALL),
    createdAt: Date.now(),
    bondingClosesAt: Date.now() + 1000,
    minBondingClosesAt: 0,
    bonds: new Map(),
    annotations,
  });
  return id;
}

describe('questionKey', () => {
  it('ignores case, padding and trailing punctuation', () => {
    expect(questionKey('  Is Curve TVL growth organic?  ')).toBe('is curve tvl growth organic');
    expect(questionKey('IS CURVE TVL GROWTH ORGANIC')).toBe('is curve tvl growth organic');
  });

  it('collapses runs of whitespace, so a line break is not a new question', () => {
    expect(questionKey('is curve\n  tvl   organic')).toBe('is curve tvl organic');
  });

  it('does NOT try to match meaning', () => {
    // Stemming or synonyms here would sell an answer to a question nobody
    // asked, and the buyer has no way to notice.
    expect(questionKey('is curve growth organic')).not.toBe(questionKey('is curve growth real'));
  });
});

describe('finding an existing market', () => {
  it('finds a closed market that produced a reference', () => {
    seedClosedMarket('Is Curve TVL growth organic?', [0.6, 0.7, 0.65]);
    const found = findAnsweredMarket(api.markets, '  is curve tvl growth ORGANIC ');
    expect(found).toBeDefined();
    expect(found!.market.getState().status).toBe('closed');
  });

  it('does not offer a market that answered nothing', () => {
    // Everyone timed out: closed, but with no terminal report there is no
    // price to sell.
    const market = Market.create(
      { id: 'mkt-empty', question: 'Q that nobody answered', params: SMALL, prior: PRIOR },
      neverStops,
    );
    for (let i = 0; i < 3; i++) market.addBondedAgent(`a-${i}`);
    market.closeBonding();
    for (let i = 0; i < 3; i++) {
      const drawn = market.drawNextAgent();
      if (drawn) market.handleTimeout(drawn);
    }
    api.markets.add({
      id: 'mkt-empty',
      question: 'Q that nobody answered',
      topicId: '0.0.1',
      params: SMALL,
      prior: PRIOR,
      market,
      rng: { update: () => {}, next: () => 0.5 } as never,
      depositTinybar: 1n,
      bondTinybar: 1n,
      createdAt: Date.now(),
      bondingClosesAt: Date.now(),
      minBondingClosesAt: 0,
      bonds: new Map(),
      annotations: new Map(),
    });
    expect(findAnsweredMarket(api.markets, 'Q that nobody answered')).toBeUndefined();
  });

  it('finds a market still in bonding, so a second one is never opened', () => {
    const market = Market.create(
      { id: 'mkt-bonding', question: 'Still bonding question', params: SMALL, prior: PRIOR },
      neverStops,
    );
    api.markets.add({
      id: 'mkt-bonding',
      question: 'Still bonding question',
      topicId: '0.0.2',
      params: SMALL,
      prior: PRIOR,
      market,
      rng: { update: () => {}, next: () => 0.5 } as never,
      depositTinybar: 1n,
      bondTinybar: 1n,
      createdAt: Date.now(),
      bondingClosesAt: Date.now() + 1000,
      minBondingClosesAt: 0,
      bonds: new Map(),
      annotations: new Map(),
    });
    expect(findPendingMarket(api.markets, 'still bonding QUESTION')?.id).toBe('mkt-bonding');
  });
});

describe('the answer that is sold', () => {
  it('is the TERMINAL report, not an average and not the last agent to be right', () => {
    const id = seedClosedMarket('Is Curve TVL growth organic?', [0.6, 0.7, 0.65]);
    const stored = api.markets.get(id)!;
    const answer = buildResolveAnswer(stored, { network: 'testnet' });
    const reports = stored.market.getState().reports;
    expect(answer.probability).toBe(reports[reports.length - 1]!.belief[1]);
  });

  it('marks which report was the reference, because that is what everyone was scored against', () => {
    const id = seedClosedMarket('Is Curve TVL growth organic?', [0.6, 0.7, 0.65]);
    const answer = buildResolveAnswer(api.markets.get(id)!, { network: 'testnet' });
    const flagged = answer.agentBreakdown.filter((a) => a.isReference);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.position).toBe(answer.reportCount);
  });

  it('carries the topic and a mirror URL, so the buyer never has to trust us', () => {
    const id = seedClosedMarket('Is Curve TVL growth organic?', [0.6, 0.7, 0.65]);
    const answer = buildResolveAnswer(api.markets.get(id)!, { network: 'testnet' });
    expect(answer.verify.hcsTopicId).toBe('0.0.7777');
    expect(answer.verify.mirrorUrl).toMatch(/testnet.*topics\/0\.0\.7777\/messages/);
  });

  it('totals what the agents spent on evidence', () => {
    const id = seedClosedMarket('Is Curve TVL growth organic?', [0.6, 0.7, 0.65]);
    const answer = buildResolveAnswer(api.markets.get(id)!, { network: 'testnet' });
    expect(answer.evidenceCostUsd).toBeCloseTo(0.01 * answer.reportCount, 9);
  });

  it('refuses to build an answer from a market with no reference', () => {
    const market = Market.create(
      { id: 'x', question: 'q', params: SMALL, prior: PRIOR },
      neverStops,
    );
    expect(() =>
      buildResolveAnswer(
        {
          id: 'x',
          question: 'q',
          topicId: '0.0.3',
          params: SMALL,
          prior: PRIOR,
          market,
          rng: { update: () => {}, next: () => 0.5 } as never,
          depositTinybar: 1n,
          bondTinybar: 1n,
          createdAt: 0,
          bondingClosesAt: 0,
          minBondingClosesAt: 0,
          bonds: new Map(),
          annotations: new Map(),
        },
        { network: 'testnet' },
      ),
    ).toThrow(/no reference report/);
  });
});

describe('POST /resolve', () => {
  it('is no longer a 501', async () => {
    const res = await request(api.app).post('/resolve').send({ question: 'Is Curve growth organic?' });
    expect(res.status).not.toBe(501);
  });

  it('400s a question too short to price', async () => {
    await request(api.app).post('/resolve').send({}).expect(400);
    await request(api.app).post('/resolve').send({ question: 'why?' }).expect(400);
  });

  it('answers immediately when a market already closed on that question', async () => {
    seedClosedMarket('Is Curve TVL growth organic?', [0.6, 0.7, 0.65]);
    const res = await request(api.app)
      .post('/resolve')
      .send({ question: 'is curve tvl growth organic' })
      .expect(200);

    expect(res.body.status).toBe('answered');
    expect(res.body.probability).toBe(0.65);
    expect(res.body.agentBreakdown).toHaveLength(3);
    expect(res.body.verify.hcsTopicId).toBe('0.0.7777');
  });

  it('opens a market and says so, rather than selling a guess', async () => {
    const res = await request(api.app)
      .post('/resolve')
      .send({ question: 'Is Protocol Z liquidity structure a rug risk?' })
      .expect(202);

    expect(res.body.status).toBe('opened');
    expect(res.body.marketId).toBeTruthy();
    expect(res.body.marketStatus).toBe('bonding');
    expect(res.body.watch).toBe(`/market/${res.body.marketId}`);
  });

  it('NEVER opens a second market for a question already in flight', async () => {
    // Two markets on one question split the agents and give two prices, each
    // from half the information — the design the paper rules out.
    const question = 'Does this address cluster belong to one actor?';
    const first = await request(api.app).post('/resolve').send({ question }).expect(202);
    const second = await request(api.app)
      .post('/resolve')
      .send({ question: `  ${question.toUpperCase()}  ` })
      .expect(202);

    expect(second.body.status).toBe('pending');
    expect(second.body.marketId).toBe(first.body.marketId);
    expect(api.markets.size).toBe(1);
  });

  it('writes the opening message to the ledger, like any other market', async () => {
    const res = await request(api.app)
      .post('/resolve')
      .send({ question: 'Is Protocol Q growth wash-farmed?' })
      .expect(202);
    const messages = ledger.topics.get(res.body.topicId) ?? [];
    expect(messages[0]).toMatchObject({ type: 'market-open', marketId: res.body.marketId });
  });
});
