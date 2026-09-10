/**
 * Frontend arithmetic tests.
 *
 * THE TEST THAT MATTERS is the last block: the deposit the ask page shows must
 * equal the deposit the API charges, to the tinybar. Those two numbers are
 * produced by different code in different processes, and if they drift the
 * asker is quoted one price and billed another.
 *
 * They are checked against each other rather than against a constant on
 * purpose. A constant would pass while both drifted together, which is exactly
 * the failure it would be least useful to miss.
 *
 * Everything else here is a display concern, and display concerns matter more
 * than usual on these screens: they are read off a projector during a demo,
 * where a wrong sign or a lost decimal is not recoverable.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, beliefFromProbability, requiredDeposit } from '@ethonline/core';
import { depositTinybar } from '@ethonline/api';
import {
  depositBreakdown,
  expectedLength,
  formatHbar,
  percent,
  poolExhaustionRisk,
  relativeTime,
  sliceColor,
  tinybarToHbar,
  unitsToTinybar,
} from '../src/lib/format.ts';

describe('tinybar arithmetic', () => {
  it('converts', () => {
    expect(tinybarToHbar('100000000')).toBe(1);
    expect(tinybarToHbar(250_000_000n)).toBe(2.5);
  });

  it('rounds UP when pricing, never down', () => {
    // Down would quote a price a fraction below the deposit bound, and the
    // bound is the only thing standing between the asker and an unbounded
    // payout. Mirrors `unitsToTinybar` in the API.
    expect(unitsToTinybar(0.000000005)).toBe(1n);
    expect(unitsToTinybar(1)).toBe(100_000_000n);
  });

  it('formats with a currency mark', () => {
    expect(formatHbar('100000000', 2)).toBe('1.00 ℏ');
  });
});

describe('display helpers', () => {
  it('formats a probability', () => {
    expect(percent(0.7)).toBe('70.0%');
    expect(percent(0.7, 0)).toBe('70%');
  });

  it('says how long until, and how long since', () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(now + 30_000, now)).toBe('in 30s');
    expect(relativeTime(now - 120_000, now)).toBe('2m ago');
    expect(relativeTime(now + 7_200_000, now)).toBe('in 2h');
    expect(relativeTime(now - 172_800_000, now)).toBe('2d ago');
  });

  it('gives each slice its own colour and falls back for an unknown one', () => {
    expect(sliceColor('liquidity')).not.toBe(sliceColor('holders'));
    expect(sliceColor('something-new')).toContain('slate');
  });
});

describe('mechanism figures shown on the ask page', () => {
  it('expected length is 1/alpha', () => {
    // The stopping rule is geometric, so this is a mean and the page must not
    // present it as a cap — a market running past it is ordinary.
    expect(expectedLength(DEFAULT_PARAMS)).toBe(8);
  });

  it('pool exhaustion is (1-alpha)^(N-1)', () => {
    // PLAN section 4: N=20, alpha=1/8 gives 7.9%. This is the one case where
    // the last agent knows it is the reference, so the number is shown rather
    // than buried.
    expect(poolExhaustionRisk(DEFAULT_PARAMS, 20)).toBeCloseTo(0.0791, 4);
  });

  it('treats an impossible pool as certain exhaustion', () => {
    expect(poolExhaustionRisk(DEFAULT_PARAMS, 0)).toBe(1);
  });
});

describe('the deposit the asker is quoted', () => {
  it('splits into the two terms the bound is made of', () => {
    const d = depositBreakdown(DEFAULT_PARAMS);
    expect(d.flatFeeUnits).toBeCloseTo(DEFAULT_PARAMS.k * DEFAULT_PARAMS.R, 12);
    expect(d.scoringUnits + d.flatFeeUnits).toBeCloseTo(d.units, 12);
    // Uniform prior: the scoring side is exactly b·log2.
    expect(d.scoringUnits).toBeCloseTo(DEFAULT_PARAMS.b * Math.log(2), 12);
  });

  it('is `requiredDeposit` and not a second copy of the formula', () => {
    expect(depositBreakdown(DEFAULT_PARAMS).units).toBe(requiredDeposit(DEFAULT_PARAMS, [0.5, 0.5]));
  });

  it('MATCHES WHAT THE API CHARGES, to the tinybar', () => {
    // Different code, different process. If these disagree the asker sees one
    // price and pays another.
    for (const p1 of [0.5, 0.1, 0.9, 0.37]) {
      for (const params of [
        DEFAULT_PARAMS,
        { ...DEFAULT_PARAMS, k: 6, T: 4, alpha: 0.1 },
        { ...DEFAULT_PARAMS, b: 2.5, R: 0.33 },
      ]) {
        const prior = beliefFromProbability(p1);
        expect(depositBreakdown(params, prior).tinybar).toBe(depositTinybar(params, prior));
      }
    }
  });

  it('matches at a non-default HBAR scale too', () => {
    const prior = beliefFromProbability(0.5);
    expect(depositBreakdown(DEFAULT_PARAMS, prior, 4).tinybar).toBe(
      depositTinybar(DEFAULT_PARAMS, prior, 4),
    );
  });

  it('costs MORE to open a market with a confident prior, not less', () => {
    // Worth stating carefully, because the intuitive guess is backwards and
    // the first draft of the ask page said the opposite on screen.
    //
    // The bound is `b · max_i(-log q⁰_i)`, the worst case over where the
    // reference agent lands — NOT the entropy of the prior. A prior of 5% puts
    // one component near zero, and -log of a small number is large: if the
    // reference lands at 95% the scoring rule has to pay for that entire move,
    // and the deposit must cover it.
    //
    // Uniform is therefore the CHEAPEST place to open a market, at b·log2.
    const uniform = depositBreakdown(DEFAULT_PARAMS, beliefFromProbability(0.5)).units;
    const confident = depositBreakdown(DEFAULT_PARAMS, beliefFromProbability(0.05)).units;
    expect(confident).toBeGreaterThan(uniform);
  });

  it('is cheapest at 50/50', () => {
    const at = (p: number): number =>
      depositBreakdown(DEFAULT_PARAMS, beliefFromProbability(p)).units;
    for (const p of [0.05, 0.2, 0.35, 0.65, 0.8, 0.95]) {
      expect(at(p)).toBeGreaterThan(at(0.5));
    }
  });
});
