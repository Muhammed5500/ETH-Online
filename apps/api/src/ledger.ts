/**
 * The ledger the API writes markets to.
 *
 * An interface rather than a direct call into `@ethonline/hedera`, for two
 * reasons that both matter:
 *
 *   The whole API becomes testable offline. Every route below writes to HCS,
 *   so without this seam not a single endpoint could be covered by `pnpm test`
 *   and the first time anything ran end to end would be against testnet.
 *
 *   STEP 16's orchestrator needs the same seam. It drives rounds by writing
 *   reports and reading back running hashes; being able to run that loop
 *   against a fake is the difference between debugging the mechanism and
 *   debugging the network.
 *
 * The production implementation is a thin pass-through — deliberately thin, so
 * the fake and the real thing cannot drift apart in behaviour.
 */
import type { Client } from '@hashgraph/sdk';
import { createMarketTopic, submitMessage, type HcsMessage } from '@ethonline/hedera';

export interface LedgerAppend {
  readonly sequenceNumber: number;
  readonly consensusTimestamp: string;
  /** 48 bytes. The stopping dice come from this (STEP 14). */
  readonly runningHash: Uint8Array;
}

export interface Ledger {
  createTopic(memo: string): Promise<string>;
  append(topicId: string, message: HcsMessage): Promise<LedgerAppend>;
}

/** Writes to real HCS topics. */
export function hederaLedger(client: Client): Ledger {
  return {
    async createTopic(memo) {
      const { topicId } = await createMarketTopic(client, { memo });
      return topicId;
    },
    async append(topicId, message) {
      const res = await submitMessage(client, topicId, message);
      return {
        sequenceNumber: res.sequenceNumber,
        consensusTimestamp: res.consensusTimestamp,
        runningHash: res.runningHash,
      };
    },
  };
}
