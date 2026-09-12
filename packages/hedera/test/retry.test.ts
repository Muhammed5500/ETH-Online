/**
 * Retry tests.
 *
 * The point of this file is not that retries work — it is that they DON'T
 * happen when they must not. Re-running a transfer whose outcome is unknown
 * pays twice, so an unrecognised error has to be treated as permanent.
 */
import { describe, expect, it, vi } from 'vitest';
import { isExpiredTransaction, isTransientHederaError, withFreshTransaction, withRetry } from '../src/retry.js';

/** Mimics the SDK's StatusError shape: an error carrying a `status`. */
function statusError(status: string): Error {
  const e = new Error(`receipt for transaction failed with status ${status}`);
  (e as unknown as { status: { toString(): string } }).status = { toString: () => status };
  return e;
}

const noSleep = async (): Promise<void> => {};

describe('isTransientHederaError', () => {
  it('accepts statuses that mean the network never processed the request', () => {
    expect(isTransientHederaError(statusError('BUSY'))).toBe(true);
    expect(isTransientHederaError(statusError('PLATFORM_NOT_ACTIVE'))).toBe(true);
    expect(isTransientHederaError(statusError('PLATFORM_TRANSACTION_NOT_CREATED'))).toBe(true);
  });

  it('accepts transport failures', () => {
    expect(isTransientHederaError(new Error('read ECONNRESET'))).toBe(true);
    expect(isTransientHederaError(new Error('14 UNAVAILABLE: no connection'))).toBe(true);
    expect(isTransientHederaError(new Error('socket hang up'))).toBe(true);
  });

  it('REFUSES statuses that will fail identically forever', () => {
    // Retrying these burns fees and buries the real cause.
    expect(isTransientHederaError(statusError('INSUFFICIENT_PAYER_BALANCE'))).toBe(false);
    expect(isTransientHederaError(statusError('INVALID_SIGNATURE'))).toBe(false);
    expect(isTransientHederaError(statusError('INVALID_ACCOUNT_ID'))).toBe(false);
    expect(isTransientHederaError(statusError('INSUFFICIENT_ACCOUNT_BALANCE'))).toBe(false);
  });

  it('REFUSES DUPLICATE_TRANSACTION — it means the first attempt landed', () => {
    expect(isTransientHederaError(statusError('DUPLICATE_TRANSACTION'))).toBe(false);
  });

  it('treats an unrecognised error as permanent', () => {
    // The whitelist is the safety property. Wrongly retrying a payment costs
    // far more than surfacing an error we might have recovered from.
    expect(isTransientHederaError(new Error('something nobody has seen before'))).toBe(false);
    expect(isTransientHederaError('a bare string')).toBe(false);
    expect(isTransientHederaError(undefined)).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the first success without retrying', async () => {
    const fn = vi.fn(async () => 'ok');
    expect(await withRetry(fn, { sleep: noSleep })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and then succeeds', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw statusError('BUSY');
      return 'ok';
    });
    expect(await withRetry(fn, { sleep: noSleep })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a permanent failure', async () => {
    const fn = vi.fn(async () => {
      throw statusError('INSUFFICIENT_PAYER_BALANCE');
    });
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow(/INSUFFICIENT_PAYER_BALANCE/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt budget and rethrows the last error', async () => {
    const fn = vi.fn(async () => {
      throw statusError('BUSY');
    });
    await expect(withRetry(fn, { attempts: 3, sleep: noSleep })).rejects.toThrow(/BUSY/);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('backs off exponentially up to the ceiling', async () => {
    const delays: number[] = [];
    const fn = async () => {
      throw statusError('BUSY');
    };
    await expect(
      withRetry(fn, {
        attempts: 6,
        baseDelayMs: 100,
        maxDelayMs: 500,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).rejects.toThrow();
    expect(delays).toEqual([100, 200, 400, 500, 500]);
  });

  it('reports each retry so scripts can show progress', async () => {
    const seen: number[] = [];
    const fn = async () => {
      throw statusError('BUSY');
    };
    await expect(
      withRetry(fn, { attempts: 3, sleep: noSleep, onRetry: (a) => seen.push(a) }),
    ).rejects.toThrow();
    expect(seen).toEqual([1, 2]);
  });

  it('rejects a nonsense attempt budget', async () => {
    await expect(withRetry(async () => 1, { attempts: 0 })).rejects.toThrow(/attempts/);
  });
});

describe('expired transactions', () => {
  it('recognises the status and the message form', () => {
    expect(isExpiredTransaction({ status: { toString: () => 'TRANSACTION_EXPIRED' } })).toBe(true);
    expect(
      isExpiredTransaction(
        new Error('transaction 0.0.1@1.2 failed precheck with status TRANSACTION_EXPIRED'),
      ),
    ).toBe(true);
    expect(isExpiredTransaction(new Error('INSUFFICIENT_PAYER_BALANCE'))).toBe(false);
  });

  it('is NOT treated as an ordinary transient error', () => {
    // Retrying the same frozen bytes after expiry fails forever. It needs a
    // new transaction id, which only the caller can build.
    expect(isTransientHederaError({ status: { toString: () => 'TRANSACTION_EXPIRED' } })).toBe(false);
  });

  it('rebuilds once and succeeds', async () => {
    let built = 0;
    const result = await withFreshTransaction(async () => {
      built++;
      if (built === 1) throw new Error('failed precheck with status TRANSACTION_EXPIRED');
      return 'written';
    });
    expect(result).toBe('written');
    expect(built).toBe(2);
  });

  it('gives up after the rebuild budget', async () => {
    let built = 0;
    await expect(
      withFreshTransaction(
        async () => {
          built++;
          throw new Error('TRANSACTION_EXPIRED');
        },
        { rebuilds: 2 },
      ),
    ).rejects.toThrow(/TRANSACTION_EXPIRED/);
    expect(built).toBe(3);
  });

  it('does not rebuild anything else', async () => {
    let built = 0;
    await expect(
      withFreshTransaction(async () => {
        built++;
        throw new Error('INVALID_SIGNATURE');
      }),
    ).rejects.toThrow(/INVALID_SIGNATURE/);
    // A bad signature will be bad again. Rebuilding it just burns fees.
    expect(built).toBe(1);
  });
});
