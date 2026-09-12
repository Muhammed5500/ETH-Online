/**
 * Server bootstrap.
 *
 * The only place that reaches for the network, the environment and the
 * facilitator. `createApp` stays free of all three so the routes can be tested
 * without any of them.
 *
 * Run:  pnpm api
 */
import '@ethonline/env';
import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHederaClient,
  hederaConfigFromEnv,
  readEnv,
  treasuryFromEnv,
} from '@ethonline/hedera';
import { createApp, DEFAULT_API_CONFIG } from './app.js';
import { hederaLedger } from './ledger.js';
import { Orchestrator } from './orchestrator.js';
import { MarketRunner } from './runner.js';
import { buildRefundPlan, chunkPlan } from './settlement-plan.js';
import { hederaPayer, httpAgentTransport } from './transport.js';
import {
  createPaymentGate,
  DEFAULT_FACILITATOR_TIMEOUT_MS,
  warmUpFacilitator,
} from './payment.js';
import { MarketStore, type StoredMarket } from './store.js';
import { formatTinybar, depositTinybar, bondTinybar } from './pricing.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = resolve(HERE, '..', '..', 'web', 'dist');

/**
 * The paths the API owns. Everything else that arrives as a GET is a page.
 *
 * The frontend deliberately does not use these names for its own routes — see
 * `apps/web/src/lib/api.ts` — because moving the API would mean re-verifying
 * the x402 gate against paths nothing has tested.
 */
const API_PREFIXES = ['/market', '/markets', '/agents', '/health', '/resolve'];

const PORT = Number(readEnv(process.env, 'API_PORT') ?? 4020);

async function main(): Promise<void> {
  const cfg = hederaConfigFromEnv();
  const treasury = treasuryFromEnv();
  if (!treasury) {
    console.error(
      '\n  HEDERA_TREASURY_ID and HEDERA_TREASURY_KEY are empty.' +
        '\n  Run `pnpm setup:hedera` and copy the two lines it prints into .env.\n',
    );
    process.exit(1);
  }

  const facilitatorUrl =
    readEnv(process.env, 'BLOCKY402_FACILITATOR_URL') ?? 'https://api.testnet.blocky402.com';
  const hbarPerUnit = Number(readEnv(process.env, 'HBAR_PER_UNIT') ?? DEFAULT_API_CONFIG.hbarPerUnit);

  const client = createHederaClient(cfg);
  const markets = new MarketStore();

  // Connect to the facilitator before taking traffic. The first outbound
  // connection of a cold process is the slowest one it will make, and letting
  // the first paying customer absorb that is the wrong trade.
  const warm = await warmUpFacilitator(facilitatorUrl);

  const paymentGate = createPaymentGate({
    treasuryAccountId: treasury.accountId,
    facilitatorUrl,
    facilitatorTimeoutMs: Number(
      readEnv(process.env, 'FACILITATOR_TIMEOUT_MS') ?? DEFAULT_FACILITATOR_TIMEOUT_MS,
    ),
    markets,
    defaultParams: DEFAULT_API_CONFIG.defaultParams,
    hbarPerUnit,
  });

  const { app, config, registry } = createApp({
    ledger: hederaLedger(client),
    markets,
    paymentGate,
    config: { network: cfg.network, hbarPerUnit },
  });

  // ---- the thing that actually runs a market ----------------------------
  //
  // Until this existed, a market opened through the API stayed at `bonding`
  // forever unless a script drove it by hand. Rounds, settlement and the
  // refund for a market that never filled all happen here now, in the process
  // that took the money.
  const payer = hederaPayer({
    client,
    treasuryAccountId: treasury.accountId,
    treasuryKey: treasury.privateKey,
  });

  const orchestrator = new Orchestrator({
    markets,
    registry,
    ledger: hederaLedger(client),
    transport: httpAgentTransport(),
    payer,
    hbarPerUnit,
    // An agent with three slices runs three Graph queries and then waits on a
    // model. Sixty seconds would make a slow query look like a silent agent,
    // and a silent agent loses its whole bond.
    reportTimeoutMs: Number(readEnv(process.env, 'REPORT_TIMEOUT_MS') ?? 120_000),
    onEvent: (event, detail) => console.log(`  [${event}]`, JSON.stringify(detail)),
  });

  const refund = async (stored: StoredMarket): Promise<void> => {
    if (!stored.askerAccountId) {
      console.warn(
        `  [refund-skipped] ${stored.id} was opened without an askerAccountId; ` +
          `the deposit and ${stored.bonds.size} bond(s) stay in the treasury.`,
      );
      return;
    }
    const bondAccounts = new Map<string, string>();
    for (const [agentId, record] of stored.bonds) bondAccounts.set(agentId, record.accountId);
    const plan = buildRefundPlan({
      marketId: stored.id,
      bondAccounts,
      bondTinybar: stored.bondTinybar,
      depositTinybar: stored.depositTinybar,
      askerAccountId: stored.askerAccountId,
    });
    for (const [i, lines] of chunkPlan(plan, 9).entries()) {
      const receipt = await payer.send(lines, `${stored.id} refund ${i + 1}`);
      console.log(`  [refunded] ${stored.id} chunk ${i + 1}: ${receipt.transactionId}`);
    }
  };

  const runner = new MarketRunner({
    markets,
    orchestrator,
    refund,
    onEvent: (event, detail) => console.log(`  [${event}]`, JSON.stringify(detail)),
  });
  runner.start(Number(readEnv(process.env, 'RUNNER_INTERVAL_MS') ?? 3000));

  // ---- the frontend, when it has been built ------------------------------
  //
  // Served from here so the pages and the paid API share an origin: the wallet
  // pays the same host the page came from, and nothing in the payment path
  // crosses origins. A plain middleware rather than a route pattern, because
  // Express 5 hands catch-alls to path-to-regexp and that syntax fight is not
  // worth three lines of JavaScript.
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      if (API_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
      return res.sendFile(join(WEB_DIST, 'index.html'));
    });
  }

  const deposit = depositTinybar(config.defaultParams, [0.5, 0.5], hbarPerUnit);
  const bond = bondTinybar(config.defaultParams, hbarPerUnit);

  app.listen(PORT, () => {
    console.log('\nethonline API');
    console.log('='.repeat(60));
    console.log(`  Port:          ${PORT}`);
    console.log(`  Network:       ${cfg.network}`);
    console.log(`  Treasury:      ${treasury.accountId}`);
    console.log(
      `  Facilitator:   ${facilitatorUrl}  ` +
        (warm.ok ? `(reachable, ${warm.ms}ms)` : `(UNREACHABLE: ${warm.error ?? 'unknown'})`),
    );
    if (!warm.ok) {
      console.log('                 Paid routes will answer 503 until it recovers.');
      console.log('                 Reads and agent registration still work.');
    }
    console.log('');
    console.log(`  Open a market: ${formatTinybar(deposit)}  (default params)`);
    console.log(`  Post a bond:   ${formatTinybar(bond)}`);
    console.log('='.repeat(60));
    console.log(
      `  Web:           ${existsSync(WEB_DIST) ? `http://127.0.0.1:${PORT}` : 'not built — run `pnpm --filter @ethonline/web build`'}`,
    );
    console.log(
      `  Runner:        polling every ${readEnv(process.env, 'RUNNER_INTERVAL_MS') ?? 3000}ms`,
    );
    console.log('\n  Paid:   POST /market, POST /market/:id/bond, POST /resolve');
    console.log('  Signed: POST /market/:id/report');
    console.log('  Open:   GET /markets, GET /market/:id, /agents, POST /agents/register\n');
  });

  const shutdown = (): void => {
    runner.stop();
    client.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(`
  API failed to start: ${e instanceof Error ? e.message : String(e)}
`);
  process.exit(1);
});
