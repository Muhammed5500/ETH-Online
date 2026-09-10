/**
 * End-to-end check of the x402-gated API — the STEP 15 gate.
 *
 * Starts the real server in-process against Hedera testnet and drives it with
 * a real paying client. Money actually moves: the treasury balance is read
 * before and after and has to have grown by exactly what was charged.
 *
 * Covers every acceptance criterion for the step:
 *   unpaid request is refused with 402
 *   paid request runs the business logic
 *   POST /market creates a real market and a real HCS topic
 *   POST /market/:id/bond puts an agent in the pool
 *   an underfunded market cannot be opened
 *
 * The bond is paid by agent-01 out of `agents/accounts.json`, not by the
 * operator, so the per-agent payment path is exercised rather than assumed.
 *
 * Run:  pnpm check:api
 */
import '@ethonline/env';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch';
import {
  createClientHederaSigner,
  ExactHederaScheme,
  HBAR_ASSET_ID,
  HEDERA_TESTNET_CAIP2,
  PrivateKey,
} from '@x402/hedera';
import { DEFAULT_PARAMS } from '@ethonline/core';
import {
  createHederaClient,
  getBalance,
  hashscanUrl,
  hederaConfigFromEnv,
  parseAccountsFile,
  treasuryFromEnv,
} from '@ethonline/hedera';
import { createApp, DEFAULT_API_CONFIG } from '../apps/api/src/app.js';
import { hederaLedger } from '../apps/api/src/ledger.js';
import { createPaymentGate } from '../apps/api/src/payment.js';
import { MarketStore } from '../apps/api/src/store.js';
import { bondTinybar, depositTinybar, formatTinybar, tinybarToHbar } from '../apps/api/src/pricing.js';

const PORT = 4055;
const BASE = `http://localhost:${PORT}`;

let failures = 0;
function step(ok: boolean, name: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (detail) console.log(`         ${detail}`);
}

/** A paying fetch for one Hedera account. */
function payingFetch(accountId: string, privateKey: string, ceilingTinybar: bigint) {
  const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(privateKey), {
    network: HEDERA_TESTNET_CAIP2,
  });
  const client = x402Client.fromConfig({
    schemes: [{ network: HEDERA_TESTNET_CAIP2, client: new ExactHederaScheme(signer) }],
    // SPIKE A trap: HBAR is not a "default asset", so without this every
    // payment is refused client-side before it is ever attempted.
    spendControls: {
      allowedAssets: [
        {
          network: HEDERA_TESTNET_CAIP2,
          asset: HBAR_ASSET_ID,
          maxAmountPerPayment: ceilingTinybar.toString(),
        },
      ],
    },
  });
  return wrapFetchWithPayment(fetch, client);
}

/**
 * Reads the 402 challenge.
 *
 * FOURTH TRAP, found in STEP 15 alongside SPIKE A's three: the challenge is
 * NOT in the response body. The body is `{}`; the payment requirements arrive
 * base64-encoded in a `payment-required` header. Reading the body makes a
 * correctly-priced 402 look like an empty one.
 */
function challengeOf(res: Response): { accepts?: Array<{ amount?: string }> } | undefined {
  const header = res.headers.get('payment-required');
  if (!header) return undefined;
  return JSON.parse(Buffer.from(header, 'base64').toString('utf-8')) as {
    accepts?: Array<{ amount?: string }>;
  };
}

function settlementOf(res: Response): Record<string, unknown> | undefined {
  // SPIKE A trap: the header is `payment-response`, NOT `x-payment-response`.
  // Reading the wrong name returns nothing and looks exactly like a failure,
  // while the payment has in fact settled.
  const header = res.headers.get('payment-response');
  if (!header) return undefined;
  return decodePaymentResponseHeader(header) as Record<string, unknown>;
}

async function main(): Promise<void> {
  console.log('\nx402 API CHECK\n' + '='.repeat(72));

  const cfg = hederaConfigFromEnv();
  const treasury = treasuryFromEnv();
  if (!treasury) throw new Error('HEDERA_TREASURY_ID / HEDERA_TREASURY_KEY are empty in .env');

  const accounts = parseAccountsFile(
    readFileSync(join(import.meta.dirname, '..', 'agents', 'accounts.json'), 'utf-8'),
  );
  const agent = accounts.agents[0];
  if (!agent) throw new Error('No agents in accounts.json — run `pnpm setup:hedera` first.');

  const hedera = createHederaClient(cfg);
  const markets = new MarketStore();
  const gate = createPaymentGate({
    treasuryAccountId: treasury.accountId,
    facilitatorUrl: process.env['BLOCKY402_FACILITATOR_URL'] || 'https://api.testnet.blocky402.com',
    markets,
    defaultParams: DEFAULT_PARAMS,
    hbarPerUnit: DEFAULT_API_CONFIG.hbarPerUnit,
  });
  const { app } = createApp({
    ledger: hederaLedger(hedera),
    markets,
    paymentGate: gate,
    config: { network: cfg.network },
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(PORT, () => resolve(s));
  });
  console.log(`  Server on ${BASE}, treasury ${treasury.accountId}\n`);

  try {
    const expectedDeposit = depositTinybar(DEFAULT_PARAMS, [0.5, 0.5]);
    const expectedBond = bondTinybar(DEFAULT_PARAMS);
    const treasuryBefore = await getBalance(hedera, treasury.accountId);

    // ---- 1. unpaid request ---------------------------------------------
    const unpaid = await fetch(`${BASE}/market`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Is this protocol growth organic?' }),
    });
    const challenge = challengeOf(unpaid);
    step(unpaid.status === 402, 'Unpaid POST /market is refused with 402', `status ${unpaid.status}`);
    step(
      challenge?.accepts?.[0]?.amount === expectedDeposit.toString(),
      'The 402 quotes exactly the deposit bound b·H(prior) + k·R',
      `quoted ${challenge?.accepts?.[0]?.amount}, expected ${expectedDeposit} (${formatTinybar(expectedDeposit)})`,
    );

    // ---- 2. paid request ------------------------------------------------
    const askerFetch = payingFetch(cfg.operatorId, cfg.operatorKey, 500_000_000n);
    console.log('\n  Paying for a market ...');
    const paid = await askerFetch(`${BASE}/market`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Is this protocol growth organic?' }),
    });
    const market = (await paid.json()) as { marketId: string; topicId: string; depositTinybar: string };

    step(paid.status === 201, 'Paid POST /market runs the business logic', `status ${paid.status}`);
    step(!!market.marketId && !!market.topicId, 'A real market and HCS topic were created', `${market.marketId} on topic ${market.topicId}`);
    step(market.depositTinybar === expectedDeposit.toString(), 'Charged amount equals the quoted deposit');

    const settlement = settlementOf(paid);
    step(settlement?.['success'] === true, 'Settlement came back on the payment-response header', JSON.stringify(settlement ?? {}).slice(0, 160));

    // ---- 3. register and bond -------------------------------------------
    const publicKey = PrivateKey.fromStringECDSA(agent.privateKey).publicKey.toStringDer();
    const reg = await fetch(`${BASE}/agents/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: agent.agentId, accountId: agent.accountId, publicKey }),
    });
    step(reg.status === 201, 'Agent registration is open and needs no payment', `status ${reg.status}`);

    const bondUnpaid = await fetch(`${BASE}/market/${market.marketId}/bond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: agent.agentId }),
    });
    step(bondUnpaid.status === 402, 'Unpaid bond is refused with 402', `status ${bondUnpaid.status}`);
    step(
      challengeOf(bondUnpaid)?.accepts?.[0]?.amount === expectedBond.toString(),
      'The bond 402 quotes the bond amount for this market',
      `quoted ${challengeOf(bondUnpaid)?.accepts?.[0]?.amount}, expected ${expectedBond}`,
    );

    console.log('\n  Agent paying its bond ...');
    const agentFetch = payingFetch(agent.accountId, agent.privateKey, 200_000_000n);
    const bonded = await agentFetch(`${BASE}/market/${market.marketId}/bond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: agent.agentId }),
    });
    const bondBody = (await bonded.json()) as { bondedCount: number; position: unknown };
    step(bonded.status === 201, 'Paid bond puts the agent in the pool', `bondedCount ${bondBody.bondedCount}`);
    step(bondBody.position === null, 'The bond response does NOT reveal a position');
    step(settlementOf(bonded)?.['success'] === true, 'Bond payment settled on chain');

    // ---- 4. underfunded market ------------------------------------------
    console.log('\n  Trying to open a market with a ceiling below the deposit ...');
    const stingy = payingFetch(cfg.operatorId, cfg.operatorKey, expectedDeposit - 1n);
    let refused = false;
    try {
      const res = await stingy(`${BASE}/market`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'underfunded' }),
      });
      refused = res.status !== 201;
    } catch {
      // The client refuses to pay above its ceiling, which is the same outcome.
      refused = true;
    }
    step(refused, 'A market cannot be opened without covering the deposit');

    // ---- 5. the money actually moved ------------------------------------
    const treasuryAfter = await getBalance(hedera, treasury.accountId);
    const gained = treasuryAfter.tinybar - treasuryBefore.tinybar;
    step(
      gained === expectedDeposit + expectedBond,
      'Treasury received exactly the deposit plus the bond',
      `+${tinybarToHbar(gained).toFixed(8)} HBAR (expected ${tinybarToHbar(expectedDeposit + expectedBond).toFixed(8)})`,
    );

    console.log('\n' + '='.repeat(72));
    console.log(`  Market:   ${market.marketId}`);
    console.log(`  Topic:    ${hashscanUrl(cfg.network, 'topic', market.topicId)}`);
    console.log(`  Treasury: ${hashscanUrl(cfg.network, 'account', treasury.accountId)}`);
    console.log('='.repeat(72));
  } finally {
    server.close();
    hedera.close();
  }

  console.log('');
  if (failures === 0) {
    console.log('API OK — paid endpoints charge the right amount and the money arrives.\n');
  } else {
    console.log(`${failures} check(s) failed.\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n  Check failed:', e instanceof Error ? e.message : e, '\n');
  process.exit(1);
});
