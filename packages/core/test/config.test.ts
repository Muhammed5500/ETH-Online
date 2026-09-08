import { describe, expect, it } from 'vitest';
import {
  assertValidParams,
  beliefFromProbability,
  DEFAULT_PARAMS,
  flatFeeProbability,
  normalizeBelief,
  poolExhaustionProbability,
  probabilityOfYes,
  suggestedAlpha,
  UNIFORM_PRIOR,
  validateParams,
} from '../src/config.js';
import type { MarketParams } from '../src/types.js';

/** DEFAULT_PARAMS üstünde tek alan değiştirir. */
function withParam<K extends keyof MarketParams>(key: K, value: MarketParams[K]): MarketParams {
  return { ...DEFAULT_PARAMS, [key]: value };
}

describe('DEFAULT_PARAMS', () => {
  it('geçerli ve uyarısız', () => {
    const r = validateParams(DEFAULT_PARAMS);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('PLAN.md Bölüm 4 ile birebir aynı', () => {
    expect(DEFAULT_PARAMS.k).toBe(3);
    expect(DEFAULT_PARAMS.T).toBe(5);
    expect(DEFAULT_PARAMS.alpha).toBeCloseTo(1 / 8, 12);
    expect(DEFAULT_PARAMS.epsilon).toBe(0.01);
    expect(DEFAULT_PARAMS.minPoolSize).toBe(20);
  });

  it('alpha = 1/(T+k) ilişkisini sağlıyor', () => {
    expect(DEFAULT_PARAMS.alpha).toBeCloseTo(
      suggestedAlpha(DEFAULT_PARAMS.T, DEFAULT_PARAMS.k),
      12,
    );
  });
});

describe('validateParams — hatalar', () => {
  it('k=0 reddediliyor (referans kendi kendini skorlar)', () => {
    const r = validateParams(withParam('k', 0));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/k tam sayı/);
  });

  it('alpha=0 ve alpha=1 reddediliyor', () => {
    expect(validateParams(withParam('alpha', 0)).ok).toBe(false);
    expect(validateParams(withParam('alpha', 1)).ok).toBe(false);
  });

  it('epsilon=0 reddediliyor (log(0) saldırısı)', () => {
    const r = validateParams(withParam('epsilon', 0));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/log\(0\)/);
  });

  it('minPoolSize <= k+1 reddediliyor', () => {
    const r = validateParams({ ...DEFAULT_PARAMS, k: 3, minPoolSize: 4 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/minPoolSize/);
  });

  it('b, R ve bondAmount sınırları', () => {
    expect(validateParams(withParam('b', 0)).ok).toBe(false);
    expect(validateParams(withParam('R', -1)).ok).toBe(false);
    expect(validateParams(withParam('bondAmount', 0)).ok).toBe(false);
  });

  it('assertValidParams hatalıda fırlatıyor, geçerlide uyarı döndürüyor', () => {
    expect(() => assertValidParams(withParam('k', 0))).toThrowError(/Geçersiz market/);
    expect(assertValidParams(DEFAULT_PARAMS)).toEqual([]);
  });
});

describe('validateParams — uyarılar', () => {
  it('küçük havuzda tükenme uyarısı veriyor', () => {
    // N=8, alpha=1/8 -> (0.875)^7 = %39, eşiğin (%10) çok üstünde
    const r = validateParams({ ...DEFAULT_PARAMS, minPoolSize: 8 });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/tükenme ihtimali/);
  });

  it('alpha 1/(T+k) ile uyuşmuyorsa uyarıyor ama geçiriyor', () => {
    const r = validateParams(withParam('alpha', 0.4));
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/1\/\(T\+k\)/);
  });

  it('varsayılan yapılandırma tükenme eşiğinin altında', () => {
    const p = poolExhaustionProbability(DEFAULT_PARAMS.alpha, DEFAULT_PARAMS.minPoolSize);
    expect(p).toBeLessThan(0.1);
    expect(p).toBeCloseTo(0.079, 3); // PLAN.md'deki %7.9
  });
});

describe('olasılık yardımcıları', () => {
  it('poolExhaustionProbability bilinen değerleri veriyor', () => {
    expect(poolExhaustionProbability(1 / 8, 20)).toBeCloseTo(0.079096, 6);
    expect(poolExhaustionProbability(1 / 6, 20)).toBeCloseTo(0.031301, 6);
    expect(poolExhaustionProbability(1 / 11, 20)).toBeCloseTo(0.163508, 6);
  });

  it('N=1 ile tükenme kesin (tek agent zaten sonuncudur)', () => {
    expect(poolExhaustionProbability(0.5, 1)).toBe(1);
  });

  it('k büyüdükçe tükenme riski artıyor (alpha=1/(T+k) olduğu için)', () => {
    // PLAN.md 4.1'deki bulgu: sabit T ve N ile k artınca alpha düşer,
    // market uzar, havuz daha sık tükenir.
    const T = 5;
    const N = 20;
    const risk = (k: number) => poolExhaustionProbability(suggestedAlpha(T, k), N);
    expect(risk(3)).toBeLessThan(risk(4));
    expect(risk(4)).toBeLessThan(risk(6));
    // PLAN.md Bölüm 4.1'deki tablo: %7.9 / %10.7 / %16.4
    expect(risk(3)).toBeCloseTo(0.079096, 6);
    expect(risk(4)).toBeCloseTo(0.106685, 6);
    expect(risk(6)).toBeCloseTo(0.163508, 6);
  });

  it('flatFeeProbability = 1-(1-alpha)^k', () => {
    expect(flatFeeProbability(1 / 8, 3)).toBeCloseTo(0.3301, 4);
    expect(flatFeeProbability(1 / 8, 0)).toBe(0);
  });
});

describe('inanç yardımcıları', () => {
  it('normalizeBelief toplamı 1 yapıyor', () => {
    expect(normalizeBelief([1, 1])).toEqual([0.5, 0.5]);
    expect(normalizeBelief([2, 8])[1]).toBeCloseTo(0.8, 12);
  });

  it('normalizeBelief geçersiz girdileri reddediyor', () => {
    expect(() => normalizeBelief([-0.1, 1.1])).toThrowError(/negatif/);
    expect(() => normalizeBelief([0, 0])).toThrowError(/toplamı pozitif/);
    expect(() => normalizeBelief([NaN, 1])).toThrowError(/sonlu/);
    expect(() => normalizeBelief([Infinity, 1])).toThrowError(/sonlu/);
  });

  it('beliefFromProbability ve probabilityOfYes tersleri', () => {
    for (const p of [0, 0.13, 0.5, 0.99, 1]) {
      expect(probabilityOfYes(beliefFromProbability(p))).toBeCloseTo(p, 12);
    }
  });

  it('beliefFromProbability aralık dışını reddediyor', () => {
    expect(() => beliefFromProbability(-0.01)).toThrowError(/\[0,1\]/);
    expect(() => beliefFromProbability(1.01)).toThrowError(/\[0,1\]/);
  });

  it('UNIFORM_PRIOR gerçekten uniform', () => {
    expect(UNIFORM_PRIOR).toEqual([0.5, 0.5]);
    expect(UNIFORM_PRIOR[0] + UNIFORM_PRIOR[1]).toBe(1);
  });
});
