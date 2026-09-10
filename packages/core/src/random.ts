/**
 * Deterministic randomness for the mechanism.
 *
 * In production the stopping dice and the agent draw come from the Hedera HCS
 * running hash (STEP 14): unpredictable before a message is submitted,
 * verifiable by anyone afterwards. Here we only need something reproducible.
 *
 * This lives in `src/` rather than in the test helpers because `simulate.ts`
 * is production code that takes a seed — keeping two copies of the same PRNG,
 * one for tests and one for the simulator, would let them drift apart and make
 * a test disagree with the thing it is testing.
 */
import type { RandomSource } from './types.js';

/** mulberry32 — small, fast, reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded sequential source. Same seed, same sequence.
 *
 * `label` says which decision was being made (`draw-3`, `stop-3`). It is
 * recorded but does NOT affect the stream, so a caller cannot steer the
 * outcome by renaming a decision.
 */
export class SeededRandom implements RandomSource {
  private readonly rng: () => number;
  readonly log: Array<{ label: string; value: number }> = [];

  constructor(seed: number) {
    this.rng = mulberry32(seed);
  }

  next(label: string): number {
    const value = this.rng();
    this.log.push({ label, value });
    return value;
  }
}
