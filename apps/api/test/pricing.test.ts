/**
 * Pricing tests.
 *
 * The price quoted in a 402 and the deposit the mechanism assumes it has are
 * the same number by construction. If they ever diverged, a market could pay
 * out more than it was funded for — so the rounding direction and the bound
 * itself are pinned here.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, requiredDeposit, UNIFORM_PRIOR } from '@ethonline/core';
import {
  bondTinybar,
  depositTinybar,
  formatTinybar,
  TINYBAR_PER_HBAR,
  tinybarToHbar,
  unitsToTinybar,
} from '../src/pricing.js';

describe('unitsToTinybar', () => {
  it('converts whole HBAR exactly', () => {
    expect(unitsToTinybar(1)).toBe(100_000_000n);
    expect(unitsToTinybar(0.1)).toBe(10_000_000n);
    expect(unitsToTinybar(0)).toBe(0n);
  });

  it('scales with hbarPerUnit', () => {
    expect(unitsToTinybar(1, 0.5)).toBe(50_000_000n);
    expect(unitsToTinybar(2, 3)).toBe(600_000_000n);
  });

  it('rounds UP, never down', () => {
    // Rounding down would quote a price a hair under the deposit bound, and
    // that bound is the only thing capping what the asker can be charged.
    expect(unitsToTinybar(1 / 3)).toBe(33_333_334n);
    expect(unitsToTinybar(0.000000001)).toBe(1n);
  });

  it('rejects nonsense input instead of producing a nonsense price', () => {
    expect(() => unitsToTinybar(-1)).toThrow(/units/);
    expect(() => unitsToTinybar(Number.NaN)).toThrow(/units/);
    expect(() => unitsToTinybar(1, 0)).toThrow(/hbarPerUnit/);
    expect(() => unitsToTinybar(1, -2)).toThrow(/hbarPerUnit/);
  });

  it('round-trips through tinybarToHbar', () => {
    expect(tinybarToHbar(unitsToTinybar(2.5))).toBeCloseTo(2.5, 8);
    expect(Number(TINYBAR_PER_HBAR)).toBe(1e8);
  });
});

describe('depositTinybar', () => {
  it('is exactly the deposit bound from PLAN section 5', () => {
    // b·log2 + k·R with the shipped parameters = 0.6931 + 0.3
    const units = requiredDeposit(DEFAULT_PARAMS, UNIFORM_PRIOR);
    expect(units).toBeCloseTo(Math.log(2) + 0.3, 9);
    expect(depositTinybar(DEFAULT_PARAMS, UNIFORM_PRIOR)).toBe(unitsToTinybar(units));
    expect(tinybarToHbar(depositTinybar(DEFAULT_PARAMS, UNIFORM_PRIOR))).toBeCloseTo(0.99314718, 7);
  });

  it('grows with the liquidity parameter and with k', () => {
    const base = depositTinybar(DEFAULT_PARAMS, UNIFORM_PRIOR);
    expect(depositTinybar({ ...DEFAULT_PARAMS, b: 2 }, UNIFORM_PRIOR)).toBeGreaterThan(base);
    expect(depositTinybar({ ...DEFAULT_PARAMS, k: 6 }, UNIFORM_PRIOR)).toBeGreaterThan(base);
  });

  it('costs more for a lopsided prior — H(r, prior) is larger there', () => {
    const uniform = depositTinybar(DEFAULT_PARAMS, UNIFORM_PRIOR);
    const skewed = depositTinybar(DEFAULT_PARAMS, [0.05, 0.95]);
    expect(skewed).toBeGreaterThan(uniform);
  });
});

describe('bondTinybar', () => {
  it('is the bond amount in HBAR', () => {
    expect(bondTinybar(DEFAULT_PARAMS)).toBe(100_000_000n);
    expect(bondTinybar({ ...DEFAULT_PARAMS, bondAmount: 0.25 })).toBe(25_000_000n);
  });

  it('fits inside what an agent actually holds', () => {
    // STEP 12 funded each agent with 10 HBAR.
    expect(tinybarToHbar(bondTinybar(DEFAULT_PARAMS))).toBeLessThan(10);
  });
});

describe('formatTinybar', () => {
  it('shows both units, because demos need both', () => {
    expect(formatTinybar(100_000_000n)).toBe('1.00000000 HBAR (100000000 tinybar)');
  });
});
