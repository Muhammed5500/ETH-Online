/**
 * Test doubles for the API.
 *
 * The ledger itself is NOT a double any more — it is `createMemoryLedger` from
 * `src/memory-ledger.ts`, the same in-memory implementation the demo server
 * and the scripted scenarios run against. What lives here is only the extra
 * the tests need on top of it: the ability to make a write fail on demand, so
 * the chain-is-down paths are covered.
 *
 * Sharing the implementation is the point. A separate fake would drift from
 * the one the demo uses, and the tests would then be evidence about a ledger
 * nobody runs.
 */
import { PrivateKey } from '@hashgraph/sdk';
import type { HcsMessage } from '@ethonline/hedera';
import { createMemoryLedger, type MemoryLedger } from '../src/memory-ledger.js';
import type { LedgerAppend } from '../src/ledger.js';
import {
  canonicalReportMessage,
  registrationMessageBytes,
  type ReportClaim,
} from '../src/signatures.js';

export interface FakeLedger extends MemoryLedger {
  /** Makes the next write fail, to cover the chain-is-down path. */
  failNextAppend(message?: string): void;
  failNextCreate(message?: string): void;
}

export function createFakeLedger(): FakeLedger {
  const inner = createMemoryLedger();
  let appendFailure: string | undefined;
  let createFailure: string | undefined;

  return {
    topics: inner.topics,
    all: inner.all,

    failNextAppend(message = 'ledger unavailable') {
      appendFailure = message;
    },
    failNextCreate(message = 'topic creation failed') {
      createFailure = message;
    },

    async createTopic(memo: string): Promise<string> {
      if (createFailure) {
        const m = createFailure;
        createFailure = undefined;
        throw new Error(m);
      }
      return inner.createTopic(memo);
    },

    async append(topicId: string, message: HcsMessage): Promise<LedgerAppend> {
      if (appendFailure) {
        const m = appendFailure;
        appendFailure = undefined;
        throw new Error(m);
      }
      return inner.append(topicId, message);
    },
  };
}

export interface TestAgent {
  readonly agentId: string;
  readonly accountId: string;
  readonly publicKey: string;
  readonly privateKey: PrivateKey;
  sign(claim: ReportClaim): string;
  /** A registration body, signed the way a real agent signs one. */
  registration(extras?: {
    endpoint?: string;
    sliceIds?: readonly string[];
    /** Claim a different id or account, for the impostor cases. */
    agentId?: string;
    accountId?: string;
  }): Record<string, unknown>;
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
    registration(extras = {}) {
      const claim = {
        agentId: extras.agentId ?? agentId,
        accountId: extras.accountId ?? `0.0.${100000 + accountIdSuffix}`,
        publicKey: privateKey.publicKey.toStringDer(),
        ...(extras.endpoint ? { endpoint: extras.endpoint } : {}),
        ...(extras.sliceIds ? { sliceIds: extras.sliceIds } : {}),
        issuedAt: Date.now(),
      };
      return {
        ...claim,
        signature: Buffer.from(privateKey.sign(registrationMessageBytes(claim))).toString('hex'),
      };
    },
  };
}

export function agentPool(count: number): TestAgent[] {
  return Array.from({ length: count }, (_, i) =>
    makeTestAgent(`agent-${String(i + 1).padStart(2, '0')}`, i + 1),
  );
}
