/**
 * Test doubles for the API.
 *
 * The fake ledger is what makes every route testable offline. It returns
 * deterministic 48-byte running hashes, so a market opened in a test behaves
 * exactly like one opened against HCS: the draws and the stopping rolls come
 * out of hashes, not out of `Math.random`.
 */
import { PrivateKey } from '@hashgraph/sdk';
import type { HcsMessage } from '@ethonline/hedera';
import type { Ledger, LedgerAppend } from '../src/ledger.js';
import { canonicalReportMessage, type ReportClaim } from '../src/signatures.js';

export interface FakeLedger extends Ledger {
  readonly topics: Map<string, HcsMessage[]>;
  /** Makes the next write fail, to cover the chain-is-down path. */
  failNextAppend(message?: string): void;
  failNextCreate(message?: string): void;
}

/**
 * Deterministic stand-in for an HCS running hash.
 *
 * Real running hashes chain over the previous one; this mimics that by mixing
 * the topic and sequence number, so consecutive writes give different hashes
 * and a market actually progresses.
 */
function fakeRunningHash(topicId: string, sequence: number): Uint8Array {
  // All arithmetic stays in 32-bit space via Math.imul. Written first with
  // plain `*`, which overflowed past 2^53, zeroed the low bits and made every
  // sequence number collapse to the SAME hash — a fake that quietly broke the
  // one property it exists to provide.
  const out = new Uint8Array(48);
  let seed = Math.imul(sequence, 2654435761) | 0;
  for (let i = 0; i < topicId.length; i++) {
    seed = Math.imul(seed ^ topicId.charCodeAt(i), 16777619) | 0;
  }
  for (let i = 0; i < out.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) | 0;
    out[i] = (seed >>> 16) & 0xff;
  }
  return out;
}

export function createFakeLedger(): FakeLedger {
  const topics = new Map<string, HcsMessage[]>();
  let created = 0;
  let appendFailure: string | undefined;
  let createFailure: string | undefined;

  return {
    topics,
    failNextAppend(message = 'ledger unavailable') {
      appendFailure = message;
    },
    failNextCreate(message = 'topic creation failed') {
      createFailure = message;
    },
    async createTopic(): Promise<string> {
      if (createFailure) {
        const m = createFailure;
        createFailure = undefined;
        throw new Error(m);
      }
      const topicId = `0.0.${900000 + ++created}`;
      topics.set(topicId, []);
      return topicId;
    },
    async append(topicId: string, message: HcsMessage): Promise<LedgerAppend> {
      if (appendFailure) {
        const m = appendFailure;
        appendFailure = undefined;
        throw new Error(m);
      }
      const list = topics.get(topicId) ?? [];
      list.push(message);
      topics.set(topicId, list);
      const sequenceNumber = list.length;
      return {
        sequenceNumber,
        consensusTimestamp: `178900${String(sequenceNumber).padStart(4, '0')}.000000001`,
        runningHash: fakeRunningHash(topicId, sequenceNumber),
      };
    },
  };
}

export interface TestAgent {
  readonly agentId: string;
  readonly accountId: string;
  readonly publicKey: string;
  readonly privateKey: PrivateKey;
  sign(claim: ReportClaim): string;
}

/** An agent with a real key pair, so signature checks exercise real crypto. */
export function makeTestAgent(agentId: string, accountIdSuffix = 1): TestAgent {
  const privateKey = PrivateKey.generateECDSA();
  return {
    agentId,
    accountId: `0.0.${100000 + accountIdSuffix}`,
    publicKey: privateKey.publicKey.toStringDer(),
    privateKey,
    sign(claim: ReportClaim): string {
      const bytes = new Uint8Array(Buffer.from(canonicalReportMessage(claim), 'utf-8'));
      return Buffer.from(privateKey.sign(bytes)).toString('hex');
    },
  };
}

export function agentPool(count: number): TestAgent[] {
  return Array.from({ length: count }, (_, i) =>
    makeTestAgent(`agent-${String(i + 1).padStart(2, '0')}`, i + 1),
  );
}
