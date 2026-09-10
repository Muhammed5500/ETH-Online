/**
 * The HCS report ledger.
 *
 * TOPIC KEY POLICY — decided here, flagged during the STEP 2 preflight.
 *
 *   No admin key.  A topic created without one can never be updated or
 *                  deleted, by us or by anyone. That is the whole audit-trail
 *                  claim: the report log is not merely append-only by
 *                  convention, it is permanent by construction. The cost is
 *                  that test topics accumulate on testnet forever, which is
 *                  a price worth paying.
 *
 *   Submit key.    Set to the operator. Without one, anyone could append a
 *                  forged `report` message to our ledger and the record would
 *                  no longer mean anything. A submit key controls who WRITES;
 *                  it does not let us rewrite or remove what is already
 *                  there, and reading stays open to everybody. Append-only,
 *                  with a known author, verifiable by anyone.
 *
 * Because there is no admin key, the submit key is fixed for the life of the
 * topic and cannot be rotated. Markets are short-lived and each gets its own
 * topic, so that is acceptable.
 */
import {
  PrivateKey,
  TopicCreateTransaction,
  TopicId,
  TopicMessageSubmitTransaction,
  type Client,
} from '@hashgraph/sdk';
import { withRetry, type RetryOptions } from './retry.js';
import {
  assertFitsSingleMessage,
  encodeHcsMessage,
  messageBytes,
  type HcsMessage,
} from './hcs-message.js';

export interface CreateTopicOptions {
  readonly memo: string;
  /**
   * Restricts who may append. Defaults to the operator key.
   *
   * Pass `null` for a fully open topic — only sensible for throwaway
   * experiments, never for a market whose settlement is computed from it.
   */
  readonly submitKey?: string | null;
  readonly retry?: RetryOptions;
}

/** Creates the topic for one market. Immutable: no admin key is set. */
export async function createMarketTopic(
  client: Client,
  opts: CreateTopicOptions,
): Promise<{ topicId: string; transactionId: string }> {
  const tx = new TopicCreateTransaction().setTopicMemo(opts.memo);

  if (opts.submitKey === undefined) {
    const operatorKey = client.operatorPublicKey;
    if (!operatorKey) {
      throw new Error('Client has no operator key, so no submit key can be derived.');
    }
    tx.setSubmitKey(operatorKey);
  } else if (opts.submitKey !== null) {
    tx.setSubmitKey(PrivateKey.fromStringECDSA(opts.submitKey).publicKey);
  }

  const frozen = tx.freezeWith(client);
  const { receipt, transactionId } = await withRetry(async () => {
    const response = await frozen.execute(client);
    return { receipt: await response.getReceipt(client), transactionId: response.transactionId };
  }, opts.retry);

  const topicId = receipt.topicId;
  if (!topicId) {
    throw new Error(`Topic creation returned no topic id (status: ${receipt.status.toString()})`);
  }
  return { topicId: topicId.toString(), transactionId: transactionId.toString() };
}

export interface SubmitResult {
  readonly sequenceNumber: number;
  /** Hedera consensus time, `seconds.nanoseconds`. The authoritative ordering. */
  readonly consensusTimestamp: string;
  /** 48 bytes. STEP 14 derives the stopping dice from this. */
  readonly runningHash: Uint8Array;
  readonly transactionId: string;
  readonly bytes: number;
}

export interface SubmitOptions {
  readonly retry?: RetryOptions;
}

/**
 * Appends one message and returns its consensus position.
 *
 * Chunking is disabled (`setMaxChunks(1)`) and the payload is size-checked
 * first, so a message either lands as exactly one ordered entry or fails.
 * See the note in `hcs-message.ts` for why that matters.
 *
 * The record, not just the receipt, is fetched because the consensus
 * timestamp only exists on the record. That costs one extra paid query per
 * message and is worth it: the timestamp is what makes the ordering claim
 * checkable by someone who does not trust us.
 */
export async function submitMessage(
  client: Client,
  topicId: string,
  message: HcsMessage,
  opts: SubmitOptions = {},
): Promise<SubmitResult> {
  const encoded = encodeHcsMessage(message);
  assertFitsSingleMessage(encoded);

  const tx = new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(topicId))
    .setMessage(encoded)
    .setMaxChunks(1);

  const frozen = tx.freezeWith(client);
  const { record, transactionId } = await withRetry(async () => {
    const response = await frozen.execute(client);
    return { record: await response.getRecord(client), transactionId: response.transactionId };
  }, opts.retry);

  const { receipt } = record;
  const sequenceNumber = receipt.topicSequenceNumber;
  const runningHash = receipt.topicRunningHash;
  if (sequenceNumber === null || runningHash === null || runningHash === undefined) {
    throw new Error(
      `Topic receipt carried no sequence number or running hash (status: ${receipt.status.toString()}). ` +
        `STEP 14 cannot derive randomness without it.`,
    );
  }

  return {
    sequenceNumber: Number(sequenceNumber.toString()),
    consensusTimestamp: record.consensusTimestamp.toString(),
    runningHash,
    transactionId: transactionId.toString(),
    bytes: messageBytes(encoded),
  };
}

export {
  mirrorNodeUrl,
  parseMirrorMessages,
  readTopicMessages,
  type ReadTopicOptions,
  type TopicEntry,
} from './hcs-read.js';
