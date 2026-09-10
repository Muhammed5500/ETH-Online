/**
 * Ledger tests.
 *
 * Account creation costs HBAR and cannot be undone, so the merge that decides
 * "what still needs creating" is the part worth pinning down hardest. A bug
 * here either creates orphan accounts on every run or, worse, funds an
 * account we have no key for.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS_FILE_VERSION,
  agentIdFor,
  assertNetworkMatches,
  emptyAccountsFile,
  missingAgentIds,
  parseAccountsFile,
  serializeAccountsFile,
  setTreasury,
  upsertAgent,
  type AccountsFile,
  type AgentAccount,
} from '../src/accounts-file.js';

function account(agentId: string, n = 1): AgentAccount {
  return {
    agentId,
    accountId: `0.0.${1000 + n}`,
    privateKey: `key-${n}`,
    publicKey: `pub-${n}`,
    evmAddress: `0x${String(n).padStart(40, '0')}`,
  };
}

function fileWith(ids: readonly string[]): AccountsFile {
  return ids.reduce<AccountsFile>(
    (f, id, i) => upsertAgent(f, account(id, i + 1)),
    emptyAccountsFile('testnet'),
  );
}

describe('agentIdFor', () => {
  it('zero pads so ids sort the way they read', () => {
    expect(agentIdFor(1)).toBe('agent-01');
    expect(agentIdFor(9)).toBe('agent-09');
    expect(agentIdFor(20)).toBe('agent-20');
    expect(agentIdFor(100)).toBe('agent-100');
  });

  it('rejects a non-positive index', () => {
    expect(() => agentIdFor(0)).toThrow(/positive integer/);
    expect(() => agentIdFor(-1)).toThrow(/positive integer/);
    expect(() => agentIdFor(1.5)).toThrow(/positive integer/);
  });
});

describe('missingAgentIds — the idempotency rule', () => {
  it('asks for the whole pool when nothing exists yet', () => {
    expect(missingAgentIds(emptyAccountsFile('testnet'), 3)).toEqual([
      'agent-01',
      'agent-02',
      'agent-03',
    ]);
  });

  it('asks for nothing when the pool is already complete', () => {
    // Re-running setup must not create a second set of accounts.
    expect(missingAgentIds(fileWith(['agent-01', 'agent-02', 'agent-03']), 3)).toEqual([]);
  });

  it('asks only for the gap', () => {
    expect(missingAgentIds(fileWith(['agent-01', 'agent-03']), 4)).toEqual([
      'agent-02',
      'agent-04',
    ]);
  });

  it('never deletes when the target shrinks', () => {
    // Lowering AGENT_COUNT should not destroy key material. An unused account
    // costs nothing; a discarded private key is unrecoverable.
    const f = fileWith(['agent-01', 'agent-02', 'agent-03']);
    expect(missingAgentIds(f, 1)).toEqual([]);
    expect(f.agents).toHaveLength(3);
  });

  it('rejects a nonsense target', () => {
    expect(() => missingAgentIds(emptyAccountsFile('testnet'), -1)).toThrow(/desiredCount/);
  });
});

describe('upsertAgent', () => {
  it('adds an agent and keeps the list sorted', () => {
    const f = fileWith(['agent-03', 'agent-01', 'agent-02']);
    expect(f.agents.map((a) => a.agentId)).toEqual(['agent-01', 'agent-02', 'agent-03']);
  });

  it('replaces rather than duplicating', () => {
    let f = fileWith(['agent-01']);
    f = upsertAgent(f, { ...account('agent-01', 9), accountId: '0.0.9999' });
    expect(f.agents).toHaveLength(1);
    expect(f.agents[0]?.accountId).toBe('0.0.9999');
  });

  it('moves updatedAt forward but leaves createdAt alone', () => {
    const f0 = emptyAccountsFile('testnet', new Date('2026-01-01T00:00:00Z'));
    const f1 = upsertAgent(f0, account('agent-01'), new Date('2026-02-02T00:00:00Z'));
    expect(f1.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(f1.updatedAt).toBe('2026-02-02T00:00:00.000Z');
  });
});

describe('parseAccountsFile', () => {
  it('round-trips a serialized file', () => {
    const f = setTreasury(fileWith(['agent-01', 'agent-02']), account('treasury', 99));
    expect(parseAccountsFile(serializeAccountsFile(f))).toEqual(f);
  });

  it('rejects invalid JSON with a readable message', () => {
    expect(() => parseAccountsFile('{ nope')).toThrow(/not valid JSON/);
  });

  it('rejects a version it does not understand', () => {
    expect(() => parseAccountsFile(JSON.stringify({ version: 2, network: 'testnet', agents: [] }))).toThrow(
      /version/,
    );
  });

  it('rejects a file with no network', () => {
    expect(() =>
      parseAccountsFile(JSON.stringify({ version: ACCOUNTS_FILE_VERSION, agents: [] })),
    ).toThrow(/network/);
  });

  it('rejects an incomplete account record', () => {
    // Half a record means a funded account we cannot sign for.
    const bad = {
      version: ACCOUNTS_FILE_VERSION,
      network: 'testnet',
      agents: [{ agentId: 'agent-01', accountId: '0.0.1' }],
    };
    expect(() => parseAccountsFile(JSON.stringify(bad))).toThrow(/complete account records/);
  });

  it('rejects an incomplete treasury', () => {
    const bad = {
      version: ACCOUNTS_FILE_VERSION,
      network: 'testnet',
      agents: [],
      treasury: { accountId: '0.0.1' },
    };
    expect(() => parseAccountsFile(JSON.stringify(bad))).toThrow(/treasury/);
  });

  it('rejects duplicate agent ids', () => {
    const bad = {
      version: ACCOUNTS_FILE_VERSION,
      network: 'testnet',
      agents: [account('agent-01', 1), account('agent-01', 2)],
    };
    expect(() => parseAccountsFile(JSON.stringify(bad))).toThrow(/duplicate/);
  });

  it('rejects a top-level array — the shape has to carry the network', () => {
    expect(() => parseAccountsFile('[]')).toThrow(/must be a JSON object/);
  });
});

describe('assertNetworkMatches', () => {
  it('passes when the ledger and the environment agree', () => {
    expect(() => assertNetworkMatches(emptyAccountsFile('testnet'), 'testnet')).not.toThrow();
  });

  it('refuses a testnet ledger pointed at mainnet', () => {
    // `0.0.1234` exists on both networks and means something different on
    // each. Without this check the script would fund a stranger.
    expect(() => assertNetworkMatches(emptyAccountsFile('testnet'), 'mainnet')).toThrow(
      /not portable between networks/,
    );
  });
});

describe('serializeAccountsFile', () => {
  it('writes indented JSON ending in a newline', () => {
    const out = serializeAccountsFile(emptyAccountsFile('testnet'));
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain('\n  "network": "testnet"');
  });
});
