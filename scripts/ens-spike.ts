/**
 * Proving the role schema on ONE name before twenty are minted — the ADIM 23 gate.
 *
 * WHY THIS SCRIPT EXISTS AT ALL. In ENSv2 a name's admin roles can only be
 * granted at registration. There is no correcting them afterwards, only
 * unregistering and starting again. `docs/ens-role-schema.md` argues for a
 * particular bitmap; an argument is not evidence, and twenty names minted
 * against a wrong argument is twenty names to redo.
 *
 * So one throwaway name is minted with exactly the bitmap the schema
 * specifies, and the four claims that schema makes are put to the chain:
 *
 *   1. the owner cannot repoint its resolver      (or it could write its own score)
 *   2. the owner cannot transfer the name         (identity is bound to the key)
 *   3. per-key authority really is per-key        (profile yes, score no)
 *   4. the 90-day expiry is what the registry recorded
 *
 * HOW EACH IS TESTED. The positive cases are sent for real, because a record
 * that exists is the proof. The negative cases are simulated: a simulation
 * runs against the same state the transaction would, so a revert in it is the
 * revert — and paying gas to watch a transaction fail proves nothing extra.
 *
 * Run:  pnpm ens:spike
 */
import './load-env.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createWalletClient,
  encodeFunctionData,
  http,
  namehash,
  parseAbi,
  parseEther,
  toHex,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AGENT_NAME_TTL_SECONDS,
  AGENT_ROLE_BITMAP,
  ensChain,
  evmAddressFromKey,
  orchestratorSigner,
  sepoliaRpcUrl,
  toEvmPrivateKey,
} from '@ethonline/ens';
import { parseAccountsFile, readEnv } from '@ethonline/hedera';

const REGISTRY_ABI = parseAbi([
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)',
  'function findTokenId(string label) view returns (uint256)',
  'function findOwner(string label) view returns (address)',
  'function getExpiry(uint256 anyId) view returns (uint64)',
  'function setResolver(uint256 anyId, address resolver)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
]);

const RESOLVER_ABI = parseAbi([
  'function authorizeTextRoles(bytes toName, string key, address account, bool grant) returns (bool)',
  'function setText(bytes32 node, string key, string value)',
  'function text(bytes32 node, string key) view returns (string)',
]);

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const SPIKE_LABEL = readEnv(process.env, 'ENS_SPIKE_LABEL') ?? 'spike-01';

let failures = 0;
function check(ok: boolean, name: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (detail) console.log(`         ${detail}`);
}

/** DNS wire format, which is what the resolver's name-taking functions expect. */
function dnsEncode(name: string): `0x${string}` {
  const parts = name.split('.').filter((p) => p.length > 0);
  let out = '';
  for (const part of parts) {
    out += part.length.toString(16).padStart(2, '0');
    out += Buffer.from(part, 'utf-8').toString('hex');
  }
  return `0x${out}00`;
}

/** Did this call revert? The negative cases are only interesting if they do. */
async function reverts(fn: () => Promise<unknown>): Promise<{ reverted: boolean; message: string }> {
  try {
    await fn();
    return { reverted: false, message: 'it succeeded' };
  } catch (e) {
    const message = (e as Error).message.split('\n')[0] ?? 'reverted';
    return { reverted: true, message };
  }
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

  // The test agent is a real agent key: the point is that a Hedera key can own
  // an ENS name and act on it, so borrowing one proves more than a fresh key.
  const accounts = parseAccountsFile(
    readFileSync(join(import.meta.dirname, '..', 'agents', 'accounts.json'), 'utf-8'),
  );
  const testAgent = accounts.agents[accounts.agents.length - 1]!;
  const agentAddress = evmAddressFromKey(testAgent.privateKey);
  const agentWallet = createWalletClient({
    account: privateKeyToAccount(toEvmPrivateKey(testAgent.privateKey)),
    chain: ensChain(),
    transport: http(sepoliaRpcUrl()),
  });

  const fullName = `${SPIKE_LABEL}.${parent}`;
  const node = namehash(fullName);

  console.log('\nENS ROLE SCHEMA SPIKE');
  console.log('='.repeat(72));
  console.log(`  Name         ${fullName}`);
  console.log(`  Owner        ${agentAddress}  (${testAgent.agentId}'s Hedera key)`);
  console.log(`  Orchestrator ${orch}`);
  console.log(`  roleBitmap   ${AGENT_ROLE_BITMAP}`);
  console.log('='.repeat(72));

  // ---- the agent needs gas to act as itself ------------------------------
  const agentGas = await publicClient.getBalance({ address: agentAddress });
  if (agentGas < parseEther('0.002')) {
    console.log('\n  Funding the test agent so it can send its own transactions ...');
    const hash = await wallet.sendTransaction({
      to: agentAddress,
      value: parseEther('0.005'),
      chain: wallet.chain,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  funded       ${hash}`);
  }

  // ---- mint the throwaway name -------------------------------------------
  const existingOwner = await publicClient.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'findOwner',
    args: [SPIKE_LABEL],
  });
  if (existingOwner === ZERO) {
    console.log('\n  Minting the spike name with the schema bitmap ...');
    const expiry = BigInt(Math.floor(Date.now() / 1000)) + AGENT_NAME_TTL_SECONDS;
    const { request } = await publicClient.simulateContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: 'register',
      args: [SPIKE_LABEL, agentAddress, ZERO, resolver, AGENT_ROLE_BITMAP, expiry],
      account,
    });
    const hash = await wallet.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  minted       ${hash}`);
  } else {
    console.log(`\n  ${fullName} already exists, owned by ${existingOwner}`);
  }

  const tokenId = await publicClient.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'findTokenId',
    args: [SPIKE_LABEL],
  });
  const owner = await publicClient.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'findOwner',
    args: [SPIKE_LABEL],
  });
  console.log('\n1. THE NAME EXISTS AND BELONGS TO THE AGENT KEY\n' + '-'.repeat(72));
  check(owner.toLowerCase() === agentAddress.toLowerCase(), 'Owner is the agent', owner);

  // ---- 4. expiry ---------------------------------------------------------
  const expiry = await publicClient.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'getExpiry',
    args: [tokenId],
  });
  const daysLeft = (Number(expiry) - Date.now() / 1000) / 86400;
  check(
    daysLeft > 85 && daysLeft < 95,
    'Expiry is the 90 days the schema asks for',
    `${daysLeft.toFixed(1)} days left`,
  );

  // ---- 1. the owner must not be able to repoint its resolver -------------
  console.log('\n2. WHAT THE OWNER MUST NOT BE ABLE TO DO\n' + '-'.repeat(72));
  const resolverAttempt = await reverts(() =>
    publicClient.simulateContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: 'setResolver',
      args: [tokenId, ZERO],
      account: agentAddress,
    }),
  );
  check(
    resolverAttempt.reverted,
    'The agent cannot repoint its own resolver',
    resolverAttempt.reverted
      ? 'reverted, as the schema requires'
      : 'IT SUCCEEDED — the agent could write its own score. Do not mint twenty of these.',
  );

  // ---- 2. the name must not be transferable ------------------------------
  const transferAttempt = await reverts(() =>
    publicClient.simulateContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: 'safeTransferFrom',
      args: [agentAddress, orch, tokenId, 1n, '0x'],
      account: agentAddress,
    }),
  );
  check(
    transferAttempt.reverted,
    'The agent cannot transfer the name away',
    transferAttempt.reverted
      ? 'reverted: identity stays bound to the key'
      : 'IT SUCCEEDED — names are transferable by default; the schema needs revisiting.',
  );

  // ---- 3. per-key authority ---------------------------------------------
  console.log('\n3. THE RECORD SPLIT\n' + '-'.repeat(72));
  console.log('  Granting the agent write access to "description" only ...');
  const grant = await publicClient.simulateContract({
    address: resolver,
    abi: RESOLVER_ABI,
    functionName: 'authorizeTextRoles',
    args: [dnsEncode(fullName), 'description', agentAddress, true],
    account,
  });
  const grantHash = await wallet.writeContract(grant.request);
  await publicClient.waitForTransactionReceipt({ hash: grantHash });
  console.log(`  granted      ${grantHash}`);

  const wrote = await reverts(async () => {
    // Simulated against the agent's ADDRESS to prove authorisation, then sent
    // from the agent's own wallet. The simulated request is deliberately not
    // reused: it carries the address it was simulated for, and handing that to
    // a different client produces an RPC parameter error rather than a
    // signature — which reads like a permissions failure and is not one.
    await publicClient.simulateContract({
      address: resolver,
      abi: RESOLVER_ABI,
      functionName: 'setText',
      args: [node, 'description', 'I read one slice and report what it says.'],
      account: agentAddress,
    });
    const hash = await agentWallet.writeContract({
      address: resolver,
      abi: RESOLVER_ABI,
      functionName: 'setText',
      args: [node, 'description', 'I read one slice and report what it says.'],
      chain: ensChain(),
      account: agentWallet.account!,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  agent wrote  ${hash}`);
  });
  check(!wrote.reverted, 'The agent CAN write its own description', wrote.message);

  const stored = await publicClient.readContract({
    address: resolver,
    abi: RESOLVER_ABI,
    functionName: 'text',
    args: [node, 'description'],
  });
  check(stored.length > 0, 'The description is readable back from the chain', stored);

  const scoreAttempt = await reverts(() =>
    publicClient.simulateContract({
      address: resolver,
      abi: RESOLVER_ABI,
      functionName: 'setText',
      args: [node, 'score.net', '999'],
      account: agentAddress,
    }),
  );
  check(
    scoreAttempt.reverted,
    'The agent CANNOT write its own score',
    scoreAttempt.reverted
      ? 'reverted: the record is not the agent to write'
      : 'IT SUCCEEDED — per-key authority is not doing what the schema assumes.',
  );

  // The orchestrator can, and that is the other half of the claim.
  const orchWrote = await reverts(async () => {
    const { request } = await publicClient.simulateContract({
      address: resolver,
      abi: RESOLVER_ABI,
      functionName: 'setText',
      args: [node, 'score.net', '0.0'],
      account,
    });
    const hash = await wallet.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  orch wrote   ${hash}`);
  });
  check(!orchWrote.reverted, 'The orchestrator CAN write the score', orchWrote.message);

  console.log('\n' + '='.repeat(72));
  if (failures === 0) {
    console.log('  SCHEMA HOLDS — safe to mint the pool.');
  } else {
    console.log(`  ${failures} check(s) failed. DO NOT mint the pool until the schema is fixed.`);
  }
  console.log(`  https://sepolia.etherscan.io/address/${registry}`);
  console.log('='.repeat(72) + '\n');
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`\n  Spike failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
