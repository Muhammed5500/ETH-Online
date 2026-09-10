/**
 * Reading the ledger back, over plain HTTP.
 *
 * This module imports NOTHING from `@hashgraph/sdk`, and that is the point
 * rather than an optimisation. The audit-trail claim is that anybody can
 * check the market for themselves: fetch the topic, decode the messages,
 * recompute the settlement. If verifying required the writer's toolchain the
 * claim would be much weaker. A browser and `fetch` are enough.
 *
 * (It also keeps the SDK out of the unit test run, which stays in seconds.)
 */
import type { HederaNetwork } from './env.js';
import { decodeHcsMessage, type HcsMessage } from './hcs-message.js';

/**
 * Mirror node REST endpoint.
 *
 * Reads go through the mirror node rather than a gRPC subscription: the topic
 * has to be readable as a finite, ordered list by anyone with a browser, which
 * is the point of publishing it. Messages appear a few seconds after consensus.
 */
export function mirrorNodeUrl(network: HederaNetwork): string {
  switch (network) {
    case 'mainnet':
      return 'https://mainnet-public.mirrornode.hedera.com';
    case 'previewnet':
      return 'https://previewnet.mirrornode.hedera.com';
    case 'local':
      return 'http://localhost:5551';
    default:
      return 'https://testnet.mirrornode.hedera.com';
  }
}

export interface TopicEntry {
  readonly sequenceNumber: number;
  readonly consensusTimestamp: string;
  readonly runningHash: Uint8Array;
  readonly raw: string;
  /** Parsed payload, or `undefined` if it did not match our schema. */
  readonly message?: HcsMessage;
  /** Why parsing failed, when it did. Foreign messages are reported, not thrown on. */
  readonly parseError?: string;
}

interface MirrorMessage {
  consensus_timestamp?: unknown;
  message?: unknown;
  running_hash?: unknown;
  sequence_number?: unknown;
}

/**
 * Turns a mirror node page into entries. Pure, so it is unit-tested without a
 * network.
 *
 * A message that fails to parse is kept with its error rather than dropped or
 * thrown on. The topic is public and, if the submit key were ever absent,
 * could contain anything; the reader's job is to report exactly what is there.
 */
export function parseMirrorMessages(payload: unknown): TopicEntry[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Mirror node response was not an object.');
  }
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    throw new Error('Mirror node response has no "messages" array.');
  }

  return messages.map((m: MirrorMessage) => {
    const sequenceNumber = Number(m.sequence_number);
    const consensusTimestamp = String(m.consensus_timestamp ?? '');
    const runningHash = Buffer.from(String(m.running_hash ?? ''), 'base64');
    const raw = Buffer.from(String(m.message ?? ''), 'base64').toString('utf-8');

    try {
      return {
        sequenceNumber,
        consensusTimestamp,
        runningHash: new Uint8Array(runningHash),
        raw,
        message: decodeHcsMessage(raw),
      };
    } catch (e) {
      return {
        sequenceNumber,
        consensusTimestamp,
        runningHash: new Uint8Array(runningHash),
        raw,
        parseError: e instanceof Error ? e.message : String(e),
      };
    }
  });
}

export interface ReadTopicOptions {
  /** Page size asked of the mirror node. */
  readonly limit?: number;
  /** Hard stop, so a hostile or runaway topic cannot exhaust memory. */
  readonly maxMessages?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Reads every message on a topic, in consensus order.
 *
 * Follows the mirror node's pagination links. Ordering comes from the network,
 * not from us, and is asserted by the caller in the integration test.
 */
export async function readTopicMessages(
  network: HederaNetwork,
  topicId: string,
  opts: ReadTopicOptions = {},
): Promise<TopicEntry[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? 100;
  const maxMessages = opts.maxMessages ?? 10_000;
  const base = mirrorNodeUrl(network);

  let next: string | null = `/api/v1/topics/${topicId}/messages?order=asc&limit=${limit}`;
  const out: TopicEntry[] = [];

  while (next && out.length < maxMessages) {
    const res: Response = await doFetch(`${base}${next}`);
    if (!res.ok) {
      throw new Error(`Mirror node returned ${res.status} for topic ${topicId}: ${await res.text()}`);
    }
    const body: unknown = await res.json();
    out.push(...parseMirrorMessages(body));

    const links = (body as { links?: { next?: unknown } }).links;
    next = typeof links?.next === 'string' && links.next !== '' ? links.next : null;
  }

  return out.slice(0, maxMessages);
}
