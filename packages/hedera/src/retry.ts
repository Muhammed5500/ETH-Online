/**
 * Retry policy for Hedera calls.
 *
 * A WORD ON RETRIES, BECAUSE THIS ONE MOVES MONEY.
 *
 * The dangerous failure is not "the call failed" — it is "the call timed out
 * and we do not know whether it landed". Blindly re-running a transfer in that
 * state pays twice.
 *
 * Two rules keep that from happening:
 *
 *   1. Only genuinely transient conditions are retried. BUSY and a dropped
 *      connection mean the network never processed the request. An invalid
 *      signature or an empty balance will fail identically forever, and
 *      retrying those just burns fees and hides the real error.
 *   2. Transactions are frozen before the first attempt, so every retry
 *      carries the SAME transaction id. If the first attempt did land, the
 *      retry comes back DUPLICATE_TRANSACTION instead of transferring again.
 *      That is what makes a retry safe rather than merely convenient.
 *
 * This module deliberately imports nothing from `@hashgraph/sdk`. The SDK is
 * heavy to load and `pnpm test` has to stay in the seconds, so the policy
 * lives apart from the client that uses it and stays unit-testable on its own.
 */

/**
 * Conditions where the request provably did not take effect, so running it
 * again is safe and useful.
 */
const TRANSIENT_STATUSES: readonly string[] = [
  'BUSY',
  'PLATFORM_NOT_ACTIVE',
  'PLATFORM_TRANSACTION_NOT_CREATED',
  'THROTTLED_AT_CONSENSUS',
];

/** Transport-level failures, which likewise mean nothing was accepted. */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /socket hang up/i,
  /UNAVAILABLE/i,
  /DEADLINE_EXCEEDED/i,
  /RESOURCE_EXHAUSTED/i,
  /max attempts.*exceeded/i,
  /GRPC/i,
];

/**
 * Whether a failure is worth another attempt.
 *
 * Deliberately a whitelist. An unrecognised error is treated as permanent,
 * because the cost of wrongly retrying a payment is much higher than the cost
 * of surfacing an error we could have recovered from.
 */
export function isTransientHederaError(err: unknown): boolean {
  const status = (err as { status?: { toString(): string } })?.status;
  if (status && TRANSIENT_STATUSES.includes(status.toString())) return true;

  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}

export interface RetryOptions {
  /** Total attempts, including the first. Default 4. */
  readonly attempts?: number;
  /** First backoff delay in ms; doubles each time. Default 500. */
  readonly baseDelayMs?: number;
  /** Ceiling on a single backoff delay. Default 8000. */
  readonly maxDelayMs?: number;
  /** Called before each retry. Useful for logging progress in scripts. */
  readonly onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  /** Injected for tests so the suite never actually waits. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying only transient failures with exponential backoff.
 *
 * Safe for queries unconditionally. Safe for a transaction ONLY when `fn`
 * re-executes an already-frozen transaction, so the retry reuses the original
 * transaction id — see the note at the top of this file.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 8000;
  const sleep = opts.sleep ?? defaultSleep;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`attempts must be a positive integer, got: ${attempts}`);
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isTransientHederaError(err)) throw err;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      opts.onRetry?.(attempt, delay, err);
      await sleep(delay);
    }
  }
  throw lastError;
}
