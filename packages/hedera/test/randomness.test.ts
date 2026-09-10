/**
 * Randomness tests.
 *
 * Three things have to hold or the market's closing is not trustworthy:
 *
 *   1. The output really is uniform on [0, 1) — checked with a chi-square
 *      test over 10,000 hashes.
 *   2. It is strictly BELOW 1. The obvious `uint64 / 2^64` returns exactly 1.0
 *      at the top of the range, and a 1.0 indexes one past the end of the pool.
 *   3. The stopping roll and the agent draw read different bytes. If they
 *      shared bytes, reaching a draw would imply `u >= alpha` and the first
 *      alpha-fraction of the pool could never be selected.
 */
import { describe, expect, it } from 'vitest';
import { SeededRandom } from '@ethonline/core';
import {
  fromHex,
  hashToUnitInterval,
  HCS_RUNNING_HASH_BYTES,
  HcsRandomSource,
  purposeFromLabel,
  shouldStop,
  toHex,
  verifyStoppingDecision,
} from '../src/randomness.js';

/** Deterministic stand-in for a running hash, so nothing here can flake. */
function pseudoHash(seed: number): Uint8Array {
  const rng = new SeededRandom(seed);
  const out = new Uint8Array(HCS_RUNNING_HASH_BYTES);
  for (let i = 0; i < out.length; i++) out[i] = Math.floor(rng.next(`b${i}`) * 256);
  return out;
}

const ALL_ZERO = new Uint8Array(HCS_RUNNING_HASH_BYTES);
const ALL_FF = new Uint8Array(HCS_RUNNING_HASH_BYTES).fill(0xff);

describe('hashToUnitInterval', () => {
  it('reads the first eight bytes big-endian', () => {
    // Hand-checkable constants: the leading byte alone fixes the value, which
    // pins both the byte order and the divisor without trusting the code to
    // check itself.
    const pad = '00'.repeat(40);
    expect(hashToUnitInterval(fromHex(`8000000000000000${pad}`))).toBe(0.5);
    expect(hashToUnitInterval(fromHex(`4000000000000000${pad}`))).toBe(0.25);
    expect(hashToUnitInterval(fromHex(`c000000000000000${pad}`))).toBe(0.75);
    expect(hashToUnitInterval(fromHex(`0100000000000000${pad}`))).toBe(1 / 256);

    // Big-endian, not little: a value in the LAST of the eight bytes is tiny.
    expect(hashToUnitInterval(fromHex(`0000000000000001${pad}`))).toBeLessThan(1e-15);
  });

  it('matches a full-width worked example', () => {
    // 0xb0a4d1f2c3b4a596 = 12729592024199546262
    // 12729592024199546262 / 2^64 = 0.6900149553000170...
    const hash = fromHex(`b0a4d1f2c3b4a596${'00'.repeat(40)}`);
    expect(hashToUnitInterval(hash)).toBeCloseTo(0.6900149553, 9);
  });

  it('maps an all-zero hash to 0', () => {
    expect(hashToUnitInterval(ALL_ZERO)).toBe(0);
  });

  it('maps an all-ones hash STRICTLY below 1', () => {
    // The whole reason for the 53-bit shift. `Number(2n**64n - 1n) / 2**64`
    // rounds up to exactly 1.0, which would break the half-open interval and
    // index one past the end of the agent pool.
    const u = hashToUnitInterval(ALL_FF);
    expect(u).toBeLessThan(1);
    expect(u).toBeGreaterThan(0.999999);
    expect(Number(2n ** 64n - 1n) / 2 ** 64).toBe(1); // the trap, for the record
  });

  it('never returns 1 or more across the whole byte range', () => {
    for (let seed = 0; seed < 2000; seed++) {
      const u = hashToUnitInterval(pseudoHash(seed));
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  it('is deterministic — the same hash always gives the same value', () => {
    const hash = pseudoHash(42);
    expect(hashToUnitInterval(hash)).toBe(hashToUnitInterval(hash));
    expect(hashToUnitInterval(hash)).toBe(hashToUnitInterval(fromHex(toHex(hash))));
  });

  it('rejects a hash too short for the requested purpose', () => {
    expect(() => hashToUnitInterval(new Uint8Array(4))).toThrow(/at least 8/);
    expect(() => hashToUnitInterval(new Uint8Array(8), 'draw')).toThrow(/at least 16/);
  });

  it('is uniform on [0,1) — chi-square over 10,000 hashes', () => {
    const BINS = 10;
    const N = 10_000;
    const counts = new Array<number>(BINS).fill(0);

    for (let seed = 0; seed < N; seed++) {
      const u = hashToUnitInterval(pseudoHash(seed + 100_000));
      counts[Math.min(BINS - 1, Math.floor(u * BINS))]!++;
    }

    const expected = N / BINS;
    const chi2 = counts.reduce((acc, c) => acc + (c - expected) ** 2 / expected, 0);

    // 9 degrees of freedom. The p=0.001 critical value is 27.88; anything
    // under that is indistinguishable from uniform. Seeded, so deterministic.
    expect(chi2).toBeLessThan(27.88);
    expect(counts.every((c) => c > 0)).toBe(true);
  });
});

describe('purpose separation — the bias this prevents', () => {
  it('stop and draw read different bytes of the same hash', () => {
    for (let seed = 0; seed < 200; seed++) {
      const hash = pseudoHash(seed);
      expect(hashToUnitInterval(hash, 'stop')).not.toBe(hashToUnitInterval(hash, 'draw'));
    }
  });

  it('a draw following a survived stop is NOT confined to the upper range', () => {
    // This is the actual bug being guarded against. Reaching a draw means the
    // stopping roll failed, so its value is >= alpha. If the draw reused those
    // bytes, no draw could ever land below alpha and the first 12.5% of the
    // pool would be unreachable.
    const alpha = 1 / 8;
    let drawsBelowAlpha = 0;
    let survivedStops = 0;

    for (let seed = 0; seed < 3000; seed++) {
      const hash = pseudoHash(seed);
      if (shouldStop(hash, alpha)) continue;
      survivedStops++;
      if (hashToUnitInterval(hash, 'draw') < alpha) drawsBelowAlpha++;
    }

    expect(survivedStops).toBeGreaterThan(2000);
    // Roughly alpha of them should land low; with shared bytes this is 0.
    expect(drawsBelowAlpha / survivedStops).toBeGreaterThan(0.08);
    expect(drawsBelowAlpha / survivedStops).toBeLessThan(0.17);
  });

  it('reads the purpose from the labels core already uses', () => {
    expect(purposeFromLabel('draw-1')).toBe('draw');
    expect(purposeFromLabel('stop-12')).toBe('stop');
    expect(() => purposeFromLabel('something-else')).toThrow(/must start with/);
  });
});

describe('shouldStop and verifyStoppingDecision', () => {
  it('closes exactly when u < alpha', () => {
    for (let seed = 0; seed < 500; seed++) {
      const hash = pseudoHash(seed);
      const u = hashToUnitInterval(hash, 'stop');
      expect(shouldStop(hash, 0.125)).toBe(u < 0.125);
    }
  });

  it('closes at roughly the configured rate', () => {
    const alpha = 1 / 8;
    let stops = 0;
    for (let seed = 0; seed < 8000; seed++) if (shouldStop(pseudoHash(seed), alpha)) stops++;
    expect(stops / 8000).toBeGreaterThan(0.11);
    expect(stops / 8000).toBeLessThan(0.14);
  });

  it('confirms an honest decision and rejects a fabricated one', () => {
    for (let seed = 0; seed < 300; seed++) {
      const hash = pseudoHash(seed);
      const truth = shouldStop(hash, 0.125);
      expect(verifyStoppingDecision(hash, 0.125, truth)).toBe(true);
      // An orchestrator claiming the opposite is caught.
      expect(verifyStoppingDecision(hash, 0.125, !truth)).toBe(false);
    }
  });

  it('catches a market kept running past a roll that should have closed it', () => {
    const closing = Array.from({ length: 4000 }, (_, s) => pseudoHash(s)).find((h) =>
      shouldStop(h, 0.125),
    );
    expect(closing).toBeDefined();
    expect(verifyStoppingDecision(closing!, 0.125, false)).toBe(false);
  });

  it('rejects a nonsense alpha instead of silently never closing', () => {
    expect(() => shouldStop(pseudoHash(1), 0)).toThrow(/alpha/);
    expect(() => shouldStop(pseudoHash(1), 1)).toThrow(/alpha/);
    expect(() => shouldStop(pseudoHash(1), -0.1)).toThrow(/alpha/);
  });
});

describe('HcsRandomSource', () => {
  it('refuses to produce a value before any hash has arrived', () => {
    // Falling back to Math.random here would produce a market that looks
    // identical to a verifiable one and is not.
    const src = new HcsRandomSource();
    expect(() => src.next('draw-1')).toThrow(/must be written/);
  });

  it('serves values from the newest hash', () => {
    const src = new HcsRandomSource(pseudoHash(1));
    const first = src.next('stop-1');
    src.update(pseudoHash(2));
    const second = src.next('stop-2');
    expect(first).not.toBe(second);
    expect(second).toBe(hashToUnitInterval(pseudoHash(2), 'stop'));
  });

  it('gives draw and stop different values from one hash', () => {
    const src = new HcsRandomSource(pseudoHash(7));
    expect(src.next('stop-1')).not.toBe(src.next('draw-2'));
  });

  it('records every draw so a run can be replayed', () => {
    const src = new HcsRandomSource(pseudoHash(3));
    src.next('stop-1');
    src.next('draw-2');
    expect(src.draws).toHaveLength(2);
    expect(src.draws[0]).toMatchObject({ label: 'stop-1', purpose: 'stop' });
    expect(src.draws[1]).toMatchObject({ label: 'draw-2', purpose: 'draw' });
    expect(src.draws[0]?.runningHashHex).toBe(toHex(pseudoHash(3)));
    // The audit trail is enough to recheck the value without rerunning anything.
    expect(hashToUnitInterval(fromHex(src.draws[0]!.runningHashHex), 'stop')).toBe(
      src.draws[0]?.value,
    );
  });

  it('rejects a hash that is not the size Hedera returns', () => {
    const src = new HcsRandomSource();
    expect(() => src.update(new Uint8Array(32))).toThrow(/48-byte/);
  });

  it('satisfies core RandomSource well enough to run a market', () => {
    // Same interface the seeded generator implements, so the mechanism cannot
    // tell the difference between a test and production.
    const src = new HcsRandomSource(pseudoHash(11));
    const u = src.next('draw-1');
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(1);
  });
});

describe('hex helpers', () => {
  it('round-trips', () => {
    const hash = pseudoHash(5);
    expect(fromHex(toHex(hash))).toEqual(hash);
    expect(toHex(hash)).toHaveLength(HCS_RUNNING_HASH_BYTES * 2);
  });

  it('accepts a 0x prefix and rejects malformed input', () => {
    expect(fromHex('0xff00')).toEqual(new Uint8Array([255, 0]));
    expect(() => fromHex('abc')).toThrow(/odd length/);
    expect(() => fromHex('zz')).toThrow(/valid hex/);
  });
});
