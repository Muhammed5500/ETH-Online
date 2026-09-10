/**
 * The Hedera end-to-end test — the STEP 17 gate, and the lock on PHASE 2.
 *
 * Runs against real testnet: real x402 payments, a real HCS topic, real
 * transfers. Nothing here is faked, which is the point — every seam that the
 * unit suite injects a double into is exercised for real exactly once, here.
 *
 * Three claims cannot be made anywhere else:
 *
 *   the books close ON CHAIN, not merely in a plan
 *   every stopping decision re-derives from the PUBLIC running hashes
 *   a timeout does not roll the dice, under real network timing
 *
 * Skips cleanly when `.env` or `agents/accounts.json` are absent: an
 * integration test that cannot run is not a failure.
 *
 * Run:  pnpm test:integration
 */
import { describe, expect, it, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { DEFAULT_PARAMS, type MarketParams } from '@ethonline/core';
import {
  getBalance,
  readTopicMessages,
  verifyStoppingDecision,
  toHex,
} from '@ethonline/hedera';
import { Orchestrator } from '../src/orchestrator.js';
import { httpAgentTransport, hederaPayer } from '../src/transport.js';
import { DEFAULT_API_CONFIG } from '../src/app.js';
import {
  bondAll,
  loadCredentials,
  payingFetch,
  registerAgents,
  sleep,
  startAgentServer,
  startApi,
  type ApiHarness,
} from './e2e-harness.js';

const creds = loadCredentials();
const runs = creds !== null;

if (!runs) {
  // eslint-disable-next-line no-console
  console.log('\n  Skipping Hedera e2e: no .env or agents/accounts.json.\n');
}

/**
 * A deliberately small market for the timeout case.
 *
 * `minPoolSize > k + 1` is enforced by the validator, so k=1 allows a pool of
 * five. Fewer bonds means fewer chain payments, which is what keeps this test
 * inside the five-minute budget the roadmap asks for.
 */
const SMALL_PARAMS: MarketParams = {
  ...DEFAULT_PARAMS,
  k: 1,
  T: 2,
  alpha: 1 / 3,
  minPoolSize: 5,
};

const openServers: Server[] = [];
const openApis: ApiHarness[] = [];

afterAll(() => {
  for (const s of openServers) s.close();
  for (const a of openApis) a.close();
});

describe.skipIf(!runs)('Hedera end-to-end', () => {
  it(
    'runs a full market and closes the books on chain',
    async () => {
      const c = creds!;
      const pool = c.agents.slice(0, DEFAULT_PARAMS.minPoolSize);
      expect(pool.length).toBe(DEFAULT_PARAMS.minPoolSize);

      const agentPort = 4501;
      const agentServer = await startAgentServer({ accounts: pool, port: agentPort });
      openServers.push(agentServer);
      const api = await startApi(c, 4502, DEFAULT_PARAMS);
      openApis.push(api);

      const treasuryBefore = await getBalance(api.client, c.treasury.accountId);

      await registerAgents(api.base, pool, agentPort);

      // ---- the asker pays -------------------------------------------------
      const askerFetch = payingFetch(c.cfg.operatorId, c.cfg.operatorKey, 500_000_000n);
      const opened = await askerFetch(`${api.base}/market`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'Is this protocol growth organic?' }),
      });
      expect(opened.status).toBe(201);
      const market = (await opened.json()) as { marketId: string; topicId: string };
      expect(market.topicId).toMatch(/^0\.0\.\d+$/);

      await bondAll(api.base, market.marketId, pool, api.markets);
      expect(api.markets.get(market.marketId)!.bonds.size).toBe(pool.length);

      // ---- run and settle ---------------------------------------------------
      const orchestrator = new Orchestrator({
        markets: api.markets,
        registry: api.registry,
        ledger: (await import('../src/ledger.js')).hederaLedger(api.client),
        transport: httpAgentTransport(),
        payer: hederaPayer({
          client: api.client,
          treasuryAccountId: c.treasury.accountId,
          treasuryKey: c.treasury.privateKey,
        }),
        hbarPerUnit: DEFAULT_API_CONFIG.hbarPerUnit,
        reportTimeoutMs: 15_000,
      });

      const state = await orchestrator.runMarket(market.marketId);
      expect(state.status).toBe('closed');
      expect(state.reports.length).toBeGreaterThan(0);
      // The reference is always the terminal agent — never a rolling window.
      expect(state.referenceReport?.agentId).toBe(
        state.reports[state.reports.length - 1]!.agentId,
      );

      const { plan, receipts, settlement } = await orchestrator.settle(
        market.marketId,
        c.cfg.operatorId,
      );

      expect(plan.totalOutTinybar).toBe(plan.totalInTinybar);
      expect(receipts.every((r) => r.status === 'SUCCESS')).toBe(true);
      // Exactly min(k, n) agents collect the flat fee.
      expect(settlement.payouts.filter((p) => p.kind === 'flat-fee')).toHaveLength(
        Math.min(DEFAULT_PARAMS.k, state.reports.length),
      );

      // ---- the money really moved -------------------------------------------
      await sleep(4000);
      const treasuryAfter = await getBalance(api.client, c.treasury.accountId);
      // Everything that came in went back out. Anything left over is a slashed
      // bond, and nobody timed out here.
      expect(treasuryAfter.tinybar - treasuryBefore.tinybar).toBe(plan.slashedTinybar);

      // ---- the public ledger ------------------------------------------------
      const expectedMessages = state.reports.length + state.timedOutAgents.length + 3;
      let entries: Awaited<ReturnType<typeof readTopicMessages>> = [];
      for (let attempt = 1; attempt <= 12; attempt++) {
        await sleep(2500);
        entries = await readTopicMessages(c.cfg.network, market.topicId);
        if (entries.length >= expectedMessages) break;
      }

      // ROADMAP: message count == reports + 3 (open, close, settlement).
      expect(entries).toHaveLength(expectedMessages);
      expect(entries.every((e) => e.parseError === undefined)).toBe(true);
      expect(entries.map((e) => e.sequenceNumber)).toEqual(
        entries.map((_, i) => i + 1),
      );

      const types = entries.map((e) => e.message?.type);
      expect(types[0]).toBe('market-open');
      expect(types[types.length - 2]).toBe('market-close');
      expect(types[types.length - 1]).toBe('settlement');

      // ---- every stopping decision re-derives from public data ---------------
      //
      // This is the claim the whole randomness design exists to support: a
      // sceptic pulls the topic, runs the same arithmetic, and confirms the
      // market stopped where it says it did — and did not keep running past a
      // roll that should have ended it.
      const publicReports = entries.filter((e) => e.message?.type === 'report');
      expect(publicReports).toHaveLength(state.reports.length);

      publicReports.forEach((entry, i) => {
        const isLast = i === publicReports.length - 1;
        expect(
          verifyStoppingDecision(entry.runningHash, DEFAULT_PARAMS.alpha, isLast),
        ).toBe(true);
      });

      // And a fabricated claim about the closing roll is caught.
      const closing = publicReports[publicReports.length - 1]!;
      expect(verifyStoppingDecision(closing.runningHash, DEFAULT_PARAMS.alpha, false)).toBe(false);

      // The hashes we acted on are byte-identical to the public ones.
      const localHashes = api.markets
        .get(market.marketId)!
        .rng.draws.filter((d) => d.purpose === 'stop')
        .map((d) => d.runningHashHex);
      expect(publicReports.map((e) => toHex(e.runningHash))).toEqual(localHashes);
    },
    290_000,
  );

  it(
    'slashes silent agents and rolls the dice ZERO times',
    async () => {
      // The rule that cannot be checked offline under real timing: a timeout
      // must not be able to close a market. If it could, any agent could end a
      // market early just by going quiet.
      //
      // Every agent here is silent, which makes the assertion exact rather
      // than probabilistic. An earlier version silenced ONE agent and asserted
      // it was slashed — but the draw is random and a short market simply may
      // never reach it. A test that depends on a coin landing right is worse
      // than no test. The "market keeps running after a timeout" path is
      // covered deterministically in the unit suite instead.
      const c = creds!;
      const pool = c.agents.slice(0, SMALL_PARAMS.minPoolSize);

      const agentPort = 4503;
      const agentServer = await startAgentServer({
        accounts: pool,
        port: agentPort,
        silent: new Set(pool.map((a) => a.agentId)),
      });
      openServers.push(agentServer);
      const api = await startApi(c, 4504, SMALL_PARAMS);
      openApis.push(api);

      await registerAgents(api.base, pool, agentPort);

      const askerFetch = payingFetch(c.cfg.operatorId, c.cfg.operatorKey, 500_000_000n);
      const opened = await askerFetch(`${api.base}/market`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'timeout scenario', params: SMALL_PARAMS }),
      });
      expect(opened.status).toBe(201);
      const market = (await opened.json()) as { marketId: string; topicId: string };

      await bondAll(api.base, market.marketId, pool, api.markets);

      const orchestrator = new Orchestrator({
        markets: api.markets,
        registry: api.registry,
        ledger: (await import('../src/ledger.js')).hederaLedger(api.client),
        transport: httpAgentTransport(),
        payer: hederaPayer({
          client: api.client,
          treasuryAccountId: c.treasury.accountId,
          treasuryKey: c.treasury.privateKey,
        }),
        hbarPerUnit: DEFAULT_API_CONFIG.hbarPerUnit,
        // Short, so silence costs seconds rather than a minute per agent.
        reportTimeoutMs: 3000,
      });

      const state = await orchestrator.runMarket(market.marketId);

      expect(state.status).toBe('closed');
      expect(state.closedReason).toBe('pool-exhausted');
      expect(state.timedOutAgents).toHaveLength(pool.length);
      expect(state.reports).toHaveLength(0);

      // THE ASSERTION THIS TEST EXISTS FOR: five timeouts, zero stopping rolls.
      const stopRolls = api.markets
        .get(market.marketId)!
        .rng.draws.filter((d) => d.purpose === 'stop');
      expect(stopRolls).toHaveLength(0);
      // The draws still happened, and each read fresh entropy.
      const drawRolls = api.markets
        .get(market.marketId)!
        .rng.draws.filter((d) => d.purpose === 'draw');
      expect(drawRolls).toHaveLength(pool.length);
      expect(new Set(drawRolls.map((d) => d.runningHashHex)).size).toBe(pool.length);

      // Degenerate settlement: nobody reported, so there is no reference and
      // nothing to score. Every bond is slashed and the asker gets it all —
      // never another agent (PLAN section 5, rule 4).
      const { plan, settlement } = await orchestrator.settle(market.marketId, c.cfg.operatorId);
      expect(settlement.reference).toBeUndefined();
      expect(settlement.payouts).toHaveLength(0);
      expect(plan.lines.filter((l) => l.beneficiary !== 'asker')).toHaveLength(0);
      expect(plan.slashedTinybar).toBe(
        BigInt(pool.length) * 100_000_000n,
      );
      expect(plan.totalOutTinybar).toBe(plan.totalInTinybar);

      // The timeouts are on the public record.
      const expected = pool.length + 3;
      let entries: Awaited<ReturnType<typeof readTopicMessages>> = [];
      for (let attempt = 1; attempt <= 12; attempt++) {
        await sleep(2500);
        entries = await readTopicMessages(c.cfg.network, market.topicId);
        if (entries.length >= expected) break;
      }
      const timeouts = entries.filter((e) => e.message?.type === 'timeout');
      expect(timeouts).toHaveLength(pool.length);
      expect(entries.filter((e) => e.message?.type === 'report')).toHaveLength(0);
    },
    290_000,
  );
});
