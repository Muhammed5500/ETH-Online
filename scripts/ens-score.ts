/**
 * Publishing every agent's record to ENS — ADIM 26, by hand.
 *
 * The API counts what each agent did across the markets it holds; this takes
 * that count and writes it onto the agent's own name, where it stops being
 * something you have to ask our server for.
 *
 * WHY A SCRIPT AND ALSO A HOOK. The server publishes a record after each
 * settlement, which keeps names current while it runs. This exists for the
 * other cases: a server that was restarted and has recounted, a record that
 * failed to land the first time, or a demo where somebody wants to see the
 * write happen. Both paths write the same absolute counts, so running this
 * after the hook has already run changes nothing.
 *
 * Run:  pnpm ens:score
 */
import './load-env.js';
import type { Address } from 'viem';
import {
  agentEnsName,
  formatAgentRecord,
  orchestratorSigner,
  writeAgentRecord,
} from '@ethonline/ens';
import { readEnv } from '@ethonline/hedera';

interface AgentRow {
  readonly agentId: string;
  readonly record?: {
    bonded: number;
    reported: number;
    reference: number;
    timedOut: number;
    net: number;
  };
}

async function main(): Promise<void> {
  const parent = readEnv(process.env, 'ENS_PARENT_NAME');
  const resolver = readEnv(process.env, 'ENS_RESOLVER_ADDRESS') as Address | undefined;
  const api = readEnv(process.env, 'API_URL') ?? 'http://127.0.0.1:4020';
  if (!parent || !resolver) {
    console.error('\n  ENS_PARENT_NAME and ENS_RESOLVER_ADDRESS must be set.\n');
    process.exit(1);
  }

  let agents: AgentRow[];
  try {
    const res = await fetch(`${api}/agents`);
    if (!res.ok) throw new Error(`GET /agents answered ${res.status}`);
    agents = ((await res.json()) as { agents: AgentRow[] }).agents;
  } catch (e) {
    console.error(`\n  Could not read ${api}/agents: ${(e as Error).message}`);
    console.error('  Start the API first; the counts come from the markets it holds.\n');
    process.exit(1);
  }

  const signer = orchestratorSigner();
  console.log('\nPUBLISHING AGENT RECORDS TO ENS');
  console.log('='.repeat(74));
  console.log(`  Source       ${api}/agents`);
  console.log(`  Parent       ${parent}`);
  console.log(`  Writing as   ${signer.address}`);
  console.log('='.repeat(74));

  let written = 0;
  let skipped = 0;
  let failed = 0;

  for (const agent of agents) {
    const counted = agent.record;
    // An agent that has never played has nothing to publish, and writing five
    // zeros would spend gas to say so.
    if (!counted || (counted.bonded === 0 && counted.reported === 0)) {
      skipped++;
      continue;
    }
    const name = agentEnsName(agent.agentId, parent);
    const result = await writeAgentRecord(signer, resolver, name, formatAgentRecord(counted));
    if (result.ok) {
      written++;
      console.log(
        `  ${agent.agentId}  markets=${counted.bonded} reports=${counted.reported} ` +
          `ref=${counted.reference} net=${counted.net.toFixed(6)}  ${result.txHash ?? ''}`,
      );
    } else {
      failed++;
      console.log(`  ${agent.agentId}  FAILED: ${result.error}`);
    }
  }

  console.log('='.repeat(74));
  console.log(`  ${written} written, ${skipped} had nothing to publish, ${failed} failed`);
  console.log(`  read one back: pnpm ens:read agent-01`);
  console.log('='.repeat(74) + '\n');
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`\n  Publishing failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
