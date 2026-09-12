/**
 * Publishing an agent's record — ADIM 26.
 *
 * WHAT IS PUBLISHED AND WHY IT IS NOT A CLAIM. These numbers are counted from
 * markets that ran: bonds paid, reports delivered, times the stopping dice
 * made this agent the reference, net payout. The agent cannot write them —
 * `pnpm ens:spike` proves that on chain — so the record on its name is
 * somebody else's statement about it, which is the only kind of record worth
 * reading.
 *
 * ONE TRANSACTION PER AGENT. Five records written one at a time would be five
 * transactions and five chances to half-finish. `multicall` makes an agent's
 * record land whole or not at all.
 *
 * WRITING IS ALLOWED TO FAIL. Every caller here is downstream of money that
 * has already moved: the market ran, the settlement paid out, and this is the
 * footnote. A failed write is logged and the next settlement overwrites it
 * anyway, because these are absolute counts rather than increments. Nothing
 * about the mechanism waits for Sepolia.
 */
import { encodeFunctionData, namehash, parseAbi, type Address } from 'viem';
import type { EnsSigner } from './client.js';

const RESOLVER_WRITE_ABI = parseAbi([
  'function setText(bytes32 node, string key, string value)',
  'function multicall(bytes[] data) returns (bytes[])',
]);

/**
 * An agent's record, in the shape the resolver stores: strings.
 *
 * Numbers are formatted by the caller rather than here, so what goes on chain
 * is decided in one place and can be read back and compared without guessing
 * at rounding.
 */
export interface AgentEnsRecord {
  readonly 'score.markets'?: string;
  readonly 'score.reports'?: string;
  readonly 'score.reference'?: string;
  readonly 'score.timeouts'?: string;
  readonly 'score.net'?: string;
  readonly 'hedera.account'?: string;
  readonly slices?: string;
}

export interface WriteResult {
  readonly name: string;
  readonly ok: boolean;
  readonly txHash?: `0x${string}`;
  readonly keys: readonly string[];
  readonly error?: string;
}

/**
 * Writes one agent's record.
 *
 * Never throws: the outcome is returned so a caller settling twenty agents can
 * report what landed instead of stopping at the first refusal.
 */
export async function writeAgentRecord(
  signer: EnsSigner,
  resolver: Address,
  name: string,
  record: AgentEnsRecord,
): Promise<WriteResult> {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined) as [
    string,
    string,
  ][];
  if (entries.length === 0) return { name, ok: true, keys: [] };

  const node = namehash(name);
  const calls = entries.map(([key, value]) =>
    encodeFunctionData({
      abi: RESOLVER_WRITE_ABI,
      functionName: 'setText',
      args: [node, key, value],
    }),
  );

  try {
    const { request } = await signer.publicClient.simulateContract({
      address: resolver,
      abi: RESOLVER_WRITE_ABI,
      functionName: 'multicall',
      args: [calls],
      account: signer.wallet.account!,
    });
    const txHash = await signer.wallet.writeContract(request);
    await signer.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { name, ok: true, txHash, keys: entries.map(([k]) => k) };
  } catch (e) {
    return {
      name,
      ok: false,
      keys: entries.map(([k]) => k),
      error: (e as Error).message.split('\n')[0],
    };
  }
}

/**
 * Formats a counted record for publication.
 *
 * Six decimals on the net, the same rounding the HCS ledger uses, so a number
 * read off ENS and a number recomputed from the topic agree instead of
 * differing in the last digit for no reason anybody can find.
 */
export function formatAgentRecord(counted: {
  bonded: number;
  reported: number;
  reference: number;
  timedOut: number;
  net: number;
}): AgentEnsRecord {
  return {
    'score.markets': String(counted.bonded),
    'score.reports': String(counted.reported),
    'score.reference': String(counted.reference),
    'score.timeouts': String(counted.timedOut),
    'score.net': (Math.round(counted.net * 1e6) / 1e6).toFixed(6),
  };
}
