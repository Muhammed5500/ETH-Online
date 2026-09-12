/**
 * Our own corner of the ENS tree — ADIM 24, part two.
 *
 * Three transactions and one idea. The idea: agent names should not be
 * entries in a table we keep, they should be names in the registry the rest
 * of the world already reads. So we deploy a registry of our own, hang it
 * under the name we bought, and mint into it.
 *
 *   1. a PermissionedResolver proxy   where the records live
 *   2. a UserRegistry proxy           where the names live
 *   3. attach both to <parent>.eth    so the tree leads to them
 *
 * WHY A PROXY OF OUR OWN AND NOT A SHARED RESOLVER. The record split is the
 * whole point: an agent writes its profile, only the orchestrator writes its
 * score. That split is enforced by roles held on the resolver, so the resolver
 * has to be one whose roles we control.
 *
 * WHO HOLDS WHAT, AFTER THIS RUNS. The orchestrator holds blanket authority at
 * the root resource of both proxies — it can mint, unregister, renew, set
 * resolvers and write any record. Agents get nothing here; what they get is
 * granted name by name and key by key at mint time (`ens-mint.ts`), which is
 * the narrow end of the same authority.
 *
 * IDEMPOTENT. Addresses that already carry bytecode are reused rather than
 * redeployed, so a second run costs one read and nothing else.
 *
 * Run:  pnpm ens:registry
 */
import './load-env.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { encodeFunctionData, keccak256, parseAbi, stringToHex, type Address } from 'viem';
import {
  adminRole,
  ORCHESTRATOR_ROOT_ROLES,
  orchestratorSigner,
  RESOLVER_ROLES,
  SEPOLIA,
} from '@ethonline/ens';
import { readEnv } from '@ethonline/hedera';

/** Deployment artifact of contracts-v2 on Sepolia, confirmed to have bytecode. */
const USER_REGISTRY_IMPL = '0x840fa461059862ea466a711e8c98c8de732061c0' as const;

const FACTORY_ABI = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address)',
]);
const REGISTRY_INIT_ABI = parseAbi(['function initialize(address rootAccount, uint256 roleBitmap)']);
const RESOLVER_INIT_ABI = parseAbi([
  'function initialize(address admin, uint256 roleBitmap, bytes[] setters)',
]);
const ETH_REGISTRY_ABI = parseAbi([
  'function findTokenId(string label) view returns (uint256)',
  'function findOwner(string label) view returns (address)',
  'function getSubregistry(string label) view returns (address)',
  'function getResolver(string label) view returns (address)',
  'function setSubregistry(uint256 anyId, address registry)',
  'function setResolver(uint256 anyId, address resolver)',
]);

/**
 * Everything the orchestrator may do to records, on any name in this resolver.
 *
 * Granted at the root resource, which the resolver treats as "any name, any
 * key". The per-key grants an agent receives later are the same roles scoped
 * to one name and one key — narrow by construction rather than by promise.
 */
const RESOLVER_ROOT_ROLES = Object.values(RESOLVER_ROLES).reduce(
  (bitmap, role) => bitmap | role | adminRole(role),
  0n,
);

/** Same salt, same deployer, same address: a rerun cannot fork the deployment. */
function saltFor(purpose: string): bigint {
  return BigInt(keccak256(stringToHex(`ethonline:${purpose}:v1`)));
}

/** Writes an address back into .env so the later scripts find it. */
function rememberInEnv(key: string, value: string): void {
  const path = '.env';
  const contents = readFileSync(path, 'utf-8');
  const line = `${key}=${value}`;
  const next = new RegExp(`^${key}=.*$`, 'm').test(contents)
    ? contents.replace(new RegExp(`^${key}=.*$`, 'm'), line)
    : `${contents.trimEnd()}\n${line}\n`;
  writeFileSync(path, next);
  console.log(`  .env        ${key}=${value}`);
}

async function main(): Promise<void> {
  const parent = readEnv(process.env, 'ENS_PARENT_NAME');
  if (!parent) {
    console.error('\n  ENS_PARENT_NAME is not set. Run `pnpm ens:parent` first.\n');
    process.exit(1);
  }
  const label = parent.replace(/\.eth$/, '');
  const { address, wallet, publicClient } = orchestratorSigner();
  const account = wallet.account!;

  console.log('\nENS REGISTRY AND RESOLVER');
  console.log('='.repeat(70));
  console.log(`  Parent      ${parent}`);
  console.log(`  Orchestr.   ${address}`);
  console.log('='.repeat(70));

  const owner = await publicClient.readContract({
    address: SEPOLIA.ethRegistry,
    abi: ETH_REGISTRY_ABI,
    functionName: 'findOwner',
    args: [label],
  });
  if (owner.toLowerCase() !== address.toLowerCase()) {
    console.error(`\n  ${parent} belongs to ${owner}, not to us. Nothing can be attached to it.\n`);
    process.exit(1);
  }
  const tokenId = await publicClient.readContract({
    address: SEPOLIA.ethRegistry,
    abi: ETH_REGISTRY_ABI,
    functionName: 'findTokenId',
    args: [label],
  });

  const hasCode = async (a: string | undefined): Promise<boolean> => {
    if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) return false;
    const code = await publicClient.getCode({ address: a as Address });
    return !!code && code !== '0x';
  };

  const deployProxy = async (
    what: string,
    implementation: Address,
    initData: `0x${string}`,
  ): Promise<Address> => {
    console.log(`\n  Deploying the ${what} proxy ...`);
    // Simulate FIRST, then send that exact request.
    //
    // The factory returns the new address, and a return value cannot be read
    // back from a receipt, so the address has to come from a simulation.
    // Doing it afterwards looks equivalent and is not: the salt is spent by
    // then, the simulation reverts, and the script loses the address of a
    // proxy it has just paid to deploy. That happened once here and the
    // resolver had to be recovered by reading the transaction's logs.
    const { result, request } = await publicClient.simulateContract({
      address: SEPOLIA.verifiableFactory,
      abi: FACTORY_ABI,
      functionName: 'deployProxy',
      args: [implementation, saltFor(what), initData],
      account,
    });
    const hash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ${what.padEnd(11)} ${hash}  (${receipt.status})`);
    return result;
  };

  // ---- 1. the resolver ---------------------------------------------------
  let resolver = readEnv(process.env, 'ENS_RESOLVER_ADDRESS');
  if (await hasCode(resolver)) {
    console.log(`\n  Resolver    ${resolver}  (already deployed)`);
  } else {
    resolver = await deployProxy(
      'resolver',
      SEPOLIA.permissionedResolverImpl,
      encodeFunctionData({
        abi: RESOLVER_INIT_ABI,
        functionName: 'initialize',
        args: [address, RESOLVER_ROOT_ROLES, []],
      }),
    );
    rememberInEnv('ENS_RESOLVER_ADDRESS', resolver);
  }

  // ---- 2. the registry ---------------------------------------------------
  let registry = readEnv(process.env, 'ENS_USER_REGISTRY_ADDRESS');
  if (await hasCode(registry)) {
    console.log(`  Registry    ${registry}  (already deployed)`);
  } else {
    registry = await deployProxy(
      'registry',
      USER_REGISTRY_IMPL,
      encodeFunctionData({
        abi: REGISTRY_INIT_ABI,
        functionName: 'initialize',
        args: [address, ORCHESTRATOR_ROOT_ROLES],
      }),
    );
    rememberInEnv('ENS_USER_REGISTRY_ADDRESS', registry);
  }

  // ---- 3. attach both to the parent name ---------------------------------
  const currentSub = await publicClient.readContract({
    address: SEPOLIA.ethRegistry,
    abi: ETH_REGISTRY_ABI,
    functionName: 'getSubregistry',
    args: [label],
  });
  if (currentSub.toLowerCase() !== registry!.toLowerCase()) {
    console.log('\n  Pointing the parent at our registry ...');
    const hash = await wallet.writeContract({
      address: SEPOLIA.ethRegistry,
      abi: ETH_REGISTRY_ABI,
      functionName: 'setSubregistry',
      args: [tokenId, registry as Address],
      chain: wallet.chain,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  subregistry ${hash}`);
  }

  const currentResolver = await publicClient.readContract({
    address: SEPOLIA.ethRegistry,
    abi: ETH_REGISTRY_ABI,
    functionName: 'getResolver',
    args: [label],
  });
  if (currentResolver.toLowerCase() !== resolver!.toLowerCase()) {
    console.log('\n  Pointing the parent at our resolver ...');
    const hash = await wallet.writeContract({
      address: SEPOLIA.ethRegistry,
      abi: ETH_REGISTRY_ABI,
      functionName: 'setResolver',
      args: [tokenId, resolver as Address],
      chain: wallet.chain,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  resolver    ${hash}`);
  }

  console.log('\n' + '='.repeat(70));
  console.log(`  ${parent} now points at our own registry.`);
  console.log(`  registry    https://sepolia.etherscan.io/address/${registry}`);
  console.log(`  resolver    https://sepolia.etherscan.io/address/${resolver}`);
  console.log('='.repeat(70) + '\n');
}

main().catch((e) => {
  console.error(`\n  ENS registry setup failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
