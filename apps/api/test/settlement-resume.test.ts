/**
 * Resumable settlement tests.
 *
 * THE DEFECT THESE EXIST TO CLOSE, in the words of the STEP 16 log:
 *
 *   "settlement kısmi bir başarısızlıktan sonra tekrar çalıştırılırsa ödenmiş
 *    parçalar yeniden ödenir"
 *
 * Twenty agents plus the asker do not fit in one Hedera transfer, so a
 * settlement is several transactions and they are not atomic with respect to
 * each other. Before this, a settlement that stopped on chunk two and was run
 * again paid chunk one a second time — and nothing anywhere would have
 * noticed, because every accounting invariant in `core` describes what SHOULD
 * be paid, not what was.
 *
 * The load-bearing test is "does not pay a chunk that already went through".
 * Everything else here exists to keep that one honest.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { DEFAULT_PARAMS } from '@ethonline/core';
import { createApp, type Api } from '../src/app.js';
import {
  Orchestrator,
  SettlementBlockedError,
  type AgentTransport,
  type Payer,
  type PayerReceipt,
} from '../src/orchestrator.js';
import type { TransferLine } from '../src/settlement-plan.js';
import { agentPool, createFakeLedger, type FakeLedger, type TestAgent } from './helpers.js';

let ledger: FakeLedger;
let api: Api;
let agents: TestAgent[];

/** Every send, in order, so a double payment is visible rather than inferred. */
interface SendRecord {
  readonly lines: readonly TransferLine[];
  readonly memo: string;
  readonly beneficiaries: readonly string[];
}
let sends: SendRecord[];

function honestTransport(): AgentTransport {
  return {
    async requestReport(agent, req) {
      const testAgent = agents.find((a) => a.agentId === agent.agentId)!;
      const probability = 0.7;
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

/**
 * A payer that fails on chosen chunk indexes.
 *
 * `failOn` counts CHUNKS, not calls, so a chunk that is retried after being
 * resolved can be made to succeed the second time.
 */
function flakyPayer(failOn: Set<number>, error = 'network went away mid-transfer'): Payer {
  return {
    async send(lines, memo): Promise<PayerReceipt> {
      const index = sends.length;
      sends.push({
        lines,
        memo,
        beneficiaries: lines.map((l) => l.beneficiary),
      });
      if (failOn.has(index)) throw new Error(error);
      return { transactionId: `0.0.7@${index}`, status: 'SUCCESS' };
    },
  };
}

function makeOrchestrator(payer: Payer, maxCreditsPerTransaction = 9): Orchestrator {
  return new Orchestrator({
    markets: api.markets,
    registry: api.registry,
    ledger,
    transport: honestTransport(),
    payer,
    hbarPerUnit: 1,
    reportTimeoutMs: 50,
    maxCreditsPerTransaction,
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
  const res = await request(api.app)
    .post('/market')
    .send({ question: 'Is this protocol growth organic?' })
    .expect(201);
  const marketId = res.body.marketId as string;
  for (const a of agents) {
    await request(api.app).post(`/market/${marketId}/bond`).send({ agentId: a.agentId }).expect(201);
  }
  return marketId;
}

/** Runs a market to close and returns its id. */
async function closedMarket(): Promise<string> {
  const marketId = await seedMarket();
  await makeOrchestrator(flakyPayer(new Set())).runMarket(marketId);
  return marketId;
}

function chunkMessages(marketId: string): Array<Record<string, unknown>> {
  const stored = api.markets.get(marketId)!;
  return (ledger.topics.get(stored.topicId) ?? [])
    .filter((m) => m.type === 'settlement-chunk')
    .map((m) => m as unknown as Record<string, unknown>);
}

beforeEach(() => {
  ledger = createFakeLedger();
  api = createApp({ ledger });
  sends = [];
});

describe('a settlement that completes', () => {
  it('pays every chunk once and marks the market settled', async () => {
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set()), 3);

    const result = await orch.settle(marketId, '0.0.999');

    expect(result.progress.complete).toBe(true);
    expect(result.progress.sent).toBe(result.progress.total);
    expect(result.progress.unknown).toBe(0);
    expect(result.receipts).toHaveLength(result.progress.total);
    expect(api.markets.get(marketId)!.market.status).toBe('settled');
  });

  it('records every chunk on the topic', async () => {
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set()), 3);
    const result = await orch.settle(marketId, '0.0.999');

    const written = chunkMessages(marketId);
    expect(written).toHaveLength(result.progress.total);
    expect(written.every((m) => m['outcome'] === 'sent')).toBe(true);
    expect(written.map((m) => m['chunkIndex'])).toEqual(
      written.map((_, i) => i),
    );
    // The amount is a string because it is a uint64, and it has to survive a
    // round trip through JSON without becoming a float.
    expect(typeof written[0]!['amountTinybar']).toBe('string');
  });

  it('pays each beneficiary exactly once across all chunks', async () => {
    const marketId = await closedMarket();
    await makeOrchestrator(flakyPayer(new Set()), 3).settle(marketId, '0.0.999');

    const all = sends.flatMap((s) => s.beneficiaries);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('a settlement that stops halfway', () => {
  it('stops at the chunk that did not confirm and does not attempt later ones', async () => {
    const marketId = await closedMarket();
    // Chunk 1 (the second) throws.
    const orch = makeOrchestrator(flakyPayer(new Set([1])), 3);

    const err = await orch.settle(marketId, '0.0.999').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SettlementBlockedError);
    const blocked = err as SettlementBlockedError;
    expect(blocked.progress.sent).toBe(1);
    expect(blocked.progress.unknown).toBe(1);
    expect(blocked.unresolved).toHaveLength(1);
    expect(blocked.unresolved[0]!.index).toBe(1);
    // Two attempts: chunk 0 succeeded, chunk 1 threw. Chunk 2 was never tried.
    expect(sends).toHaveLength(2);
  });

  it('calls the failed chunk UNKNOWN, not failed', async () => {
    // We do not know whether it landed. Recording it as failed is the
    // assumption that pays twice.
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set([1])), 3);
    await orch.settle(marketId, '0.0.999').catch(() => undefined);

    const written = chunkMessages(marketId);
    expect(written.map((m) => m['outcome'])).toEqual(['sent', 'unknown']);
  });

  it('leaves the market closed rather than settled', async () => {
    const marketId = await closedMarket();
    await makeOrchestrator(flakyPayer(new Set([1])), 3)
      .settle(marketId, '0.0.999')
      .catch(() => undefined);
    expect(api.markets.get(marketId)!.market.status).toBe('closed');
  });

  it('says what to do about it', async () => {
    const marketId = await closedMarket();
    const err = (await makeOrchestrator(flakyPayer(new Set([1])), 3)
      .settle(marketId, '0.0.999')
      .catch((e: unknown) => e)) as SettlementBlockedError;

    expect(err.message).toMatch(/HashScan/);
    expect(err.message).toMatch(/resolveSettlementChunk/);
    expect(err.message).toMatch(/paid twice/);
  });
});

describe('THE DEFECT: re-running a partial settlement', () => {
  it('DOES NOT PAY A CHUNK THAT ALREADY WENT THROUGH', async () => {
    // This is the whole point of the file. Before the fix, the second call
    // recomputed the plan from scratch and paid chunk 0 for a second time.
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set([1])), 3);

    await orch.settle(marketId, '0.0.999').catch(() => undefined);
    const afterFirst = [...sends];
    expect(afterFirst).toHaveLength(2);

    // Run it again, exactly as an operator would after seeing the error.
    await orch.settle(marketId, '0.0.999').catch(() => undefined);

    // Nothing more was sent: chunk 0 is already paid and chunk 1's outcome is
    // unknown, so neither may be touched without a human decision.
    expect(sends).toHaveLength(2);
    const chunk0Beneficiaries = afterFirst[0]!.beneficiaries;
    const paidTwice = sends
      .slice(1)
      .flatMap((s) => s.beneficiaries)
      .filter((b) => chunk0Beneficiaries.includes(b));
    expect(paidTwice).toEqual([]);
  });

  it('throws the same blocked error rather than pretending to make progress', async () => {
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set([1])), 3);
    await orch.settle(marketId, '0.0.999').catch(() => undefined);

    await expect(orch.settle(marketId, '0.0.999')).rejects.toBeInstanceOf(SettlementBlockedError);
  });

  it('reuses the stored plan instead of recomputing it', async () => {
    // Recomputing would make "already paid" a claim about a plan that no
    // longer exists.
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set([1])), 3);
    await orch.settle(marketId, '0.0.999').catch(() => undefined);

    const first = api.markets.get(marketId)!.settlementProgress!;
    await orch.settle(marketId, '0.0.999').catch(() => undefined);
    const second = api.markets.get(marketId)!.settlementProgress!;

    expect(second).toBe(first);
    expect(second.plan).toBe(first.plan);
  });

  it('writes the settlement message only once', async () => {
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set([1])), 3);
    await orch.settle(marketId, '0.0.999').catch(() => undefined);
    await orch.settle(marketId, '0.0.999').catch(() => undefined);

    const stored = api.markets.get(marketId)!;
    const settlements = (ledger.topics.get(stored.topicId) ?? []).filter(
      (m) => m.type === 'settlement',
    );
    expect(settlements).toHaveLength(1);
  });
});

describe('resolving an unknown chunk', () => {
  it('marks it paid and finishes the rest without re-sending it', async () => {
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set([1])), 3);
    await orch.settle(marketId, '0.0.999').catch(() => undefined);

    const failedChunkBeneficiaries = sends[1]!.beneficiaries;
    await orch.resolveSettlementChunk(
      marketId,
      1,
      'paid',
      'HashScan shows 0.0.7@1 SUCCESS at 1789001234.000000001',
    );

    const result = await orch.settle(marketId, '0.0.999');

    expect(result.progress.complete).toBe(true);
    expect(api.markets.get(marketId)!.market.status).toBe('settled');
    // Chunk 1 was NOT sent again.
    const afterResolve = sends.slice(2).flatMap((s) => s.beneficiaries);
    expect(afterResolve.filter((b) => failedChunkBeneficiaries.includes(b))).toEqual([]);
  });

  it('marks it not-paid and pays it on the resume', async () => {
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set([1])), 3);
    await orch.settle(marketId, '0.0.999').catch(() => undefined);

    const failedChunkBeneficiaries = sends[1]!.beneficiaries;
    await orch.resolveSettlementChunk(
      marketId,
      1,
      'not-paid',
      'no matching transfer in the treasury history',
    );

    const result = await orch.settle(marketId, '0.0.999');

    expect(result.progress.complete).toBe(true);
    const afterResolve = sends.slice(2).flatMap((s) => s.beneficiaries);
    for (const b of failedChunkBeneficiaries) expect(afterResolve).toContain(b);
  });

  it('puts the decision and its evidence on the public record', async () => {
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set([1])), 3);
    await orch.settle(marketId, '0.0.999').catch(() => undefined);
    await orch.resolveSettlementChunk(marketId, 1, 'paid', 'HashScan: 0.0.7@1 SUCCESS');

    const resolved = chunkMessages(marketId).filter((m) => m['outcome'] === 'resolved-paid');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!['evidence']).toBe('HashScan: 0.0.7@1 SUCCESS');
    expect(resolved[0]!['chunkIndex']).toBe(1);
  });

  it('refuses to resolve a chunk that is already sent', async () => {
    // Forcing a sent chunk back to pending is the double payment, entered by
    // hand instead of by accident.
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set([1])), 3);
    await orch.settle(marketId, '0.0.999').catch(() => undefined);

    await expect(
      orch.resolveSettlementChunk(marketId, 0, 'not-paid', 'I think it failed'),
    ).rejects.toThrow(/not "unknown"/);
  });

  it('refuses a resolution with no evidence', async () => {
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set([1])), 3);
    await orch.settle(marketId, '0.0.999').catch(() => undefined);

    await expect(orch.resolveSettlementChunk(marketId, 1, 'paid', '   ')).rejects.toThrow(
      /needs evidence/,
    );
  });

  it('refuses an index that does not exist', async () => {
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set([1])), 3);
    await orch.settle(marketId, '0.0.999').catch(() => undefined);

    await expect(orch.resolveSettlementChunk(marketId, 99, 'paid', 'x')).rejects.toThrow(
      /no chunk 99/,
    );
  });

  it('refuses to resolve a settlement that never started', async () => {
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set()), 3);
    await expect(orch.resolveSettlementChunk(marketId, 0, 'paid', 'x')).rejects.toThrow(
      /has no settlement to resolve/,
    );
  });
});

describe('settling a market that is already settled', () => {
  it('is a no-op that returns the record', async () => {
    // A caller retrying after a lost response should learn that nothing is
    // owed, not get an error that invites another attempt.
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set()), 3);
    const first = await orch.settle(marketId, '0.0.999');
    const sendsAfterFirst = sends.length;

    const second = await orch.settle(marketId, '0.0.999');

    expect(sends).toHaveLength(sendsAfterFirst);
    expect(second.receipts).toEqual([]);
    expect(second.progress.complete).toBe(true);
    expect(second.settlement).toEqual(first.settlement);
  });

  it('still refuses a market that has not closed', async () => {
    const marketId = await seedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set()), 3);
    await expect(orch.settle(marketId, '0.0.999')).rejects.toThrow(/only a closed market settles/);
  });
});

describe('when the ledger cannot record a chunk', () => {
  it('keeps the payment recorded in memory rather than losing it', async () => {
    // Throwing here would discard the state that says the chunk was paid, and
    // the next resume would pay it again. A lost receipt costs auditability;
    // that is the cheaper of the two.
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set()), 3);

    const stored = api.markets.get(marketId)!;
    const original = ledger.append.bind(ledger);
    let calls = 0;
    ledger.append = async (topicId, message) => {
      calls++;
      // Let the settlement message through, fail the first chunk receipt.
      if (message.type === 'settlement-chunk' && calls > 1) {
        if (message.chunkIndex === 0) throw new Error('ledger unavailable');
      }
      return original(topicId, message);
    };

    const result = await orch.settle(marketId, '0.0.999');

    expect(result.progress.complete).toBe(true);
    expect(stored.settlementProgress!.chunks[0]!.state).toBe('sent');
    // The receipt is missing from the topic, and that is the accepted cost.
    expect(chunkMessages(marketId).some((m) => m['chunkIndex'] === 0)).toBe(false);
  });

  it('reports the missing receipt instead of swallowing it', async () => {
    const marketId = await closedMarket();
    const events: string[] = [];
    const orch = new Orchestrator({
      markets: api.markets,
      registry: api.registry,
      ledger,
      transport: honestTransport(),
      payer: flakyPayer(new Set()),
      hbarPerUnit: 1,
      maxCreditsPerTransaction: 3,
      onEvent: (event) => events.push(event),
    });

    const original = ledger.append.bind(ledger);
    ledger.append = async (topicId, message) => {
      if (message.type === 'settlement-chunk') throw new Error('ledger unavailable');
      return original(topicId, message);
    };

    await orch.settle(marketId, '0.0.999');
    expect(events).toContain('settlement-chunk-unrecorded');
  });
});

describe('settlementProgress()', () => {
  it('is undefined before a settlement starts', async () => {
    const marketId = await closedMarket();
    expect(makeOrchestrator(flakyPayer(new Set())).settlementProgress(marketId)).toBeUndefined();
  });

  it('adds up what is paid, unknown and pending', async () => {
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set([1])), 3);
    await orch.settle(marketId, '0.0.999').catch(() => undefined);

    const p = orch.settlementProgress(marketId)!;
    expect(p.sent).toBe(1);
    expect(p.unknown).toBe(1);
    expect(p.pending).toBe(p.total - 2);
    expect(p.blocked).toBe(true);
    expect(p.complete).toBe(false);
    expect(p.sentTinybar + p.unknownTinybar + p.pendingTinybar).toBe(
      api.markets.get(marketId)!.settlementProgress!.plan.totalOutTinybar,
    );
  });
});

describe('who waits when a settlement stops partway', () => {
  it('puts the asker last, so agents are paid before the party that funded it', async () => {
    // Chunks are not atomic with respect to each other — a Hedera limit, not a
    // choice. What IS a choice is who sits in the unpaid tail. Agents have
    // bonds locked until they are paid; the asker started the market. Moving
    // the asker earlier would quietly reverse that.
    const marketId = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set()), 3);
    await orch.settle(marketId, '0.0.999');

    const plan = api.markets.get(marketId)!.settlementProgress!.plan;
    expect(plan.lines[plan.lines.length - 1]!.beneficiary).toBe('asker');
    expect(plan.lines.filter((l) => l.beneficiary === 'asker')).toHaveLength(1);
  });

  it('leaves the asker unpaid rather than an agent when it stops on the last chunk', async () => {
    const marketId = await closedMarket();
    const total = Math.ceil(
      (await (async () => {
        const o = makeOrchestrator(flakyPayer(new Set()), 3);
        await o.settle(marketId, '0.0.999');
        return api.markets.get(marketId)!.settlementProgress!.plan.lines.length;
      })()) / 3,
    );

    // Rebuild the same market and fail on the final chunk.
    sends = [];
    ledger = createFakeLedger();
    api = createApp({ ledger });
    const second = await closedMarket();
    const orch = makeOrchestrator(flakyPayer(new Set([total - 1])), 3);
    await orch.settle(second, '0.0.999').catch(() => undefined);

    const progress = api.markets.get(second)!.settlementProgress!;
    const lastChunk = progress.chunks[progress.chunks.length - 1]!;
    expect(lastChunk.state).toBe('unknown');
    expect(lastChunk.lines.some((l) => l.beneficiary === 'asker')).toBe(true);
  });
});
