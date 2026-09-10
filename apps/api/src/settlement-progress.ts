/**
 * Settlement progress — what has actually been paid, and what is merely believed.
 *
 * THE DEFECT THIS CLOSES. STEP 16 shipped a settlement that pays the plan in
 * chunks, because Hedera caps how many accounts one transfer may touch and
 * twenty agents plus the asker do not fit in one. Those chunks are not atomic
 * with respect to each other, and the step log recorded two consequences that
 * were left open:
 *
 *   1. A settlement can stop halfway.
 *   2. Running it again pays the chunks that already went through a second time.
 *
 * The second one is the serious one. It is not a crash, it is money leaving
 * the treasury twice, and nothing in the system would notice — the accounting
 * invariants in `core` all hold, because they describe what SHOULD be paid,
 * not what was.
 *
 * WHAT MAKES IT SAFE NOW. Three rules, in order of how much each is worth:
 *
 *   The plan is computed ONCE and kept. A resumed settlement never recomputes,
 *   so the lines it skips and the lines it pays are provably the same lines.
 *
 *   A chunk that has not confirmably been sent is `unknown`, never `failed`.
 *   When a transfer throws we do not know whether it landed. Treating that as
 *   "did not land" is precisely the assumption that pays twice, so an unknown
 *   chunk blocks the settlement until a person says what they found on chain.
 *
 *   Progress is written to HCS as it happens. Memory does not survive a
 *   restart, and a restart is exactly when a re-run is most likely. The topic
 *   does survive, it is ordered by consensus, and anyone can check it against
 *   HashScan.
 */
import type { Settlement } from '@ethonline/core';
import type { TransferLine, TransferPlan } from './settlement-plan.js';

export type ChunkState =
  /** Not attempted yet. Safe to send. */
  | 'pending'
  /** Confirmed on chain. Never sent again. */
  | 'sent'
  /**
   * Attempted, outcome not known.
   *
   * The transfer threw. It may have landed. Only a person looking at the
   * treasury's transaction history can say, and until they do this chunk is
   * neither paid nor unpaid.
   */
  | 'unknown';

export interface ChunkRecord {
  readonly index: number;
  readonly lines: readonly TransferLine[];
  /** What this chunk credits in total. The treasury is debited the same. */
  readonly amountTinybar: bigint;
  state: ChunkState;
  transactionId?: string;
  status?: string;
  /** Why the attempt did not confirm, when it did not. */
  error?: string;
  attemptedAt?: number;
  /** What a person checked, when they resolved an `unknown`. */
  resolution?: string;
}

export interface SettlementProgress {
  readonly marketId: string;
  /** Computed once. A resume reuses this rather than recomputing. */
  readonly settlement: Settlement;
  readonly plan: TransferPlan;
  readonly chunks: ChunkRecord[];
  readonly createdAt: number;
}

export function chunkAmount(lines: readonly TransferLine[]): bigint {
  return lines.reduce((sum, l) => sum + l.amountTinybar, 0n);
}

/** Turns a chunked plan into a progress record with everything still pending. */
export function createProgress(
  marketId: string,
  settlement: Settlement,
  plan: TransferPlan,
  chunks: readonly (readonly TransferLine[])[],
  now: number,
): SettlementProgress {
  return {
    marketId,
    settlement,
    plan,
    chunks: chunks.map((lines, index) => ({
      index,
      lines,
      amountTinybar: chunkAmount(lines),
      state: 'pending' as ChunkState,
    })),
    createdAt: now,
  };
}

export interface ProgressSummary {
  readonly total: number;
  readonly sent: number;
  readonly pending: number;
  readonly unknown: number;
  /** Confirmed paid out, in tinybar. */
  readonly sentTinybar: bigint;
  /** Neither paid nor unpaid. Needs a person. */
  readonly unknownTinybar: bigint;
  readonly pendingTinybar: bigint;
  readonly complete: boolean;
  /** True while an `unknown` chunk is unresolved. Settlement cannot continue. */
  readonly blocked: boolean;
}

export function summarize(progress: SettlementProgress): ProgressSummary {
  let sent = 0;
  let pending = 0;
  let unknown = 0;
  let sentTinybar = 0n;
  let unknownTinybar = 0n;
  let pendingTinybar = 0n;

  for (const c of progress.chunks) {
    if (c.state === 'sent') {
      sent++;
      sentTinybar += c.amountTinybar;
    } else if (c.state === 'unknown') {
      unknown++;
      unknownTinybar += c.amountTinybar;
    } else {
      pending++;
      pendingTinybar += c.amountTinybar;
    }
  }

  return {
    total: progress.chunks.length,
    sent,
    pending,
    unknown,
    sentTinybar,
    unknownTinybar,
    pendingTinybar,
    complete: unknown === 0 && pending === 0,
    blocked: unknown > 0,
  };
}

/**
 * The chunks a resume should attempt.
 *
 * Empty while anything is `unknown`: continuing past one would mean issuing
 * more payments while the treasury's real balance is uncertain, and the person
 * resolving the unknown chunk has to look at the same history either way.
 */
export function nextChunks(progress: SettlementProgress): ChunkRecord[] {
  if (summarize(progress).blocked) return [];
  return progress.chunks.filter((c) => c.state === 'pending');
}

/** A one-line description of where a settlement stands, for logs and errors. */
export function describeProgress(progress: SettlementProgress): string {
  const s = summarize(progress);
  return (
    `${s.sent}/${s.total} chunks sent` +
    (s.unknown > 0 ? `, ${s.unknown} with an UNKNOWN outcome` : '') +
    (s.pending > 0 ? `, ${s.pending} still pending` : '')
  );
}

/**
 * Records what a person found when they checked an `unknown` chunk on chain.
 *
 * `paid` marks it sent and the settlement moves on without re-sending it.
 * `not-paid` puts it back to pending so the resume pays it.
 *
 * Deliberately requires a human decision rather than guessing. There is a
 * version of this that queries a mirror node and decides for itself, and it
 * belongs here eventually — but a wrong automatic answer in the `paid`
 * direction silently underpays an agent, and in the `not-paid` direction pays
 * twice. Neither is a decision worth making from an inference.
 */
export function resolveChunk(
  progress: SettlementProgress,
  index: number,
  outcome: 'paid' | 'not-paid',
  evidence: string,
): ChunkRecord {
  const chunk = progress.chunks[index];
  if (!chunk) {
    throw new Error(
      `Market ${progress.marketId} has no chunk ${index}; it has ${progress.chunks.length}.`,
    );
  }
  if (chunk.state !== 'unknown') {
    throw new Error(
      `Chunk ${index} of ${progress.marketId} is "${chunk.state}", not "unknown". ` +
        `Only a chunk whose outcome is genuinely unknown can be resolved — forcing a "sent" ` +
        `chunk back to pending would pay it twice.`,
    );
  }
  if (evidence.trim() === '') {
    throw new Error(
      'A resolution needs evidence: what was checked, and where. It goes on the public record ' +
        'next to the payment it explains.',
    );
  }

  chunk.state = outcome === 'paid' ? 'sent' : 'pending';
  chunk.resolution = evidence.trim();
  return chunk;
}
