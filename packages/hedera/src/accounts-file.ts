/**
 * The `agents/accounts.json` ledger — schema, validation and the merge that
 * makes account setup idempotent.
 *
 * WHY THIS IS ITS OWN MODULE. Creating accounts costs real HBAR and cannot be
 * undone: a script that blindly makes 20 accounts every run leaves orphans
 * behind and drains the operator. So the setup script reads what already
 * exists and only creates what is missing, and that decision has to be
 * testable without touching a network. All of it is pure functions over a
 * parsed file.
 *
 * The file holds private keys. It is in `.gitignore` and must stay there.
 */
import type { HederaNetwork } from './env.js';

export interface AgentAccount {
  readonly agentId: string;
  readonly accountId: string;
  readonly privateKey: string;
  readonly publicKey: string;
  readonly evmAddress: string;
}

export interface AccountsFile {
  readonly version: 1;
  /**
   * Which network these accounts live on.
   *
   * Not decoration. Account ids look identical across networks, so a testnet
   * ledger pointed at mainnet would produce confident nonsense. Every load
   * checks this.
   */
  readonly network: HederaNetwork;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Holds deposits, bonds and settlement payouts. Created on the first run. */
  readonly treasury?: AgentAccount;
  readonly agents: readonly AgentAccount[];
}

export const ACCOUNTS_FILE_VERSION = 1;

/** `agent-01`, `agent-02`, ... — zero padded so ids sort the way they read. */
export function agentIdFor(index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`Agent index must be a positive integer, got: ${index}`);
  }
  return `agent-${String(index).padStart(2, '0')}`;
}

export function emptyAccountsFile(network: HederaNetwork, now = new Date()): AccountsFile {
  const ts = now.toISOString();
  return {
    version: ACCOUNTS_FILE_VERSION,
    network,
    createdAt: ts,
    updatedAt: ts,
    agents: [],
  };
}

function isAgentAccount(v: unknown): v is AgentAccount {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['agentId'] === 'string' &&
    typeof o['accountId'] === 'string' &&
    typeof o['privateKey'] === 'string' &&
    typeof o['publicKey'] === 'string' &&
    typeof o['evmAddress'] === 'string'
  );
}

/**
 * Parses and validates the ledger.
 *
 * Fails loudly on anything unexpected. A half-understood accounts file is
 * worse than no accounts file: it leads to funding an account we cannot sign
 * for, and the HBAR is simply gone.
 */
export function parseAccountsFile(raw: string): AccountsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`accounts.json is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('accounts.json must be a JSON object.');
  }
  const o = parsed as Record<string, unknown>;

  if (o['version'] !== ACCOUNTS_FILE_VERSION) {
    throw new Error(
      `accounts.json has version ${String(o['version'])}, expected ${ACCOUNTS_FILE_VERSION}.`,
    );
  }
  if (typeof o['network'] !== 'string') {
    throw new Error('accounts.json is missing "network".');
  }
  if (!Array.isArray(o['agents']) || !o['agents'].every(isAgentAccount)) {
    throw new Error('accounts.json "agents" must be an array of complete account records.');
  }
  if (o['treasury'] !== undefined && !isAgentAccount(o['treasury'])) {
    throw new Error('accounts.json "treasury" is present but incomplete.');
  }

  const ids = (o['agents'] as AgentAccount[]).map((a) => a.agentId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('accounts.json contains duplicate agent ids.');
  }

  return {
    version: ACCOUNTS_FILE_VERSION,
    network: o['network'] as HederaNetwork,
    createdAt: typeof o['createdAt'] === 'string' ? o['createdAt'] : new Date(0).toISOString(),
    updatedAt: typeof o['updatedAt'] === 'string' ? o['updatedAt'] : new Date(0).toISOString(),
    ...(o['treasury'] ? { treasury: o['treasury'] as AgentAccount } : {}),
    agents: o['agents'] as AgentAccount[],
  };
}

/**
 * Refuses to use a ledger from a different network.
 *
 * This is the check that stops `0.0.1234` on testnet from being mistaken for
 * a completely unrelated `0.0.1234` on mainnet.
 */
export function assertNetworkMatches(file: AccountsFile, network: HederaNetwork): void {
  if (file.network !== network) {
    throw new Error(
      `accounts.json was created for ${file.network} but the current network is ${network}. ` +
        `Account ids are not portable between networks. Point HEDERA_NETWORK back to ` +
        `${file.network}, or move the file aside and set up again.`,
    );
  }
}

/**
 * Which agent ids still need an account, given a target pool size.
 *
 * This is the whole idempotency story: run the setup script again and it
 * creates only the gap. Shrinking `desiredCount` never deletes anything —
 * destroying key material because a number in `.env` changed would be an
 * unpleasant surprise, and an unused account costs nothing.
 */
export function missingAgentIds(file: AccountsFile, desiredCount: number): string[] {
  if (!Number.isInteger(desiredCount) || desiredCount < 0) {
    throw new Error(`desiredCount must be a non-negative integer, got: ${desiredCount}`);
  }
  const have = new Set(file.agents.map((a) => a.agentId));
  const missing: string[] = [];
  for (let i = 1; i <= desiredCount; i++) {
    const id = agentIdFor(i);
    if (!have.has(id)) missing.push(id);
  }
  return missing;
}

/** Adds or replaces one agent record, keeping the list sorted by agent id. */
export function upsertAgent(file: AccountsFile, agent: AgentAccount, now = new Date()): AccountsFile {
  const agents = file.agents.filter((a) => a.agentId !== agent.agentId).concat(agent);
  agents.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return { ...file, agents, updatedAt: now.toISOString() };
}

export function setTreasury(file: AccountsFile, treasury: AgentAccount, now = new Date()): AccountsFile {
  return { ...file, treasury, updatedAt: now.toISOString() };
}

export function serializeAccountsFile(file: AccountsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
