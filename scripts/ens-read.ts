/**
 * Reads one agent's identity back out of ENS, the way a stranger would.
 *
 * No key, no gas, and deliberately no shortcut through our own resolver
 * address: the lookup walks `.eth` -> the parent -> our registry -> our
 * resolver through the universal resolver, which is the same path a wallet or
 * an explorer takes. If this prints the record, the name is really in ENS.
 *
 * Run:  pnpm ens:read agent-01
 */
import './load-env.js';
import { agentEnsName, readEnsAgent } from '@ethonline/ens';
import { readEnv } from '@ethonline/hedera';

async function main(): Promise<void> {
  const parent = readEnv(process.env, 'ENS_PARENT_NAME');
  if (!parent) {
    console.error('\n  ENS_PARENT_NAME is not set.\n');
    process.exit(1);
  }
  const arg = process.argv[2] ?? 'agent-01';
  const name = arg.includes('.') ? arg : agentEnsName(arg, parent);

  const profile = await readEnsAgent(name);
  console.log(`\n${name}`);
  console.log('='.repeat(66));
  console.log('  WRITTEN BY THE AGENT ITSELF');
  const own = Object.entries(profile.profile);
  if (own.length === 0) console.log('    (nothing yet)');
  for (const [k, v] of own) console.log(`    ${k.padEnd(16)} ${v}`);
  console.log('\n  WRITTEN BY THE ORCHESTRATOR — the agent cannot touch these');
  const record = Object.entries(profile.record);
  if (record.length === 0) console.log('    (nothing yet)');
  for (const [k, v] of record) console.log(`    ${k.padEnd(16)} ${v}`);
  console.log('='.repeat(66) + '\n');
}

main().catch((e) => {
  console.error(`\n  Read failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
