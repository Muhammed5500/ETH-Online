/**
 * Creates the treasury and the agent pool on Hedera.
 *
 * This script spends real HBAR and creates accounts that cannot be deleted
 * without their keys, so it is built defensively:
 *
 *   - Idempotent. It reads `agents/accounts.json` and creates only what is
 *     missing. Running it twice does not produce forty accounts.
 *   - The ledger is written after EVERY account, not once at the end. An
 *     account whose key we failed to record is HBAR that is simply gone, and
 *     a crash at agent 19 must not cost the first 18 keys.
 *   - Network-checked. Account ids are not portable, so a testnet ledger is
 *     refused against any other network.
 *   - `--dry-run` prints the plan and the cost without touching the chain.
 *
 * Run:  pnpm setup:hedera
 *       pnpm setup:hedera --dry-run
 */
import './load-env.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  agentCountFromEnv,
  assertNetworkMatches,
  createAccount,
  createHederaClient,
  emptyAccountsFile,
  getBalance,
  hashscanUrl,
  hederaConfigFromEnv,
  missingAgentIds,
  parseAccountsFile,
  readEnv,
  serializeAccountsFile,
  setTreasury,
  upsertAgent,
  type AccountsFile,
} from '@ethonline/hedera';

const ACCOUNTS_PATH = join(import.meta.dirname, '..', 'agents', 'accounts.json');

/** Rough per-account creation fee on Hedera, used only for the safety margin. */
const CREATION_FEE_MARGIN_HBAR = 0.5;

function numberFromEnv(key: string, fallback: number): number {
  const raw = readEnv(process.env, key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${key} must be a positive number, got: ${raw}`);
  }
  return n;
}

function loadLedger(network: string): AccountsFile {
  let raw: string;
  try {
    raw = readFileSync(ACCOUNTS_PATH, 'utf-8');
  } catch {
    return emptyAccountsFile(network as AccountsFile['network']);
  }
  const file = parseAccountsFile(raw);
  assertNetworkMatches(file, network as AccountsFile['network']);
  return file;
}

/** Writes immediately. Called after every single creation, on purpose. */
function saveLedger(file: AccountsFile): void {
  mkdirSync(dirname(ACCOUNTS_PATH), { recursive: true });
  writeFileSync(ACCOUNTS_PATH, serializeAccountsFile(file), 'utf-8');
}

function line(width = 68): string {
  return '='.repeat(width);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const cfg = hederaConfigFromEnv();
  const agentCount = agentCountFromEnv();
  const treasuryFund = numberFromEnv('TREASURY_FUND_HBAR', 100);
  const agentFund = numberFromEnv('AGENT_FUND_HBAR', 10);

  let ledger = loadLedger(cfg.network);
  const needTreasury = ledger.treasury === undefined;
  const needAgents = missingAgentIds(ledger, agentCount);

  const toCreate = needAgents.length + (needTreasury ? 1 : 0);
  const hbarNeeded =
    (needTreasury ? treasuryFund : 0) +
    needAgents.length * agentFund +
    toCreate * CREATION_FEE_MARGIN_HBAR;

  console.log('');
  console.log(line());
  console.log('HEDERA ACCOUNT SETUP');
  console.log(line());
  console.log(`  Network:          ${cfg.network}`);
  console.log(`  Operator:         ${cfg.operatorId}`);
  console.log(`  Ledger:           agents/accounts.json`);
  console.log(`  Target pool:      ${agentCount} agents (AGENT_COUNT)`);
  console.log('');
  console.log(`  Already present:  ${ledger.agents.length} agents` + (ledger.treasury ? ' + treasury' : ''));
  console.log(`  To create:        ${needAgents.length} agents` + (needTreasury ? ' + treasury' : ''));
  console.log(`  Funding:          ${agentFund} HBAR/agent, ${treasuryFund} HBAR treasury`);
  console.log(`  Estimated spend:  ~${hbarNeeded.toFixed(2)} HBAR`);
  console.log(line());

  if (toCreate === 0) {
    console.log('\n  Nothing to do — the pool is already complete.\n');
    printSummary(ledger, cfg.network);
    return;
  }

  const client = createHederaClient(cfg);
  try {
    const balance = await getBalance(client, cfg.operatorId);
    console.log(`\n  Operator balance: ${balance.hbar.toFixed(4)} HBAR`);

    if (balance.hbar < hbarNeeded) {
      console.error(
        `\n  Not enough HBAR. Need ~${hbarNeeded.toFixed(2)}, have ${balance.hbar.toFixed(2)}.` +
          `\n  Top up the operator, or lower AGENT_FUND_HBAR / TREASURY_FUND_HBAR.\n`,
      );
      process.exit(1);
    }

    if (dryRun) {
      console.log('\n  --dry-run: nothing was created. Plan:');
      if (needTreasury) console.log(`    treasury          ${treasuryFund} HBAR`);
      for (const id of needAgents) console.log(`    ${id}          ${agentFund} HBAR`);
      console.log('');
      return;
    }

    if (needTreasury) {
      process.stdout.write('\n  Creating treasury ... ');
      const acct = await createAccount(client, {
        initialBalanceHbar: treasuryFund,
        memo: 'ethonline treasury',
      });
      ledger = setTreasury(ledger, { agentId: 'treasury', ...acct });
      saveLedger(ledger); // written before anything else can fail
      console.log(`${acct.accountId}`);
    }

    for (const [i, agentId] of needAgents.entries()) {
      process.stdout.write(`  Creating ${agentId} (${i + 1}/${needAgents.length}) ... `);
      const acct = await createAccount(client, {
        initialBalanceHbar: agentFund,
        memo: `ethonline ${agentId}`,
      });
      ledger = upsertAgent(ledger, { agentId, ...acct });
      saveLedger(ledger); // one account, one write
      console.log(`${acct.accountId}`);
    }

    console.log('');
    printSummary(ledger, cfg.network);

    if (needTreasury && ledger.treasury) {
      console.log('  Add these to .env so the API can sign as the treasury:\n');
      console.log(`    HEDERA_TREASURY_ID=${ledger.treasury.accountId}`);
      console.log(`    HEDERA_TREASURY_KEY=${ledger.treasury.privateKey}\n`);
    }
  } finally {
    client.close();
  }
}

function printSummary(ledger: AccountsFile, network: string): void {
  console.log(line());
  console.log('POOL');
  console.log(line());
  if (ledger.treasury) {
    console.log(`  treasury   ${ledger.treasury.accountId}`);
    console.log(`             ${hashscanUrl(network, 'account', ledger.treasury.accountId)}`);
  }
  for (const a of ledger.agents) {
    console.log(`  ${a.agentId}   ${a.accountId}`);
  }
  console.log('');
  console.log(`  ${ledger.agents.length} agents on ${network}.`);
  console.log(`  Keys are in agents/accounts.json — gitignored, never commit it.`);
  console.log(line());
  console.log('');
}

main().catch((e) => {
  console.error('\n  Setup failed:', e instanceof Error ? e.message : e);
  console.error('  Accounts created so far are saved in agents/accounts.json.');
  console.error('  Re-running creates only what is still missing.\n');
  process.exit(1);
});
