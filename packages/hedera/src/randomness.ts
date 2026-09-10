/**
 * Randomness derived from the HCS running hash.
 *
 * Every message on a topic produces a 48-byte running hash computed over the
 * previous hash, the topic id, the sequence number, the consensus timestamp
 * and the message bytes. Two properties follow, and the mechanism needs both:
 *
 *   Unpredictable beforehand. The consensus timestamp is assigned by the
 *   network, not the sender, so nobody — including us — can know a message's
 *   running hash before it reaches consensus.
 *
 *   Verifiable afterwards. The hash is public on the mirror node, so anyone
 *   can recompute a decision and check it was not fabricated. STEP 13 proved
 *   the hash we act on and the hash a third party reads are byte-identical.
 *
 * This module imports no SDK and no crypto: a decision can be rechecked with
 * nothing but the bytes from a public API and the arithmetic below.
 */
import type { RandomSource } from '@ethonline/core';

/** SHA-384 output, as returned by Hedera. Confirmed on testnet in STEP 13. */
export const HCS_RUNNING_HASH_BYTES = 48;

/**
 * What a value is being drawn for.
 *
 * WHY PURPOSES EXIST AT ALL — this prevents a real bias, not a theoretical one.
 *
 * One round consumes randomness twice: a stopping roll after report N is
 * written, and, if the market survives, the draw of agent N+1. Both would
 * naturally reach for the newest running hash.
 *
 * If both read the SAME bytes, the draw is poisoned. Reaching the draw at all
 * means the stopping roll failed, which means `u >= alpha`. Feeding that same
 * `u` into `floor(u * poolSize)` makes the first `alpha` fraction of the pool
 * unreachable forever — with alpha = 1/8, the first 12.5% of agents could
 * never be drawn.
 *
 * So each purpose reads a different 8-byte window of the hash. The window is
 * plain arithmetic rather than a second round of hashing, which keeps
 * verification possible in a browser with no crypto library.
 */
export type RandomnessPurpose = 'stop' | 'draw';

/**
 * Byte offset per purpose.
 *
 * `stop` reads bytes 0-7, which keeps the stopping rule exactly as specified:
 * the first eight bytes of the running hash, big-endian. `draw` reads bytes
 * 8-15. The hash is SHA-384 output, so disjoint windows are independent for
 * this purpose.
 */
const PURPOSE_OFFSET: Record<RandomnessPurpose, number> = {
  stop: 0,
  draw: 8,
};

/**
 * Maps a running hash to `[0, 1)`.
 *
 * Takes eight big-endian bytes and keeps the top 53 bits, the exact precision
 * of a JavaScript double.
 *
 * THE 53-BIT SHIFT IS NOT A DETAIL. Dividing the full uint64 by 2^64 looks
 * equivalent and is not: `Number(2n**64n - 1n)` rounds UP to 2^64, so the
 * division returns exactly 1.0 and the interval is no longer half-open.
 * A 1.0 would push `floor(u * poolSize)` one past the end of the pool. Taking
 * the top 53 bits makes the largest possible result `(2^53-1)/2^53`, which is
 * strictly below 1 with no rounding involved.
 */
export function hashToUnitInterval(
  runningHash: Uint8Array,
  purpose: RandomnessPurpose = 'stop',
): number {
  const offset = PURPOSE_OFFSET[purpose];
  if (offset === undefined) {
    throw new Error(`Unknown randomness purpose: ${String(purpose)}`);
  }
  if (runningHash.length < offset + 8) {
    throw new Error(
      `Running hash is ${runningHash.length} bytes; purpose "${purpose}" needs at least ` +
        `${offset + 8}. A Hedera running hash is ${HCS_RUNNING_HASH_BYTES} bytes.`,
    );
  }

  let value = 0n;
  for (let i = offset; i < offset + 8; i++) {
    value = (value << 8n) | BigInt(runningHash[i]!);
  }
  // Top 53 bits: the most a double can hold exactly.
  return Number(value >> 11n) / 2 ** 53;
}

/**
 * The stopping rule: `u < alpha` closes the market.
 *
 * Deliberately trivial. This is the line a sceptical reader has to be able to
 * check by hand against a hash they fetched themselves.
 */
export function shouldStop(runningHash: Uint8Array, alpha: number): boolean {
  assertAlpha(alpha);
  return hashToUnitInterval(runningHash, 'stop') < alpha;
}

function assertAlpha(alpha: number): void {
  if (!Number.isFinite(alpha) || !(alpha > 0 && alpha < 1)) {
    throw new Error(`alpha must be in (0, 1), got: ${alpha}`);
  }
}

/**
 * Rechecks a closing decision after the fact.
 *
 * The point of the whole design: someone who does not trust the orchestrator
 * pulls the topic from the mirror node, runs this over each report's running
 * hash, and confirms the market closed where it says it closed — and, just as
 * importantly, that it did not keep running past a roll that should have
 * ended it.
 */
export function verifyStoppingDecision(
  runningHash: Uint8Array,
  alpha: number,
  didStop: boolean,
): boolean {
  return shouldStop(runningHash, alpha) === didStop;
}

export interface RandomnessDraw {
  readonly label: string;
  readonly purpose: RandomnessPurpose;
  readonly runningHashHex: string;
  readonly value: number;
}

/**
 * Backs `core`'s `RandomSource` with the live HCS ledger.
 *
 * The orchestrator calls `update()` with the running hash of every message it
 * writes, and `core` then pulls decisions out of it exactly as it pulls them
 * from a seeded generator in the tests. The mechanism does not know the
 * difference, which is why the test suite is evidence about production.
 *
 * The purpose comes from the label `core` already uses (`draw-3`, `stop-3`),
 * so no coordination is needed beyond the naming convention that was in
 * `market.ts` from the start.
 */
export class HcsRandomSource implements RandomSource {
  private current: Uint8Array | undefined;
  /** Every value handed out, so a run can be replayed and checked. */
  readonly draws: RandomnessDraw[] = [];

  constructor(initialHash?: Uint8Array) {
    if (initialHash) this.update(initialHash);
  }

  /** Records the running hash of the message that was just written. */
  update(runningHash: Uint8Array): void {
    if (runningHash.length < HCS_RUNNING_HASH_BYTES) {
      throw new Error(
        `Expected a ${HCS_RUNNING_HASH_BYTES}-byte running hash, got ${runningHash.length}.`,
      );
    }
    this.current = runningHash;
  }

  /** The hash decisions are currently being drawn from. */
  get runningHash(): Uint8Array | undefined {
    return this.current;
  }

  next(label: string): number {
    if (!this.current) {
      // Never fall back to a local generator. A market whose stopping rule
      // came from Math.random is unverifiable, and would look identical to
      // one that did not.
      throw new Error(
        `No HCS running hash available for "${label}". The market-open message must be ` +
          `written and its running hash passed to update() before any decision is drawn.`,
      );
    }
    const purpose = purposeFromLabel(label);
    const value = hashToUnitInterval(this.current, purpose);
    this.draws.push({
      label,
      purpose,
      runningHashHex: toHex(this.current),
      value,
    });
    return value;
  }
}

/** `draw-3` -> draw, `stop-3` -> stop. The convention `market.ts` already uses. */
export function purposeFromLabel(label: string): RandomnessPurpose {
  if (label.startsWith('draw')) return 'draw';
  if (label.startsWith('stop')) return 'stop';
  throw new Error(
    `Cannot tell what "${label}" is for. Labels must start with "draw" or "stop" so the ` +
      `two decisions read different bytes of the running hash.`,
  );
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`Hex string has an odd length: ${hex.length}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`Not valid hex: ${hex}`);
    out[i] = byte;
  }
  return out;
}
