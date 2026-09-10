/**
 * The HCS message schema — what actually goes on the ledger.
 *
 * WHY THIS IS NOT DECORATION. The SKC equilibrium argument rests on two
 * things: every agent sees every earlier report, and nobody can reorder or
 * retract one. HCS consensus timestamps give exactly that, so the topic is
 * not a log of the market — it IS the market's record, and the settlement can
 * be recomputed from it by anyone.
 *
 * ONE MESSAGE, ONE SEQUENCE NUMBER, ONE RUNNING HASH.
 *
 * The SDK silently splits a message larger than its chunk size into several
 * transactions, each with its own sequence number and running hash. STEP 14
 * derives the stopping dice from the running hash of the report that was just
 * written, so a report that quietly became two messages would produce two
 * hashes and there would be no single answer to "which one decided the
 * market". Every message is therefore size-checked here and submitted with
 * chunking disabled — oversized fails loudly instead of splitting.
 *
 * Encoding is canonical: fields are emitted in a fixed order so the same
 * message always produces the same bytes, and therefore the same digest.
 */
import type { Belief } from '@ethonline/core';

/**
 * Hedera's per-chunk limit. A message at or under this is guaranteed to land
 * as a single ordered entry.
 */
export const HCS_MAX_SINGLE_MESSAGE_BYTES = 1024;

export const HCS_MESSAGE_VERSION = 1;

export type HcsMessageType =
  | 'market-open'
  | 'report'
  | 'timeout'
  | 'market-close'
  | 'settlement';

interface HcsBase {
  readonly v: typeof HCS_MESSAGE_VERSION;
  readonly type: HcsMessageType;
  readonly marketId: string;
  /** Wall clock at the writer. The authoritative order is HCS consensus, not this. */
  readonly ts: number;
}

export interface MarketOpenMessage extends HcsBase {
  readonly type: 'market-open';
  readonly question: string;
  readonly prior: Belief;
  /** The parameters the market runs under, so the ledger is self-contained. */
  readonly params: { readonly k: number; readonly T: number; readonly alpha: number; readonly epsilon: number; readonly b: number; readonly R: number };
}

export interface ReportMessage extends HcsBase {
  readonly type: 'report';
  readonly position: number;
  readonly agentId: string;
  /** Clipped belief — what scoring uses. */
  readonly belief: Belief;
  /** What the agent actually sent, so the clip stays auditable. */
  readonly rawBelief: Belief;
  /** `sha256:...` over the evidence the agent used. Optional until STEP 20. */
  readonly evidenceDigest?: string;
}

export interface TimeoutMessage extends HcsBase {
  readonly type: 'timeout';
  readonly agentId: string;
  /** The position this agent would have filled had it answered. */
  readonly position: number;
}

export interface MarketCloseMessage extends HcsBase {
  readonly type: 'market-close';
  readonly reason: 'stopping-rule' | 'pool-exhausted';
  readonly reportCount: number;
  /** The terminal agent's report. Everyone is scored against this. */
  readonly reference?: Belief;
}

/**
 * One settlement payout, encoded as a tuple to fit a whole settlement inside
 * a single message: `[agentId, position, kind, amount]` where kind is `s`
 * for scored and `f` for flat-fee.
 */
export type CompactPayout = readonly [string, number, 's' | 'f', number];

export interface SettlementMessage extends HcsBase {
  readonly type: 'settlement';
  readonly reference?: Belief;
  readonly payouts: readonly CompactPayout[];
  readonly totals: {
    readonly deposit: number;
    readonly totalBonds: number;
    readonly scoreTotal: number;
    readonly bondsReturned: number;
    readonly timeoutSlash: number;
    readonly scoreSlash: number;
    readonly totalToAgents: number;
    readonly askerRefund: number;
  };
}

export type HcsMessage =
  | MarketOpenMessage
  | ReportMessage
  | TimeoutMessage
  | MarketCloseMessage
  | SettlementMessage;

/** Field order per message type. Fixed, so encoding is reproducible. */
const FIELD_ORDER: Record<HcsMessageType, readonly string[]> = {
  'market-open': ['v', 'type', 'marketId', 'ts', 'question', 'prior', 'params'],
  report: ['v', 'type', 'marketId', 'ts', 'position', 'agentId', 'belief', 'rawBelief', 'evidenceDigest'],
  timeout: ['v', 'type', 'marketId', 'ts', 'position', 'agentId'],
  'market-close': ['v', 'type', 'marketId', 'ts', 'reason', 'reportCount', 'reference'],
  settlement: ['v', 'type', 'marketId', 'ts', 'reference', 'payouts', 'totals'],
};

/** UTF-8 byte length, which is what Hedera counts. */
export function messageBytes(encoded: string): number {
  return Buffer.byteLength(encoded, 'utf-8');
}

/**
 * Serializes to canonical JSON.
 *
 * Undefined optional fields are dropped rather than emitted as `null`, so an
 * absent `evidenceDigest` and a missing one encode identically.
 */
export function encodeHcsMessage(msg: HcsMessage): string {
  const order = FIELD_ORDER[msg.type];
  if (!order) throw new Error(`Unknown HCS message type: ${(msg as HcsMessage).type}`);

  const record = msg as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of order) {
    const value = record[key];
    if (value !== undefined) out[key] = value;
  }
  return JSON.stringify(out);
}

/**
 * Rejects a message that would be split across chunks.
 *
 * Loud on purpose: a silently chunked report breaks the one-report-one-hash
 * property STEP 14 depends on.
 */
export function assertFitsSingleMessage(encoded: string): void {
  const bytes = messageBytes(encoded);
  if (bytes > HCS_MAX_SINGLE_MESSAGE_BYTES) {
    throw new Error(
      `HCS message is ${bytes} bytes, over the ${HCS_MAX_SINGLE_MESSAGE_BYTES} byte single-message ` +
        `limit. It would be split into several messages with separate sequence numbers and ` +
        `running hashes, which breaks the one-report-one-hash rule the stopping dice relies on. ` +
        `Shrink the payload instead of allowing the split.`,
    );
  }
}

function isBelief(v: unknown): v is Belief {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1])
  );
}

function isCompactPayout(v: unknown): v is CompactPayout {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    typeof v[0] === 'string' &&
    typeof v[1] === 'number' &&
    (v[2] === 's' || v[2] === 'f') &&
    typeof v[3] === 'number'
  );
}

/**
 * Parses and validates a message read back from the topic.
 *
 * Strict. A topic is public data and its contents are only as trustworthy as
 * the checks applied on the way in — anything that does not match the schema
 * is rejected rather than partially believed.
 */
export function decodeHcsMessage(raw: string): HcsMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`HCS message is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('HCS message must be a JSON object.');
  }
  const o = parsed as Record<string, unknown>;

  if (o['v'] !== HCS_MESSAGE_VERSION) {
    throw new Error(`HCS message version ${String(o['v'])}, expected ${HCS_MESSAGE_VERSION}.`);
  }
  if (typeof o['marketId'] !== 'string' || o['marketId'] === '') {
    throw new Error('HCS message is missing "marketId".');
  }
  if (typeof o['ts'] !== 'number' || !Number.isFinite(o['ts'])) {
    throw new Error('HCS message is missing a numeric "ts".');
  }

  switch (o['type']) {
    case 'market-open': {
      if (typeof o['question'] !== 'string') throw new Error('market-open needs "question".');
      if (!isBelief(o['prior'])) throw new Error('market-open needs a two-number "prior".');
      if (typeof o['params'] !== 'object' || o['params'] === null) {
        throw new Error('market-open needs "params".');
      }
      return o as unknown as MarketOpenMessage;
    }
    case 'report': {
      if (typeof o['position'] !== 'number' || o['position'] < 1) {
        throw new Error('report needs a "position" of at least 1.');
      }
      if (typeof o['agentId'] !== 'string' || o['agentId'] === '') {
        throw new Error('report needs "agentId".');
      }
      if (!isBelief(o['belief'])) throw new Error('report needs a two-number "belief".');
      if (!isBelief(o['rawBelief'])) throw new Error('report needs a two-number "rawBelief".');
      if (o['evidenceDigest'] !== undefined && typeof o['evidenceDigest'] !== 'string') {
        throw new Error('report "evidenceDigest" must be a string when present.');
      }
      return o as unknown as ReportMessage;
    }
    case 'timeout': {
      if (typeof o['agentId'] !== 'string' || o['agentId'] === '') {
        throw new Error('timeout needs "agentId".');
      }
      if (typeof o['position'] !== 'number') throw new Error('timeout needs "position".');
      return o as unknown as TimeoutMessage;
    }
    case 'market-close': {
      if (o['reason'] !== 'stopping-rule' && o['reason'] !== 'pool-exhausted') {
        throw new Error(`market-close has an unknown "reason": ${String(o['reason'])}`);
      }
      if (typeof o['reportCount'] !== 'number') throw new Error('market-close needs "reportCount".');
      if (o['reference'] !== undefined && !isBelief(o['reference'])) {
        throw new Error('market-close "reference" must be a two-number belief when present.');
      }
      return o as unknown as MarketCloseMessage;
    }
    case 'settlement': {
      if (!Array.isArray(o['payouts']) || !o['payouts'].every(isCompactPayout)) {
        throw new Error('settlement "payouts" must be [agentId, position, "s"|"f", amount] tuples.');
      }
      if (typeof o['totals'] !== 'object' || o['totals'] === null) {
        throw new Error('settlement needs "totals".');
      }
      if (o['reference'] !== undefined && !isBelief(o['reference'])) {
        throw new Error('settlement "reference" must be a two-number belief when present.');
      }
      return o as unknown as SettlementMessage;
    }
    default:
      throw new Error(`Unknown HCS message type: ${String(o['type'])}`);
  }
}
