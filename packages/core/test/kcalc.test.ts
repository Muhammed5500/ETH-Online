/**
 * Tests for the k calculator (STEP 10).
 *
 * These are not spot checks of a formula against itself. Two things are being
 * pinned down:
 *
 *   1. Every number printed in PLAN.md sections 2.3, 4.1 and 4.3 is reproduced
 *      by this code. Those tables are what the README's honesty statement rests
 *      on, so they have to come out of the calculator rather than out of a
 *      spreadsheet nobody can rerun.
 *   2. `kMinApprox` is the exact inverse of `deviationBound`. They are written
 *      as separate expressions from separate equations in the paper; the round
 *      trip is what proves neither was mistranscribed.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAMS,
  deviationBound,
  flatFeeProbability,
  kMinApprox,
  kMinStrict,
  poolExhaustionProbability,
  signalSpread,
} from '../src/index.js';

/** PLAN.md tables are rounded to one decimal; ROADMAP STEP 10 allows +/-0.05. */
const TABLE_TOL = 0.05;

describe('signalSpread', () => {
  it('is (1-eta)/eta - eta/(1-eta)', () => {
    // eta=0.1 -> 9 - 1/9
    expect(signalSpread(0.1)).toBeCloseTo(9 - 1 / 9, 10);
    expect(signalSpread(0.2)).toBeCloseTo(4 - 0.25, 10);
  });

  it('vanishes at eta=0.5 — a signal that cannot move any belief', () => {
    expect(signalSpread(0.5)).toBeCloseTo(0, 12);
  });

  it('grows without bound as signals get more extreme', () => {
    expect(signalSpread(0.05)).toBeGreaterThan(signalSpread(0.1));
    expect(signalSpread(0.1)).toBeGreaterThan(signalSpread(0.2));
  });
});

describe('deviationBound — Theorem 1', () => {
  // PLAN.md section 4.3: the price of running k=3, at delta=0.5, eta=0.1.
  it.each([
    [3, 0.278],
    [4, 0.139],
    [6, 0.035],
  ])('k=%i gives |Delta| <= %f (PLAN 4.3)', (k, expected) => {
    expect(deviationBound(0.5, 0.1, k)).toBeCloseTo(expected, 2);
  });

  it('at k=0 is the full unattenuated signal advantage, spread/4', () => {
    expect(deviationBound(0.5, 0.1, 0)).toBeCloseTo(signalSpread(0.1) / 4, 10);
  });

  it('decays by exactly (1-delta) per additional agent', () => {
    const a = deviationBound(0.3, 0.1, 5);
    const b = deviationBound(0.3, 0.1, 6);
    expect(b / a).toBeCloseTo(0.7, 10);
  });

  it('is monotonically decreasing in k and tends to zero', () => {
    let prev = Infinity;
    for (let k = 0; k <= 40; k++) {
      const v = deviationBound(0.5, 0.1, k);
      expect(v).toBeLessThan(prev);
      prev = v;
    }
    expect(deviationBound(0.5, 0.1, 200)).toBeCloseTo(0, 12);
  });

  it('is larger for weaker signals — delta is the strongest lever', () => {
    // The paper singles delta out: better signals buy more than more agents.
    expect(deviationBound(0.1, 0.1, 5)).toBeGreaterThan(deviationBound(0.5, 0.1, 5));
  });

  it('is zero when eta=0.5, no matter how small k is', () => {
    expect(deviationBound(0.5, 0.5, 0)).toBeCloseTo(0, 12);
  });
});

describe('kMinApprox — Theorem 1, Equation 3', () => {
  // ROADMAP STEP 10 verification values.
  it.each([
    [0.5, 0.1, 0.05, 5.5],
    [0.3, 0.1, 0.05, 10.6],
    [0.2, 0.1, 0.05, 17.0],
  ])('delta=%f eta=%f eps=%f -> ~%f', (delta, eta, eps, expected) => {
    expect(kMinApprox(delta, eta, eps)).toBeCloseTo(expected, 1);
  });

  // PLAN.md section 2.3, full table at eps=0.05.
  const APPROX_TABLE: ReadonlyArray<readonly [number, number, number]> = [
    [0.5, 0.2, 4.2],
    [0.5, 0.1, 5.5],
    [0.5, 0.05, 6.6],
    [0.3, 0.2, 8.2],
    [0.3, 0.1, 10.6],
    [0.3, 0.05, 12.8],
    [0.2, 0.2, 13.1],
    [0.2, 0.1, 17.0],
    [0.2, 0.05, 20.4],
    [0.1, 0.2, 27.8],
    [0.1, 0.1, 36.0],
    [0.1, 0.05, 43.2],
  ];

  it.each(APPROX_TABLE)(
    'reproduces PLAN 2.3: delta=%f, eta=%f -> %f',
    (delta, eta, expected) => {
      expect(Math.abs(kMinApprox(delta, eta, 0.05) - expected)).toBeLessThanOrEqual(TABLE_TOL);
    },
  );

  it('needs more agents as the target deviation tightens', () => {
    const loose = kMinApprox(0.5, 0.1, 0.1);
    const mid = kMinApprox(0.5, 0.1, 0.05);
    const tight = kMinApprox(0.5, 0.1, 0.01);
    expect(loose).toBeLessThan(mid);
    expect(mid).toBeLessThan(tight);
  });

  it('needs more agents as signals get weaker (delta down) or more extreme (eta down)', () => {
    expect(kMinApprox(0.5, 0.1, 0.05)).toBeLessThan(kMinApprox(0.2, 0.1, 0.05));
    expect(kMinApprox(0.5, 0.2, 0.05)).toBeLessThan(kMinApprox(0.5, 0.05, 0.05));
  });

  it('clamps to 0 when the target is already looser than the signal advantage', () => {
    // spread(0.1)/4 = 2.22; asking for |Delta| <= 5 needs no buffer agents.
    expect(kMinApprox(0.5, 0.1, 5)).toBe(0);
  });

  it('is 0 at eta=0.5 — nothing to attenuate', () => {
    expect(kMinApprox(0.5, 0.5, 0.05)).toBe(0);
  });
});

describe('kMinApprox is the exact inverse of deviationBound', () => {
  // This is the real check on both transcriptions. Equation 3 is derived by
  // solving the Theorem 1 bound for k; if either was copied wrong the round
  // trip breaks immediately.
  const CASES: ReadonlyArray<readonly [number, number, number]> = [
    [0.5, 0.1, 0.05],
    [0.3, 0.2, 0.1],
    [0.2, 0.05, 0.01],
    [0.1, 0.1, 0.02],
    [0.7, 0.3, 0.005],
  ];

  it.each(CASES)('delta=%f eta=%f eps=%f round-trips', (delta, eta, eps) => {
    const k = kMinApprox(delta, eta, eps);
    expect(deviationBound(delta, eta, k)).toBeCloseTo(eps, 10);
  });

  it('rounding k up always lands strictly inside the target', () => {
    for (const [delta, eta, eps] of CASES) {
      const k = Math.ceil(kMinApprox(delta, eta, eps));
      expect(deviationBound(delta, eta, k)).toBeLessThanOrEqual(eps + 1e-12);
    }
  });
});

describe('kMinStrict — Theorem 4, Equation 7', () => {
  // PLAN.md section 2.3, strict truthfulness table.
  const STRICT_TABLE: ReadonlyArray<readonly [number, number, number, number]> = [
    [0.5, 0.2, 1.0, 4.7],
    [0.5, 0.2, 0.5, 6.7],
    [0.5, 0.2, 0.2, 9.3],
    [0.5, 0.1, 1.0, 8.2],
    [0.5, 0.1, 0.5, 10.2],
    [0.5, 0.1, 0.2, 12.9],
    [0.3, 0.1, 1.0, 16.0],
    [0.3, 0.1, 0.5, 19.9],
    [0.3, 0.1, 0.2, 25.0],
  ];

  it.each(STRICT_TABLE)(
    'reproduces PLAN 2.3: delta=%f, eta=%f, tau=%f -> %f',
    (delta, eta, tau, expected) => {
      expect(Math.abs(kMinStrict(delta, eta, tau) - expected)).toBeLessThanOrEqual(TABLE_TOL);
    },
  );

  it('needs more agents as the signal space gets finer', () => {
    expect(kMinStrict(0.5, 0.1, 1.0)).toBeLessThan(kMinStrict(0.5, 0.1, 0.5));
    expect(kMinStrict(0.5, 0.1, 0.5)).toBeLessThan(kMinStrict(0.5, 0.1, 0.2));
  });

  it('demands more than approximate truthfulness at the parameters we quote', () => {
    // Strict truthfulness makes honesty the unique best response, not merely a
    // near-optimal one, and that is not free.
    expect(kMinStrict(0.5, 0.1, 1.0)).toBeGreaterThan(kMinApprox(0.5, 0.1, 0.05));
    expect(kMinStrict(0.3, 0.1, 1.0)).toBeGreaterThan(kMinApprox(0.3, 0.1, 0.05));
  });

  it('scales with 1/-log(1-delta) exactly like the approximate bound', () => {
    const ratio = kMinStrict(0.2, 0.1, 0.5) / kMinStrict(0.5, 0.1, 0.5);
    const expected = -Math.log(0.5) / -Math.log(0.8);
    expect(ratio).toBeCloseTo(expected, 10);
  });

  it('is 0 at eta=0.5', () => {
    expect(kMinStrict(0.5, 0.5, 1.0)).toBe(0);
  });
});

describe('pool sizing — PLAN 4.1 option table', () => {
  // Our own finding, absent from the paper: alpha = 1/(T+k), so a larger k
  // lowers alpha, lengthens the market and RAISES the exhaustion probability.
  // In a finite pool, lowering k wins on both axes at once.
  it.each([
    [3, 5, 1 / 8, 0.079],
    [3, 4, 1 / 7, 0.053],
    [4, 5, 1 / 9, 0.107],
    [6, 5, 1 / 11, 0.164],
  ])('k=%i T=%i alpha=%f -> P(exhausted) ~ %f', (_k, _T, alpha, expected) => {
    expect(poolExhaustionProbability(alpha, 20)).toBeCloseTo(expected, 3);
  });

  it('exhaustion risk rises monotonically with k under alpha = 1/(T+k)', () => {
    const T = 5;
    let prev = 0;
    for (const k of [3, 4, 5, 6, 7]) {
      const p = poolExhaustionProbability(1 / (T + k), 20);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it('a third of agents land in the flat-fee tail at the demo settings', () => {
    expect(flatFeeProbability(1 / 8, 3)).toBeCloseTo(0.33, 2);
  });
});

describe('the k=3 gap, stated as a test', () => {
  // The README claim is: the bound asks for k~6 at (delta=0.5, eta=0.1,
  // eps=0.05), and we run k=3 for pool feasibility. Both halves are asserted
  // here so the claim cannot silently drift away from the code.
  it('the bound asks for 6 agents', () => {
    expect(Math.ceil(kMinApprox(0.5, 0.1, 0.05))).toBe(6);
  });

  it('we ship 3', () => {
    expect(DEFAULT_PARAMS.k).toBe(3);
  });

  it('and the cost of that is a deviation bound of ~0.278 instead of ~0.035', () => {
    expect(deviationBound(0.5, 0.1, DEFAULT_PARAMS.k)).toBeCloseTo(0.278, 3);
    expect(deviationBound(0.5, 0.1, 6)).toBeCloseTo(0.035, 3);
  });
});

describe('input validation', () => {
  it('rejects delta outside (0, 1)', () => {
    expect(() => deviationBound(0, 0.1, 3)).toThrow(/delta/);
    expect(() => deviationBound(1, 0.1, 3)).toThrow(/delta/);
    expect(() => kMinApprox(1.2, 0.1, 0.05)).toThrow(/delta/);
    expect(() => kMinStrict(-0.1, 0.1, 1)).toThrow(/delta/);
  });

  it('rejects eta outside (0, 0.5]', () => {
    expect(() => signalSpread(0)).toThrow(/eta/);
    expect(() => signalSpread(0.6)).toThrow(/eta/);
    expect(() => deviationBound(0.5, 0.51, 3)).toThrow(/eta/);
  });

  it('rejects a negative k', () => {
    expect(() => deviationBound(0.5, 0.1, -1)).toThrow(/k must be/);
  });

  it('rejects a non-positive target deviation', () => {
    expect(() => kMinApprox(0.5, 0.1, 0)).toThrow(/epsilonPrime/);
    expect(() => kMinApprox(0.5, 0.1, -0.01)).toThrow(/epsilonPrime/);
  });

  it('rejects a non-positive tau', () => {
    expect(() => kMinStrict(0.5, 0.1, 0)).toThrow(/tau/);
  });

  it('rejects non-finite input rather than returning NaN', () => {
    expect(() => deviationBound(NaN, 0.1, 3)).toThrow();
    expect(() => deviationBound(0.5, 0.1, Infinity)).toThrow();
    expect(() => kMinStrict(0.5, 0.1, NaN)).toThrow();
  });
});
