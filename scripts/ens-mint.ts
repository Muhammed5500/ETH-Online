/**
 * One ENS name per agent, owned by the key that signs its reports — ADIM 25.
 *
 * WHAT MAKES THIS MORE THAN A LABEL. The owner of `agent-07.<parent>.eth` is
 * the EVM address derived from agent-07's Hedera key: the same key that pays
 * its bond, signs its reports and receives its settlement. Nothing bridges the
 * two chains and no table maps one to the other — it is one key with two
 * addresses, and anybody can check that for themselves.
 *
 * WHAT EACH NAME GETS, AND WHAT IT DOES NOT. Registry roles: none, per
 * `docs/ens-role-schema.md` and proven on chain by `pnpm ens:spike`. The agent
 * owns the token and can do nothing to the name itself — above all it cannot
 * repoint its resolver, which is what would let it write its own score.
 *
 * Resolver roles: one per profile key, granted individually. The agent may
 * describe itself. It may not describe its performance; those keys are written
 * here and by `ens-score.ts`, and an attempt from the agent reverts.
 *
 * IDEMPOTENT, AND THAT MATTERS AT TWENTY NAMES. A name that already exists is
 * left alone. Re-running after a failure at name fourteen mints the last six
 * and costs nothing for the first thirteen.
 *
 * Run:  pnpm ens:mint
 */
import './load-env.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeFunctionData, namehash, parseAbi, type Address } from 'viem';
import {
  AGENT_NAME_TTL_SECONDS,
  AGENT_ROLE_BITMAP,
  AGENT_WRITABLE_KEYS,
  evmAddressFromKey,
  orchestratorSigner,
} from '@ethonline/ens';
import { buildAgentPool } from '@ethonline/agent';
import { parseAccountsFile, readEnv } from '@ethonline/hedera';

const REGISTRY_ABI = parseAbi([
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)',
  'function findOwner(string label) view returns (address)',
]);

const RESOLVER_ABI = parseAbi([
  'function authorizeTextRoles(bytes toName, string key, address account, bool grant) returns (bool)',
  'function setText(bytes32 node, string key, string value)',
  'function multicall(bytes[] data) returns (bytes[])',
]);

const ZERO = '0x0000000000000000000000000000000000000000' as const;

/** DNS wire format, which the resolver's name-taking functions expect. */
function dnsEncode(name: string): `0x${string}` {
  let out = '';
  for (const part of name.split('.').filter((p) => p.length > 0)) {
    out += part.length.toString(16).padStart(2, '0');
    out += Buffer.from(part, 'utf-8').toString('hex');
  }
  return `0x${out}00`;
}

async function main(): Promise<void> {
  const parent = readEnv(process.env, 'ENS_PARENT_NAME');
  const registry = readEnv(process.env, 'ENS_USER_REGISTRY_ADDRESS') as Address | undefined;
  const resolver = readEnv(process.env, 'ENS_RESOLVER_ADDRESS') as Address | undefined;
  if (!parent || !registry || !resolver) {
    console.error('\n  Run `pnpm ens:parent` and `pnpm ens:registry` first.\n');
    process.exit(1);
  }

  const { address: orch, wallet, publicClient } = orchestratorSigner();
  const account = wallet.account!;

  const accounts = parseAccountsFile(
    readFileSync(join(import.meta.dirname, '..', 'agents', 'accounts.json'), 'utf-8'),
  );
  // The same assignment the fleet uses, so the slices published on chain are
  // the slices the agent actually reads. Deriving them here independently
  // would be two sources of truth for one fact.
  const pool = buildAgentPool(accounts.agents);

  console.log('\nENS AGENT NAMES');
  console.log('='.repeat(78));
  console.log(`  Parent       ${parent}`);
  console.log(`  Registry     ${registry}`);
  console.log(`  Resolver     ${resolver}`);
  console.log(`  Minting as   ${orch}`);
  console.log('='.repeat(78));

  let minted = 0;
  let skipped = 0;
  const expiry = BigInt(Math.floor(Date.now() / 1000)) + AGENT_NAME_TTL_SECONDS;

  for (const config of pool) {
    const label = config.id;
    const fullName = `${label}.${parent}`;
    const owner = evmAddressFromKey(config.privateKey);

    const existing = await publicClient.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: 'findOwner',
      args: [label],
    });

    if (existing !== ZERO) {
      const mine = existing.toLowerCase() === owner.toLowerCase();
      console.log(`  ${label}  ${fullName.padEnd(34)} ${mine ? 'already minted' : `OWNED BY SOMEONE ELSE: ${existing}`}`);
      skipped++;
      if (!mine) process.exitCode = 1;
      continue;
    }

    const { request } = await publicClient.simulateContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: 'register',
      args: [label, owner, ZERO, resolver, AGENT_ROLE_BITMAP, expiry],
      account,
    });
    const mintHash = await wallet.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    // One transaction for the whole record setup: five per-key grants to the
    // agent, then the records only we may write. Twenty agents at seven
    // transactions each would be a hundred and forty; batching makes it forty.
    const node = namehash(fullName);
    const calls: `0x${string}`[] = [
      ...AGENT_WRITABLE_KEYS.map((key) =>
        encodeFunctionData({
          abi: RESOLVER_ABI,
          functionName: 'authorizeTextRoles',
          args: [dnsEncode(fullName), key, owner, true],
        }),
      ),
      encodeFunctionData({
        abi: RESOLVER_ABI,
        functionName: 'setText',
        args: [node, 'hedera.account', config.accountId],
      }),
      encodeFunctionData({
        abi: RESOLVER_ABI,
        functionName: 'setText',
        args: [node, 'slices', [...config.sliceIds].join(',')],
      }),
    ];
    const { request: batch } = await publicClient.simulateContract({
      address: resolver,
      abi: RESOLVER_ABI,
      functionName: 'multicall',
      args: [calls],
      account,
    });
    const recordHash = await wallet.writeContract(batch);
    await publicClient.waitForTransactionReceipt({ hash: recordHash });

    minted++;
    console.log(
      `  ${label}  ${fullName.padEnd(34)} -> ${owner}  ${config.sliceIds.join('+')}`,
    );
  }

  const gasLeft = await publicClient.getBalance({ address: orch });
  console.log('='.repeat(78));
  console.log(`  ${minted} minted, ${skipped} already there`);
  console.log(`  gas left     ${Number(gasLeft) / 1e18} ETH`);
  console.log(`  registry     https://sepolia.etherscan.io/address/${registry}`);
  console.log('='.repeat(78) + '\n');
}

main().catch((e) => {
  console.error(`\n  Minting failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
