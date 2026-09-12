/**
 * Tests for the agent's HTTP face.
 *
 * THE TEST THAT JUSTIFIES THIS FILE is the round trip: a signature produced
 * here must be accepted by `verifyReportSignature` in `@ethonline/api`, which
 * is what the market actually runs. The two sides agree on a byte-exact
 * message format, and if they ever drift the symptom is a 401 that looks like
 * a key problem and costs an agent its bond at the moment it is drawn. Nothing
 * else in the system would catch that.
 *
 * The signature is checked against the RAW probability, unclipped, because
 * that is what the agent committed to and what the protocol re-derives when it
 * verifies.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hashgraph/sdk';
import { verifyReportSignature } from '@ethonline/api';
import { beliefFromProbability } from '@ethonline/core';
import { stubLlm } from '../src/llm.js';
import { Agent, type AgentConfig } from '../src/runner.js';
import { createAgentServer, parseAgentKey, signReport } from '../src/server.js';

const KEY = PrivateKey.generateECDSA();

function config(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-07',
    accountId: '0.0.1234',
    privateKey: KEY.toStringDer(),
    publicKey: KEY.publicKey.toStringDer(),
    sliceIds: ['liquidity'],
    persona: 'You look at pool depth.',
    ...over,
  };
}

function server(probability = 0.73, over: Partial<AgentConfig> = {}) {
  const cfg = config(over);
  const agent = new Agent({
    config: cfg,
    llm: stubLlm(() => ({ probability, reasoning: 'depth is thin relative to volume' })),
  });
  return { ...createAgentServer({ agent, config: cfg }), config: cfg };
}

const BODY = {
  marketId: 'mkt-2026-09-12-001',
  question: 'Is this protocol growth organic?',
  position: 1,
  prior: [0.5, 0.5],
  history: [],
};

describe('parseAgentKey', () => {
  it('reads the DER form the accounts file stores', () => {
    expect(parseAgentKey(KEY.toStringDer()).publicKey.toStringDer()).toBe(
      KEY.publicKey.toStringDer(),
    );
  });

  it('reads a bare hex key too', () => {
    expect(parseAgentKey(KEY.toStringRaw()).publicKey.toStringDer()).toBe(
      KEY.publicKey.toStringDer(),
    );
  });

  it('fails loudly on a key it cannot parse, at startup rather than mid-market', () => {
    expect(() => parseAgentKey('not-a-key')).toThrow();
  });
});

describe('POST /report', () => {
  it('THE ROUND TRIP: the market accepts the signature this agent produces', async () => {
    const s = server(0.73);
    const res = await request(s.app).post('/report').send(BODY).expect(200);

    expect(res.body.probability).toBe(0.73);

    const check = verifyReportSignature(
      {
        marketId: BODY.marketId,
        agentId: 'agent-07',
        position: 1,
        belief: beliefFromProbability(res.body.probability),
      },
      res.body.signature,
      s.config.publicKey,
    );
    expect(check).toEqual({ ok: true });
  });

  it('signs the RAW probability, so the protocol can still audit its own clip', async () => {
    // 0.004 is below epsilon and will be clipped to 0.01 on receipt. The
    // signature must cover 0.004: verifying against the clipped value is what
    // would fail, and that failure is the proof the raw value was signed.
    const s = server(0.004);
    const res = await request(s.app).post('/report').send(BODY).expect(200);
    expect(res.body.probability).toBe(0.004);

    const claim = { marketId: BODY.marketId, agentId: 'agent-07', position: 1 };
    expect(
      verifyReportSignature(
        { ...claim, belief: beliefFromProbability(0.004) },
        res.body.signature,
        s.config.publicKey,
      ).ok,
    ).toBe(true);
    expect(
      verifyReportSignature(
        { ...claim, belief: beliefFromProbability(0.01) },
        res.body.signature,
        s.config.publicKey,
      ).ok,
    ).toBe(false);
  });

  it('binds the signature to the position, so a report cannot be replayed later', async () => {
    const s = server(0.6);
    const res = await request(s.app).post('/report').send({ ...BODY, position: 4 }).expect(200);
    const claim = { marketId: BODY.marketId, agentId: 'agent-07', belief: beliefFromProbability(0.6) };
    expect(verifyReportSignature({ ...claim, position: 4 }, res.body.signature, s.config.publicKey).ok).toBe(true);
    expect(verifyReportSignature({ ...claim, position: 5 }, res.body.signature, s.config.publicKey).ok).toBe(false);
  });

  it('passes the history through to the model', async () => {
    const cfg = config();
    const agent = new Agent({
      config: cfg,
      llm: stubLlm((req) => {
        expect(req.user).toMatch(/alpha reported P\(yes\) = 0\.8/);
        return { probability: 0.55, reasoning: '' };
      }),
    });
    const { app } = createAgentServer({ agent, config: cfg });
    await request(app)
      .post('/report')
      .send({
        ...BODY,
        position: 2,
        history: [{ position: 1, agentId: 'alpha', belief: [0.2, 0.8] }],
      })
      .expect(200);
  });

  it('reports what its evidence cost, which is what the Graph story rests on', async () => {
    const res = await request(server().app).post('/report').send(BODY).expect(200);
    expect(res.body).toHaveProperty('evidenceCostUsd');
    expect(res.body).toHaveProperty('evidenceDigest');
    expect(res.body.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('400s a malformed request rather than signing nonsense', async () => {
    await request(server().app).post('/report').send({ question: 'q' }).expect(400);
    await request(server().app).post('/report').send({ ...BODY, position: 0 }).expect(400);
  });

  it('503s when the model is down, so an operator can tell that apart from a broken agent', async () => {
    const cfg = config();
    const agent = new Agent({
      config: cfg,
      llm: stubLlm(() => {
        throw new Error('model timeout');
      }),
    });
    const { app } = createAgentServer({ agent, config: cfg });
    const res = await request(app).post('/report').send(BODY).expect(503);
    expect(res.body.detail).toMatch(/model timeout/);
  });
});

describe('GET /health', () => {
  it('says who it is and what it looks at', async () => {
    const res = await request(server().app).get('/health').expect(200);
    expect(res.body).toMatchObject({ ok: true, agentId: 'agent-07', behavior: 'honest' });
    expect(res.body.sliceIds).toEqual(['liquidity']);
  });

  it('publishes a per-process identity, which is how port squatting is caught', async () => {
    // A stale agent process left listening on the same port will answer for a
    // new one, and on Windows the second bind can succeed rather than fail.
    // The fleet then reports every agent as up while the OLD process serves
    // the market. It cost a full run, which looked green and was produced
    // entirely by stubs. Identity is what makes "is this you?" answerable.
    const a = server();
    const b = server();
    expect(a.instanceId).not.toBe(b.instanceId);

    const res = await request(a.app).get('/health').expect(200);
    expect(res.body.instanceId).toBe(a.instanceId);
  });
});

describe('signReport', () => {
  it('refuses to sign a claim that cannot be reproduced byte for byte', () => {
    expect(() =>
      signReport(KEY, { marketId: '', agentId: 'a', position: 1, belief: [0.5, 0.5] }),
    ).toThrow();
  });
});
