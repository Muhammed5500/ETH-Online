/**
 * Verifies the agent pool against the chain.
 *
 * `setup-hedera-accounts` says what it created. This says what actually
 * exists: every account in the ledger is read back from Hedera and its balance
 * compared with what we believe we funded. It is the evidence for the STEP 12
 * gate, and it stays useful afterwards as a pre-demo check that the pool is
 * still solvent.
 *
 * Read-only. It never creates or moves anything.
 *
 * Run:  pnpm check:accounts
 */
import './load-env.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentCountFromEnv,
  assertNetworkMatches,
  createHederaClient,
  getBalance,
  hashscanUrl,
  hederaConfigFromEnv,
  missingAgentIds,
  parseAccountsFile,
  readEnv,
  treasuryFromEnv,
} from '@ethonline/hedera';

const ACCOUNTS_PATH = join(import.meta.dirname, '..', 'agents', 'accounts.json');

let failures = 0;

function step(ok: boolean, name: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (detail) console.log(`         ${detail}`);
}

async function main(): Promise<void> {
  console.log('\nAGENT POOL CHECK\n' + '='.repeat(68));

  const cfg = hederaConfigFromEnv();
  const agentCount = agentCountFromEnv();
  const expectedAgentHbar = Number(readEnv(process.env, 'AGENT_FUND_HBAR') ?? 10);

  const file = parseAccountsFile(readFileSync(ACCOUNTS_PATH, 'utf-8'));
  assertNetworkMatches(file, cfg.network);
  step(true, `Ledger parsed and network matches (${cfg.network})`);

  const missing = missingAgentIds(file, agentCount);
  step(
    missing.length === 0,
    `Pool is complete: ${file.agents.length}/${agentCount} agents`,
    missing.length ? `missing: ${missing.join(', ')}` : '',
  );

  step(file.treasury !== undefined, 'Treasury exists in the ledger', file.treasury?.accountId ?? '');

  const envTreasury = treasuryFromEnv();
  step(
    envTreasury?.accountId === file.treasury?.accountId,
    'HEDERA_TREASURY_ID in .env matches the ledger',
    envTreasury ? `.env: ${envTreasury.accountId}` : '.env treasury is empty — copy it from the setup output',
  );

  const ids = file.agents.map((a) => a.accountId);
  step(new Set(ids).size === ids.length, 'No two agents share an account id');
  const keys = file.agents.map((a) => a.privateKey);
  step(new Set(keys).size === keys.length, 'No two agents share a private key');

  const client = createHederaClient(cfg);
  try {
    console.log('\n  Reading balances from the chain ...\n');

    let poolTotal = 0;
    let underfunded = 0;

    if (file.treasury) {
      const b = await getBalance(client, file.treasury.accountId);
      poolTotal += b.hbar;
      console.log(`    treasury   ${file.treasury.accountId.padEnd(14)} ${b.hbar.toFixed(4)} HBAR`);
    }

    for (const a of file.agents) {
      const b = await getBalance(client, a.accountId);
      poolTotal += b.hbar;
      const ok = b.hbar >= expectedAgentHbar;
      if (!ok) underfunded++;
      console.log(
        `    ${a.agentId}   ${a.accountId.padEnd(14)} ${b.hbar.toFixed(4)} HBAR${ok ? '' : '   UNDERFUNDED'}`,
      );
    }

    console.log('');
    step(
      underfunded === 0,
      `Every agent holds at least ${expectedAgentHbar} HBAR`,
      underfunded ? `${underfunded} agent(s) below target` : '',
    );

    const operator = await getBalance(client, cfg.operatorId);
    console.log(`\n  Pool holds:       ${poolTotal.toFixed(4)} HBAR`);
    console.log(`  Operator holds:   ${operator.hbar.toFixed(4)} HBAR`);
    if (file.treasury) {
      console.log(`\n  Treasury on HashScan: ${hashscanUrl(cfg.network, 'account', file.treasury.accountId)}`);
    }
  } finally {
    client.close();
  }

  console.log('\n' + '='.repeat(68));
  if (failures === 0) {
    console.log('POOL OK — every account in the ledger exists on chain and is funded.\n');
  } else {
    console.log(`${failures} check(s) failed.\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n  Check failed:', e instanceof Error ? e.message : e, '\n');
  process.exit(1);
});
