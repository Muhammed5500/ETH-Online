/**
 * Reading an agent's identity back out of ENS.
 *
 * THROUGH THE UNIVERSAL RESOLVER, NOT OUR OWN. Our resolver's address is in
 * `.env` and reading it directly would be quicker. It would also prove
 * nothing: an app that reads the contract it deployed is an app reading its
 * own database with extra steps. Going through the universal resolver walks
 * the real tree — `.eth`, the parent, our registry, our resolver — which is
 * the same path a wallet, an explorer or a stranger's script takes. If that
 * walk breaks, the name is not really in ENS and we should find out.
 *
 * NOTHING HERE NEEDS A KEY. Resolution is a view call, so the frontend and the
 * API read agent names with no signer and no gas, from a public RPC.
 *
 * WHAT VERIFICATION MEANS HERE. `verifyEnsOwnership` answers one question: is
 * this name owned by the address that this public key derives? That is the
 * check that lets registration accept an ENS name from a stranger without
 * taking their word for it — they can only claim a name they hold the key to.
 */
import {
  decodeFunctionResult,
  encodeFunctionData,
  namehash,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem';
import { publicSepolia } from './client.js';
import { AGENT_WRITABLE_KEYS, ORCHESTRATOR_ONLY_KEYS, SEPOLIA } from './deployment.js';

const UNIVERSAL_RESOLVER_ABI = parseAbi([
  'function resolve(bytes name, bytes data) view returns (bytes, address)',
]);
const RESOLVER_READ_ABI = parseAbi([
  'function text(bytes32 node, string key) view returns (string)',
  'function addr(bytes32 node) view returns (address)',
]);
const REGISTRY_READ_ABI = parseAbi(['function findOwner(string label) view returns (address)']);

/** DNS wire format: `agent-07.unverifiable.eth` -> length-prefixed labels. */
export function dnsEncodeName(name: string): `0x${string}` {
  let out = '';
  for (const part of name.split('.').filter((p) => p.length > 0)) {
    if (part.length > 63) throw new Error(`Label too long for DNS encoding: ${part}`);
    out += part.length.toString(16).padStart(2, '0');
    out += Buffer.from(part, 'utf-8').toString('hex');
  }
  return `0x${out}00`;
}

/** `agent-07` under `unverifiable.eth`. */
export function agentEnsName(agentId: string, parent: string): string {
  return `${agentId}.${parent}`;
}

/**
 * One text record, resolved the way the rest of the world would resolve it.
 *
 * Returns undefined rather than throwing when the name or the record does not
 * exist: an agent without an ENS name is a normal agent, and a page that
 * cannot render one is a bug, not an outage.
 */
export async function readEnsText(
  name: string,
  key: string,
  client: PublicClient = publicSepolia() as PublicClient,
): Promise<string | undefined> {
  try {
    const [result] = await client.readContract({
      address: SEPOLIA.universalResolver,
      abi: UNIVERSAL_RESOLVER_ABI,
      functionName: 'resolve',
      args: [
        dnsEncodeName(name),
        encodeFunctionData({
          abi: RESOLVER_READ_ABI,
          functionName: 'text',
          args: [namehash(name), key],
        }),
      ],
    });
    const value = decodeFunctionResult({
      abi: RESOLVER_READ_ABI,
      functionName: 'text',
      data: result,
    });
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface EnsAgentProfile {
  readonly name: string;
  /** Written by the agent itself. */
  readonly profile: Record<string, string>;
  /** Written by the orchestrator; the agent cannot touch these. */
  readonly record: Record<string, string>;
}

/**
 * Everything published under one agent name.
 *
 * The two groups are kept apart in the shape, not merged into one bag of
 * records, because which of them an agent could have written is the whole
 * point of publishing them here.
 */
export async function readEnsAgent(
  name: string,
  client: PublicClient = publicSepolia() as PublicClient,
): Promise<EnsAgentProfile> {
  const entries = await Promise.all(
    [...AGENT_WRITABLE_KEYS, ...ORCHESTRATOR_ONLY_KEYS].map(
      async (key) => [key, await readEnsText(name, key, client)] as const,
    ),
  );

  const profile: Record<string, string> = {};
  const record: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    if ((AGENT_WRITABLE_KEYS as readonly string[]).includes(key)) profile[key] = value;
    else record[key] = value;
  }
  return { name, profile, record };
}

/**
 * Who owns this name, according to our registry.
 *
 * Only names under our own parent can be checked this way. A name from
 * somebody else's parent needs its own registry, which is a thing to add when
 * the first outside agent brings one — not a thing to guess at now.
 */
export async function ensNameOwner(
  name: string,
  parent: string,
  registry: Address,
  client: PublicClient = publicSepolia() as PublicClient,
): Promise<Address | undefined> {
  const suffix = `.${parent}`;
  if (!name.endsWith(suffix)) return undefined;
  const label = name.slice(0, -suffix.length);
  if (label.length === 0 || label.includes('.')) return undefined;

  try {
    const owner = await client.readContract({
      address: registry,
      abi: REGISTRY_READ_ABI,
      functionName: 'findOwner',
      args: [label],
    });
    return owner === '0x0000000000000000000000000000000000000000' ? undefined : owner;
  } catch {
    return undefined;
  }
}

export interface OwnershipCheck {
  readonly ok: boolean;
  readonly reason?: string;
  readonly owner?: Address;
}

/**
 * Does the key registering this agent actually hold the name it claims?
 *
 * Compared against the address the agent's own public key derives, so the
 * answer is the same question the mechanism already asks everywhere else: is
 * this the key that signs the reports? A name somebody else owns is refused,
 * and a name that does not resolve is refused — silently accepting either
 * would put an unearned identity on the agent's card.
 */
export async function verifyEnsOwnership(
  name: string,
  expectedOwner: Address,
  parent: string,
  registry: Address,
  client: PublicClient = publicSepolia() as PublicClient,
): Promise<OwnershipCheck> {
  const owner = await ensNameOwner(name, parent, registry, client);
  if (!owner) {
    return { ok: false, reason: `${name} does not resolve to an owner in this registry.` };
  }
  if (owner.toLowerCase() !== expectedOwner.toLowerCase()) {
    return {
      ok: false,
      reason: `${name} belongs to ${owner}, not to ${expectedOwner}.`,
      owner,
    };
  }
  return { ok: true, owner };
}
