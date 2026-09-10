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
import { createPaymentGate } from './payment.js';
import { MarketStore } from './store.js';
import { formatTinybar, depositTinybar, bondTinybar } from './pricing.js';

const PORT = Number(readEnv(process.env, 'API_PORT') ?? 4020);

function main(): void {
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

  const paymentGate = createPaymentGate({
    treasuryAccountId: treasury.accountId,
    facilitatorUrl,
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
    console.log(`  Facilitator:   ${facilitatorUrl}`);
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

main();
