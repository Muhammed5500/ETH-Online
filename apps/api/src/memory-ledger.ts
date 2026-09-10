/**
 * An in-memory ledger.
 *
 * Not a mock that lives in the test folder — a real implementation of the
 * `Ledger` interface that keeps the topic in a Map instead of on Hedera. Three
 * things use it and they must all see the same behaviour: the unit tests, the
 * demo server the frontend is built against, and the scripted demo scenarios
 * (STEP 31). Keeping a separate copy in the test helpers is how those three
 * quietly stop agreeing.
 *
 * THE RUNNING HASH IS THE PART THAT HAS TO BE RIGHT. A real HCS running hash
 * chains over the previous one, so every message produces a different 48-byte
 * value and the market's draws and stopping rolls actually move. A fake that
 * returns the same bytes twice would make every market behave identically and
 * the mechanism would look deterministic when it is not.
 */
import type { HcsMessage } from '@ethonline/hedera';
import type { Ledger, LedgerAppend } from './ledger.js';

export interface MemoryLedger extends Ledger {
  /** Topic id to the messages written to it, in order. */
  readonly topics: Map<string, HcsMessage[]>;
  /** Every message across every topic, for a demo that wants one feed. */
  all(): Array<{ topicId: string; message: HcsMessage }>;
}

/**
 * Deterministic stand-in for an HCS running hash.
 *
 * Written first with plain multiplication, which overflowed past 2^53, zeroed
 * the low bits and collapsed every sequence number onto the SAME hash — a fake
 * that broke the one property it exists to provide. All arithmetic stays in
 * 32-bit space through `Math.imul` for that reason.
 */
export function memoryRunningHash(topicId: string, sequence: number): Uint8Array {
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

export interface MemoryLedgerOptions {
  /** First topic number. Only so a demo's ids look distinct from a test's. */
  readonly topicSeed?: number;
}

export function createMemoryLedger(opts: MemoryLedgerOptions = {}): MemoryLedger {
  const topics = new Map<string, HcsMessage[]>();
  let created = opts.topicSeed ?? 900000;

  return {
    topics,

    all() {
      const out: Array<{ topicId: string; message: HcsMessage }> = [];
      for (const [topicId, messages] of topics) {
        for (const message of messages) out.push({ topicId, message });
      }
      return out;
    },

    async createTopic(): Promise<string> {
      const topicId = `0.0.${++created}`;
      topics.set(topicId, []);
      return topicId;
    },

    async append(topicId: string, message: HcsMessage): Promise<LedgerAppend> {
      const list = topics.get(topicId) ?? [];
      list.push(message);
      topics.set(topicId, list);
      const sequenceNumber = list.length;
      return {
        sequenceNumber,
        consensusTimestamp: `178900${String(sequenceNumber).padStart(4, '0')}.000000001`,
        runningHash: memoryRunningHash(topicId, sequenceNumber),
      };
    },
  };
}
