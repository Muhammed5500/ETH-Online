/**
 * Hedera configuration, read from the environment.
 *
 * The package itself never calls `dotenv`. It takes an env object, so the
 * whole surface is testable without a file on disk and without a network, and
 * so an app can inject configuration from somewhere else entirely.
 */

export type HederaNetwork = 'testnet' | 'mainnet' | 'previewnet' | 'local';

const NETWORKS: readonly HederaNetwork[] = ['testnet', 'mainnet', 'previewnet', 'local'];

export interface HederaConfig {
  readonly network: HederaNetwork;
  readonly operatorId: string;
  readonly operatorKey: string;
}

export interface KeyPairRef {
  readonly accountId: string;
  readonly privateKey: string;
}

/**
 * Reads a variable, treating an empty value as absent.
 *
 * `.env` turns `KEY=` into the empty string, not `undefined`. `??` does not
 * catch that and `||` does — a trap that already cost time in SPIKE A, where
 * an empty facilitator URL silently became `''` and the request went nowhere.
 * Every read in this package goes through here so it cannot happen again.
 */
export function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}

function require_(env: NodeJS.ProcessEnv, key: string): string {
  const v = readEnv(env, key);
  if (v === undefined) {
    throw new Error(`${key} is missing or empty in the environment. Fill it in .env and retry.`);
  }
  return v;
}

export function parseNetwork(raw: string | undefined): HederaNetwork {
  const v = (raw ?? 'testnet').toLowerCase();
  if (!NETWORKS.includes(v as HederaNetwork)) {
    throw new Error(`HEDERA_NETWORK must be one of ${NETWORKS.join(', ')}, got: ${raw}`);
  }
  return v as HederaNetwork;
}

/** Operator credentials — the account that pays fees and signs on our behalf. */
export function hederaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HederaConfig {
  return {
    network: parseNetwork(readEnv(env, 'HEDERA_NETWORK')),
    operatorId: require_(env, 'HEDERA_OPERATOR_ID'),
    operatorKey: require_(env, 'HEDERA_OPERATOR_KEY'),
  };
}

/**
 * Treasury credentials, if they have been set up yet.
 *
 * Returns `undefined` rather than throwing: the treasury does not exist before
 * `setup-hedera-accounts` has run once, and that is a normal state, not an error.
 */
export function treasuryFromEnv(env: NodeJS.ProcessEnv = process.env): KeyPairRef | undefined {
  const accountId = readEnv(env, 'HEDERA_TREASURY_ID');
  const privateKey = readEnv(env, 'HEDERA_TREASURY_KEY');
  if (!accountId || !privateKey) return undefined;
  return { accountId, privateKey };
}

/**
 * How many agents the pool should hold.
 *
 * Configuration, never a constant. PLAN section 3.3: agent registration stays
 * open to anyone, and "all the agents are ours" is a fact about this demo's
 * seeding, not an assumption baked into the code.
 */
export function agentCountFromEnv(env: NodeJS.ProcessEnv = process.env, fallback = 20): number {
  const raw = readEnv(env, 'AGENT_COUNT');
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`AGENT_COUNT must be a positive integer, got: ${raw}`);
  }
  return n;
}
