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
import {
  createHederaClient,
  hederaConfigFromEnv,
  readEnv,
  treasuryFromEnv,
} from '@ethonline/hedera';
import { createApp, DEFAULT_API_CONFIG } from './app.js';
import { hederaLedger } from './ledger.js';
import {
  createPaymentGate,
  DEFAULT_FACILITATOR_TIMEOUT_MS,
  warmUpFacilitator,
} from './payment.js';
import { MarketStore } from './store.js';
import { formatTinybar, depositTinybar, bondTinybar } from './pricing.js';

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

  const { app, config } = createApp({
    ledger: hederaLedger(client),
    markets,
    paymentGate,
    config: { network: cfg.network, hbarPerUnit },
  });

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
    console.log('\n  Paid:   POST /market, POST /market/:id/bond, POST /resolve');
    console.log('  Signed: POST /market/:id/report');
    console.log('  Open:   GET /markets, GET /market/:id, /agents, POST /agents/register\n');
  });

  const shutdown = (): void => {
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
