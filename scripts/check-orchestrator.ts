/**
 * A whole market, end to end on testnet — the STEP 16 gate.
 *
 * The asker pays with x402, twenty agents each pay their own bond with x402,
 * the orchestrator drives the rounds against HCS, and the settlement pays
 * everyone back out of the treasury. Real money moves in both directions and
 * every balance is measured before and after.
 *
 * What it proves that the unit tests cannot:
 *   the accounting closes on chain, not just in a plan
 *   the ledger holds every event in consensus order
 *   the transfers are real and visible on HashScan
 *
 * Run:  pnpm check:orchestrator
 */
import '@ethonline/env';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import {
  createClientHederaSigner,
  ExactHederaScheme,
  HBAR_ASSET_ID,
  HEDERA_TESTNET_CAIP2,
  PrivateKey,
} from '@x402/hedera';
// The x402 package re-exports a PrivateKey from @hiero-ledger; signatures go
// through @hashgraph's, and the two types are not interchangeable. Imported
// under its own name so the difference is visible at the call site.
import { PrivateKey as HederaKey } from '@hashgraph/sdk';
import { DEFAULT_PARAMS } from '@ethonline/core';
import {
  createHederaClient,
  getBalance,
  hashscanUrl,
  hederaConfigFromEnv,
  parseAccountsFile,
  readTopicMessages,
  treasuryFromEnv,
  type AgentAccount,
} from '@ethonline/hedera';
import { createApp, DEFAULT_API_CONFIG } from '../apps/api/src/app.js';
import { hederaLedger } from '../apps/api/src/ledger.js';
import { createPaymentGate, payWithRetry } from '../apps/api/src/payment.js';
import { MarketStore } from '../apps/api/src/store.js';
import { Orchestrator } from '../apps/api/src/orchestrator.js';
import { httpAgentTransport, hederaPayer } from '../apps/api/src/transport.js';
import { canonicalReportMessage } from '../apps/api/src/signatures.js';
import { signRegistration } from '../apps/agent/src/server.js';
import { tinybarToHbar } from '../apps/api/src/pricing.js';

const API_PORT = 4061;
const AGENT_PORT = 4062;
const API = `http://localhost:${API_PORT}`;

/**
 * Run against the real agent fleet instead of the stubs below.
 *
 * WHY THIS FLAG EXISTS. Two halves of this system have each been proven and
 * never at the same time. This script proves the chain half — real x402
 * payments, real HCS, real HBAR settlement — against agents that are a
 * formula. `check:resolve` proves the agent half — twenty processes, a model,
 * paid Graph queries — against an in-memory ledger. Neither is the other, and
 * "it works end to end" is the one claim in this repo that nothing would back
 * if the two were only ever run apart.
 *
 * With `--external-agents` the orchestrator registers the endpoints that
 * `pnpm agents` is already listening on, and both halves run as one market.
 */
const EXTERNAL_AGENTS = process.argv.includes('--external-agents');
const AGENT_BASE_PORT = Number(process.env['AGENT_BASE_PORT'] ?? 4100);

let failures = 0;
function step(ok: boolean, name: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (detail) console.log(`         ${detail}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function payingFetch(accountId: string, privateKey: string, ceiling: bigint) {
  const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(privateKey), {
    network: HEDERA_TESTNET_CAIP2,
  });
  return wrapFetchWithPayment(
    fetch,
    x402Client.fromConfig({
      schemes: [{ network: HEDERA_TESTNET_CAIP2, client: new ExactHederaScheme(signer) }],
      spendControls: {
        allowedAssets: [
          { network: HEDERA_TESTNET_CAIP2, asset: HBAR_ASSET_ID, maxAmountPerPayment: ceiling.toString() },
        ],
      },
    }),
  );
}

/**
 * One server hosting every agent.
 *
 * Each agent signs with its own Hedera key, so the orchestrator's signature
 * check is exercised for real rather than stubbed.
 */
function startAgents(accounts: readonly AgentAccount[]): Promise<Server> {
  const app = express();
  app.use(express.json());
  for (const account of accounts) {
    const key = PrivateKey.fromStringECDSA(account.privateKey);
    app.post(`/${account.agentId}`, (req, res) => {
      const { marketId, position, history } = req.body as {
        marketId: string;
        position: number;
        history: Array<{ belief: [number, number] }>;
      };
      // A plausible agent: nudge the price toward a private number.
      const signal = 0.45 + ((account.accountId.charCodeAt(account.accountId.length - 1) * 11) % 40) / 100;
      const price = history.length ? history[history.length - 1]!.belief[1] : 0.5;
      const probability = Number((0.6 * price + 0.4 * signal).toFixed(6));

      const message = canonicalReportMessage({
        marketId,
        agentId: account.agentId,
        position,
        belief: [1 - probability, probability],
      });
      const signature = Buffer.from(key.sign(new Uint8Array(Buffer.from(message, 'utf-8')))).toString('hex');
      res.json({ probability, signature });
    });
  }
  return new Promise((resolve) => {
    const s = app.listen(AGENT_PORT, () => resolve(s));
  });
}

async function main(): Promise<void> {
  console.log('\nORCHESTRATOR END-TO-END\n' + '='.repeat(74));

  const cfg = hederaConfigFromEnv();
  const treasury = treasuryFromEnv();
  if (!treasury) throw new Error('Treasury is not set in .env — run `pnpm setup:hedera`.');

  const accounts = parseAccountsFile(
    readFileSync(join(import.meta.dirname, '..', 'agents', 'accounts.json'), 'utf-8'),
  );
  const pool = accounts.agents.slice(0, DEFAULT_PARAMS.minPoolSize);
  if (pool.length < DEFAULT_PARAMS.minPoolSize) {
    throw new Error(`Need ${DEFAULT_PARAMS.minPoolSize} agents, accounts.json has ${pool.length}.`);
  }

  const hedera = createHederaClient(cfg);
  const markets = new MarketStore();
  const { app, registry } = createApp({
    ledger: hederaLedger(hedera),
    markets,
    paymentGate: createPaymentGate({
      treasuryAccountId: treasury.accountId,
      facilitatorUrl: process.env['BLOCKY402_FACILITATOR_URL'] || 'https://api.testnet.blocky402.com',
      markets,
      defaultParams: DEFAULT_PARAMS,
      hbarPerUnit: DEFAULT_API_CONFIG.hbarPerUnit,
    }),
    config: { network: cfg.network },
  });

  const apiServer: Server = await new Promise((r) => {
    const s = app.listen(API_PORT, () => r(s));
  });
  // With --external-agents nothing is started here: `pnpm agents` is already
  // listening, with real keys, a real model and a real Graph budget.
  const agentServer = EXTERNAL_AGENTS ? undefined : await startAgents(pool);

  try {
    const treasuryBefore = await getBalance(hedera, treasury.accountId);
    const askerBefore = await getBalance(hedera, cfg.operatorId);

    // ---- register every agent -------------------------------------------
    for (const [i, a] of pool.entries()) {
      const publicKey = PrivateKey.fromStringECDSA(a.privateKey).publicKey.toStringDer();
      // The fleet assigns ports in pool order, and it reads the same
      // accounts.json in the same order, so agent-01 is on the base port.
      const endpoint = EXTERNAL_AGENTS
        ? `http://127.0.0.1:${AGENT_BASE_PORT + i}/report`
        : `http://localhost:${AGENT_PORT}/${a.agentId}`;
      const claim = {
        agentId: a.agentId,
        accountId: a.accountId,
        publicKey,
        endpoint,
        issuedAt: Date.now(),
      };
      const res = await fetch(`${API}/agents/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...claim,
          signature: signRegistration(HederaKey.fromStringECDSA(a.privateKey), claim),
        }),
      });
      if (res.status !== 201) throw new Error(`Registering ${a.agentId} failed: ${res.status}`);
    }
    step(registry.size === pool.length, `All ${pool.length} agents registered`);

    // ---- asker opens a market -------------------------------------------
    console.log('\n  Asker paying for a market ...');
    const askerFetch = payingFetch(cfg.operatorId, cfg.operatorKey, 500_000_000n);
    const opened = await askerFetch(`${API}/market`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Is this protocol growth organic?' }),
    });
    const market = (await opened.json()) as { marketId: string; topicId: string };
    step(opened.status === 201, 'Market opened and paid for', `${market.marketId} on ${market.topicId}`);

    // ---- every agent pays its own bond ----------------------------------
    console.log(`\n  ${pool.length} agents paying bonds ...`);
    let retried = 0;
    for (const [i, a] of pool.entries()) {
      const f = payingFetch(a.accountId, a.privateKey, 200_000_000n);
      const res = await payWithRetry(
        () =>
          f(`${API}/market/${market.marketId}/bond`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ agentId: a.agentId }),
          }),
        {
          // Server state decides, not the payment result: if the bond is
          // already recorded, a lost response had settled after all.
          //
          // This is only sound because a bond recorded against a payment that
          // did not settle is now rolled back before the 402 goes out
          // (apps/api/src/payment-rollback.ts). Before that, this check read
          // an unpaid bond as a paid one and the run went green while the
          // treasury quietly lost a bond per occurrence — 2026-09-12, two
          // agents, 2 HBAR.
          alreadyDone: async () => markets.get(market.marketId)!.bonds.has(a.agentId),
          onRetry: () => retried++,
        },
      );
      const landed = markets.get(market.marketId)!.bonds.has(a.agentId);
      if (res.status !== 201 && !landed) {
        throw new Error(`Bond for ${a.agentId} failed: ${res.status}`);
      }
      process.stdout.write(`
    bonded ${i + 1}/${pool.length}`);
    }
    console.log('');
    if (retried > 0) console.log(`    (${retried} payment(s) needed a retry)`);
    step(markets.get(market.marketId)!.bonds.size === pool.length, 'Every bond is in the pool');

    // ---- run the market --------------------------------------------------
    console.log('\n  Running rounds — consensus decides when this stops.\n');
    const orchestrator = new Orchestrator({
      markets,
      registry,
      ledger: hederaLedger(hedera),
      transport: httpAgentTransport(),
      payer: hederaPayer({
        client: hedera,
        treasuryAccountId: treasury.accountId,
        treasuryKey: treasury.privateKey,
      }),
      hbarPerUnit: DEFAULT_API_CONFIG.hbarPerUnit,
      reportTimeoutMs: 20_000,
      onEvent: (event, detail) => {
        if (event === 'report') {
          console.log(
            `    #${String(detail['position']).padStart(2)}  ${detail['agentId']}  ` +
              `p=${Number(detail['belief']).toFixed(3)}  ${detail['stopped'] ? 'CLOSE' : 'continue'}`,
          );
        }
        if (event === 'timeout') console.log(`    timeout: ${detail['agentId']} — ${detail['reason']}`);
      },
    });

    const state = await orchestrator.runMarket(market.marketId);
    console.log('');
    step(state.status === 'closed', 'Market closed', `${state.reports.length} reports, ${state.closedReason}`);
    step(
      state.referenceReport?.agentId === state.reports[state.reports.length - 1]?.agentId,
      'The reference is the terminal agent',
    );

    // ---- settle -----------------------------------------------------------
    console.log('  Settling ...\n');
    const { plan, receipts, settlement } = await orchestrator.settle(market.marketId, cfg.operatorId);

    step(plan.totalOutTinybar === plan.totalInTinybar, 'The plan balances exactly', `${plan.totalInTinybar} tinybar in and out`);
    step(receipts.every((r) => r.status === 'SUCCESS'), `All ${receipts.length} transfer transactions succeeded`);
    for (const r of receipts) console.log(`    ${hashscanUrl(cfg.network, 'transaction', r.transactionId)}`);

    // ---- did the money actually move? ------------------------------------
    console.log('');
    await sleep(4000);
    const treasuryAfter = await getBalance(hedera, treasury.accountId);
    const treasuryDelta = treasuryAfter.tinybar - treasuryBefore.tinybar;

    // The treasury takes in the deposit and the bonds, pays out the plan, and
    // keeps any slashed bond. Fees are paid by the facilitator and the
    // operator, not from here.
    step(
      treasuryDelta === plan.slashedTinybar,
      'The treasury is square: everything in went back out',
      `delta ${tinybarToHbar(treasuryDelta).toFixed(8)} HBAR, slashed ${tinybarToHbar(plan.slashedTinybar).toFixed(8)}`,
    );

    const askerLine = plan.lines.find((l) => l.beneficiary === 'asker');
    step(!!askerLine, 'The asker gets a refund line', askerLine ? `${tinybarToHbar(askerLine.amountTinybar).toFixed(8)} HBAR` : '');

    const paidAgents = plan.lines.filter((l) => l.beneficiary !== 'asker');
    step(
      paidAgents.length === pool.length - state.timedOutAgents.length,
      'Every agent that answered was paid',
      `${paidAgents.length} agents, ${state.timedOutAgents.length} slashed`,
    );

    const sampleAgent = paidAgents[0];
    if (sampleAgent) {
      const balance = await getBalance(hedera, sampleAgent.accountId);
      step(balance.hbar > 0, `Agent ${sampleAgent.beneficiary} holds ${balance.hbar.toFixed(4)} HBAR`);
    }

    // ---- the public ledger ------------------------------------------------
    console.log('\n  Reading the ledger back ...');
    // open + close + settlement, plus one `settlement-chunk` per transfer.
    // The chunk messages were added by STEP 16's hardening and this count did
    // not follow, so a correct ledger was being reported as three events short.
    const expected =
      state.reports.length + state.timedOutAgents.length + 3 + receipts.length;
    let entries: Awaited<ReturnType<typeof readTopicMessages>> = [];
    for (let attempt = 1; attempt <= 12; attempt++) {
      await sleep(2500);
      entries = await readTopicMessages(cfg.network, market.topicId);
      if (entries.length >= expected) break;
    }
    console.log('');

    const types = entries.map((e) => e.message?.type);
    step(entries.length === expected, `Ledger holds all ${expected} events`, `got ${entries.length}`);
    step(types[0] === 'market-open', 'First message is market-open');
    // The tail is no longer close-then-settlement. STEP 16's hardening writes
    // one `settlement-chunk` message per transfer, recording how that chunk
    // ended, so a settlement that stops halfway can be resumed without paying
    // a chunk twice. This assertion predates that and was failing on correct
    // output: the chunk messages are the feature, not noise after it.
    const closeAt = types.indexOf('market-close');
    const tail = types.slice(closeAt);
    step(
      closeAt !== -1 &&
        tail[1] === 'settlement' &&
        tail.length > 2 &&
        tail.slice(2).every((t) => t === 'settlement-chunk'),
      'Ends with market-close, settlement, then one message per transfer chunk',
      types.slice(-4).join(' -> '),
    );
    step(
      entries.every((e) => e.parseError === undefined),
      'Every message parses against the schema',
    );
    step(
      entries.map((e) => e.sequenceNumber).join(',') ===
        entries.map((_, i) => i + 1).join(','),
      'Consensus order is intact',
    );

    console.log('\n' + '='.repeat(74));
    console.log(`  Market:   ${market.marketId}`);
    console.log(`  Topic:    ${hashscanUrl(cfg.network, 'topic', market.topicId)}`);
    console.log(`  Treasury: ${hashscanUrl(cfg.network, 'account', treasury.accountId)}`);
    console.log(`  Reports:  ${state.reports.length}   scored: ${settlement.payouts.filter((p) => p.kind === 'scored').length}   flat fee: ${settlement.payouts.filter((p) => p.kind === 'flat-fee').length}`);
    console.log(`  Asker net: ${tinybarToHbar(askerBefore.tinybar - (await getBalance(hedera, cfg.operatorId)).tinybar).toFixed(8)} HBAR spent`);
    console.log('='.repeat(74));
  } finally {
    apiServer.close();
    agentServer?.close();
    hedera.close();
  }

  console.log('');
  if (failures === 0) {
    console.log('ORCHESTRATOR OK — a full market ran and the books closed.\n');
  } else {
    console.log(`${failures} check(s) failed.\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n  Check failed:', e instanceof Error ? e.message : e, '\n');
  process.exit(1);
});
