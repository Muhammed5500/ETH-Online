/**
 * The ENSv2 deployment this project talks to.
 *
 * WHERE THESE CAME FROM, AND WHY IT MATTERS. Not from the docs site. The
 * addresses published there did not match what is actually on Sepolia — the
 * registry it lists has no relation to the one the registrar points at — and
 * sending a transaction to a plausible wrong address is a failure that reads
 * like a permissions bug for an hour before anybody checks the address.
 *
 * These are read out of `ensdomains/contracts-v2`, the deployment artifacts
 * the ENS team writes when they deploy (`contracts/deployments/sepolia/*.json`,
 * main branch as of 2026-09-12), and every one was confirmed to carry bytecode
 * on Sepolia before a single transaction was sent.
 *
 * SEPOLIA ONLY, AND THAT IS THE TRACK'S RULE. ENSv2 is not on mainnet and the
 * ENS prize requires Sepolia. There is deliberately no mainnet table here: a
 * chain id switch that silently reached for mainnet addresses that do not
 * exist would be the same failure as above, with real money attached.
 */

/** Chain id of the network these addresses live on. */
export const ENS_CHAIN_ID = 11155111;

export interface EnsDeployment {
  /** Registers `.eth` names. Commit-and-reveal, paid in an ERC-20. */
  readonly ethRegistrar: `0x${string}`;
  /** The registry holding `.eth` and its subregistries. */
  readonly ethRegistry: `0x${string}`;
  readonly rootRegistry: `0x${string}`;
  /** Deploys verifiable proxies: our own registry and resolver come from here. */
  readonly verifiableFactory: `0x${string}`;
  /** Implementation behind each PermissionedResolver proxy. */
  readonly permissionedResolverImpl: `0x${string}`;
  /** Resolves names for readers, including wildcard resolution. */
  readonly universalResolver: `0x${string}`;
  /** Shared label database the registries are constructed against. */
  readonly labelStore: `0x${string}`;
  /**
   * What a registration is paid in on this deployment.
   *
   * Names are NOT bought with ether here: `register` takes a `paymentToken`,
   * and on Sepolia that is a mock stablecoin whose `mint` is open to anyone.
   * Sepolia ETH is only ever gas.
   */
  readonly paymentToken: `0x${string}`;
  readonly paymentTokenDecimals: number;
}

export const SEPOLIA: EnsDeployment = {
  ethRegistrar: '0xa4449a0dd2b83007553d9b1d28b583a46a805a30',
  ethRegistry: '0x67b728a792e789a8978b30cf1b3b641f19354b43',
  rootRegistry: '0x11b5bfbe9078d826b1edbdd1cfc12f5828d9f50c',
  verifiableFactory: '0x118bc31a50d559f7015a8da26d54b3b030cdb70f',
  permissionedResolverImpl: '0x7e4b2d59938930168024201752ee5503df402303',
  universalResolver: '0x85edf8b6b7d4211e2b07aa687506b746357b92cf',
  labelStore: '0xb03524289c16424f71802a1794c29c7bd1b9f577',
  paymentToken: '0xd3322b29a7bdee707d1684676f149bf41aa3422f',
  paymentTokenDecimals: 6,
};

/**
 * Registry roles, straight from `RegistryRolesLib.sol`.
 *
 * Every regular role has an admin twin at `role << 128`, and the admin twin
 * can only be granted AT REGISTRATION. That one-shot rule is why the role
 * schema (`docs/ens-role-schema.md`) had to be settled before any name was
 * minted: a wrong bitmap cannot be corrected afterwards, only re-minted.
 */
export const REGISTRY_ROLES = {
  REGISTRAR: 1n << 0n,
  REGISTER_RESERVED: 1n << 4n,
  SET_PARENT: 1n << 8n,
  UNREGISTER: 1n << 12n,
  RENEW: 1n << 16n,
  SET_SUBREGISTRY: 1n << 20n,
  SET_RESOLVER: 1n << 24n,
  SET_URI: 1n << 36n,
  CAN_NAME: 1n << 120n,
  UPGRADE: 1n << 124n,
} as const;

/** `ROLE_X_ADMIN = ROLE_X << 128`. */
export function adminRole(role: bigint): bigint {
  return role << 128n;
}

/** `ROLE_CAN_TRANSFER_ADMIN` exists only in its admin form. */
export const ROLE_CAN_TRANSFER_ADMIN = (1n << 28n) << 128n;

/**
 * What an agent gets on its own name: nothing.
 *
 * Owning the token is the identity; the roles are what it may do to the name
 * itself, and every one of them is a way to break the thing the name is for.
 * `SET_RESOLVER` above all: an agent that can repoint its resolver can write
 * its own score, and the whole reputation claim collapses. The reasoning for
 * each is in docs/ens-role-schema.md section 8.
 */
export const AGENT_ROLE_BITMAP = 0n;

/**
 * What the orchestrator holds on our own registry.
 *
 * Enough to mint names, take one back, renew before expiry, and set the
 * resolver. Not `SET_PARENT`: nothing should move our registry inside the
 * tree, including us.
 */
export const ORCHESTRATOR_ROOT_ROLES =
  REGISTRY_ROLES.REGISTRAR |
  adminRole(REGISTRY_ROLES.REGISTRAR) |
  REGISTRY_ROLES.UNREGISTER |
  adminRole(REGISTRY_ROLES.UNREGISTER) |
  REGISTRY_ROLES.RENEW |
  adminRole(REGISTRY_ROLES.RENEW) |
  REGISTRY_ROLES.SET_RESOLVER |
  adminRole(REGISTRY_ROLES.SET_RESOLVER);

/** Resolver roles, from `PermissionedResolverLib.sol`. */
export const RESOLVER_ROLES = {
  SET_ADDR: 1n << 0n,
  SET_TEXT: 1n << 4n,
  SET_CONTENTHASH: 1n << 8n,
  SET_PUBKEY: 1n << 12n,
  SET_ABI: 1n << 16n,
  SET_INTERFACE: 1n << 20n,
  SET_NAME: 1n << 24n,
  SET_ALIAS: 1n << 28n,
} as const;

/**
 * Text records an agent may write about itself.
 *
 * Granted one key at a time with `authorizeTextRoles`, because the resolver
 * scopes a role to `resource(namehash, partHash(key))`. Per-key is the whole
 * design: it is what lets an agent describe itself without being able to
 * describe its own performance.
 */
export const AGENT_WRITABLE_KEYS = ['description', 'url', 'avatar', 'model', 'endpoint'] as const;

/**
 * Text records only the orchestrator may write.
 *
 * These are counted from markets that ran. An agent that could edit them would
 * be publishing a claim about itself, which is exactly what a record is not.
 */
export const ORCHESTRATOR_ONLY_KEYS = [
  'score.markets',
  'score.reports',
  'score.reference',
  'score.timeouts',
  'score.net',
  'hedera.account',
  'slices',
] as const;

/** A year, in seconds. Registration duration for the parent name. */
export const ONE_YEAR_SECONDS = 31_536_000n;

/** How long an agent's subname lives before it has to be renewed. */
export const AGENT_NAME_TTL_SECONDS = 90n * 24n * 60n * 60n;
