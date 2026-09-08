import { describe, expect, it } from 'vitest';
import { beliefFromProbability, UNIFORM_PRIOR } from '../src/config.js';
import {
  clipBelief,
  crossEntropy,
  kl,
  maxTotalPayout,
  scoreCE,
  scoreCEM,
  totalCEM,
} from '../src/scoring.js';
import type { Belief } from '../src/types.js';
import { SeededRandom } from './helpers.js';

const EPS = 0.01;

/** Seed'li rastgele geçerli inanç üretir. */
function randomBelief(rng: SeededRandom, label: string): Belief {
  return clipBelief(beliefFromProbability(rng.next(label)), EPS);
}

describe('clipBelief', () => {
  it('uç değerleri aralığa çekiyor', () => {
    // toEqual değil toBeCloseTo: p0 = 1 - p1 olarak türetiliyor ve IEEE754'te
    // 1 - 0.99 = 0.010000000000000009 çıkıyor. Bu bilinçli bir tercih —
    // p0'ı türetmek toplamın TAM OLARAK 1 olmasını garantiliyor, ki skorlamada
    // bu güzel ondalık görünümünden çok daha önemli.
    const a = clipBelief([1, 0], EPS);
    expect(a[0]).toBeCloseTo(0.99, 12);
    expect(a[1]).toBeCloseTo(0.01, 12);

    const b = clipBelief([0, 1], EPS);
    expect(b[0]).toBeCloseTo(0.01, 12);
    expect(b[1]).toBeCloseTo(0.99, 12);
  });

  it('kırpma sonrası toplam BİREBİR 1 (kayan nokta hatası birikmesin)', () => {
    expect(clipBelief([1, 0], EPS)[0] + clipBelief([1, 0], EPS)[1]).toBe(1);
    expect(clipBelief([0, 1], EPS)[0] + clipBelief([0, 1], EPS)[1]).toBe(1);
  });

  it('aralık içindeki değere dokunmuyor', () => {
    const b = clipBelief([0.3, 0.7], EPS);
    expect(b[1]).toBeCloseTo(0.7, 12);
    expect(b[0]).toBeCloseTo(0.3, 12);
  });

  it('kırpma sonrası toplam hep 1', () => {
    const rng = new SeededRandom(11);
    for (let i = 0; i < 200; i++) {
      const b = clipBelief(beliefFromProbability(rng.next(`b${i}`)), EPS);
      expect(b[0] + b[1]).toBeCloseTo(1, 12);
      expect(b[0]).toBeGreaterThanOrEqual(EPS);
      expect(b[1]).toBeGreaterThanOrEqual(EPS);
    }
  });

  it('geçersiz epsilon reddediliyor', () => {
    expect(() => clipBelief([0.5, 0.5], 0)).toThrowError(/epsilon/);
    expect(() => clipBelief([0.5, 0.5], 0.5)).toThrowError(/epsilon/);
  });
});

describe('skorlama temel özellikleri', () => {
  it('kırpılmamış sıfır içeren inanç skorlamaya girmiyor', () => {
    expect(() => scoreCE([0.5, 0.5], [0, 1])).toThrowError(/clipBelief/);
    expect(() => scoreCEM([0.5, 0.5], [0.5, 0.5], [1, 0])).toThrowError(/clipBelief/);
  });

  it('hareket yoksa ödeme sıfır', () => {
    const rng = new SeededRandom(3);
    for (let i = 0; i < 100; i++) {
      const r = randomBelief(rng, `r${i}`);
      const q = randomBelief(rng, `q${i}`);
      expect(scoreCEM(r, q, q)).toBeCloseTo(0, 12);
    }
  });

  it('proper scoring: r biliniyorsa en iyi rapor r', () => {
    const rng = new SeededRandom(5);
    for (let i = 0; i < 100; i++) {
      const r = randomBelief(rng, `r${i}`);
      const prev = randomBelief(rng, `prev${i}`);
      const other = randomBelief(rng, `o${i}`);
      if (Math.abs(other[1] - r[1]) < 1e-9) continue;
      expect(scoreCEM(r, r, prev)).toBeGreaterThan(scoreCEM(r, other, prev));
    }
  });

  it('doğru yöne hareket pozitif, yanlış yöne negatif', () => {
    const r = beliefFromProbability(0.8);
    const prev = beliefFromProbability(0.5);
    // 0.5 -> 0.7, r=0.8 yönünde
    expect(scoreCEM(r, beliefFromProbability(0.7), prev)).toBeGreaterThan(0);
    // 0.5 -> 0.3, r'den uzağa
    expect(scoreCEM(r, beliefFromProbability(0.3), prev)).toBeLessThan(0);
  });

  it('crossEntropy ve scoreCE işaret olarak ters', () => {
    const r = beliefFromProbability(0.3);
    const q = beliefFromProbability(0.6);
    expect(scoreCE(r, q)).toBeCloseTo(-crossEntropy(r, q), 12);
  });

  it('KL kendisiyle sıfır, farklıda pozitif', () => {
    const p = beliefFromProbability(0.3);
    expect(kl(p, p)).toBeCloseTo(0, 12);
    expect(kl(p, beliefFromProbability(0.7))).toBeGreaterThan(0);
  });
});

describe('DEĞİŞMEZ 1 — teleskoplama', () => {
  it('rastgele 100 dizide ara terimler sadeleşiyor', () => {
    const rng = new SeededRandom(42);
    for (let run = 0; run < 100; run++) {
      const r = randomBelief(rng, `r${run}`);
      const prior = UNIFORM_PRIOR;
      const n = 2 + Math.floor(rng.next(`n${run}`) * 10);
      const reports: Belief[] = [];
      for (let i = 0; i < n; i++) reports.push(randomBelief(rng, `q${run}-${i}`));

      // Adım adım toplam
      let stepwise = 0;
      let prev = prior;
      for (const q of reports) {
        stepwise += scoreCEM(r, q, prev);
        prev = q;
      }

      // Kapalı form
      const closed = totalCEM(r, prior, reports);

      expect(stepwise).toBeCloseTo(closed, 10);
      expect(closed).toBeCloseTo(scoreCE(r, reports[reports.length - 1]!) - scoreCE(r, prior), 10);
    }
  });
});

describe('DEĞİŞMEZ 2 — bütçe sınırı', () => {
  it('uniform prior ile toplam ödeme log2 aşmıyor (100 rastgele market)', () => {
    const rng = new SeededRandom(7);
    const LOG2 = Math.log(2);
    for (let run = 0; run < 100; run++) {
      const r = randomBelief(rng, `r${run}`);
      const n = 1 + Math.floor(rng.next(`n${run}`) * 12);
      const reports: Belief[] = [];
      for (let i = 0; i < n; i++) reports.push(randomBelief(rng, `q${run}-${i}`));

      const total = totalCEM(r, UNIFORM_PRIOR, reports);
      expect(total).toBeLessThanOrEqual(LOG2 + 1e-12);
    }
  });

  it('sınır sıkı: r ile aynı raporda tam H(r, prior) ödeniyor', () => {
    const r = beliefFromProbability(0.5);
    const total = totalCEM(r, UNIFORM_PRIOR, [r]);
    // q^0 = r olduğu için hareket yok, ödeme sıfır
    expect(total).toBeCloseTo(0, 12);

    // Uç bir referans: r=0.99, tek rapor r
    const r2 = clipBelief(beliefFromProbability(0.99), EPS);
    const t2 = totalCEM(r2, UNIFORM_PRIOR, [r2]);
    expect(t2).toBeGreaterThan(0);
    expect(t2).toBeLessThanOrEqual(Math.log(2) + 1e-12);
  });

  it('maxTotalPayout uniform prior ile b·log2 veriyor', () => {
    expect(maxTotalPayout(1, UNIFORM_PRIOR)).toBeCloseTo(Math.log(2), 12);
    expect(maxTotalPayout(2.5, UNIFORM_PRIOR)).toBeCloseTo(2.5 * Math.log(2), 12);
  });

  it('maxTotalPayout gerçek toplamı her zaman üstten sınırlıyor', () => {
    const rng = new SeededRandom(99);
    const prior = beliefFromProbability(0.3); // uniform olmayan prior
    for (let run = 0; run < 100; run++) {
      const r = randomBelief(rng, `r${run}`);
      const n = 1 + Math.floor(rng.next(`n${run}`) * 8);
      const reports: Belief[] = [];
      for (let i = 0; i < n; i++) reports.push(randomBelief(rng, `q${run}-${i}`));

      const total = totalCEM(r, prior, reports);
      expect(total).toBeLessThanOrEqual(maxTotalPayout(1, prior, r) + 1e-12);
      expect(total).toBeLessThanOrEqual(maxTotalPayout(1, prior) + 1e-12);
    }
  });
});

describe('DEĞİŞMEZ 3 önizleme — bilgisiz denge sıfır ödüyor', () => {
  it('herkes bir öncekini kopyalarsa ilk agent hariç ödemeler sıfır', () => {
    // Paper Teorem 7'nin skorlama seviyesindeki karşılığı.
    // Tam senaryo testi ADIM 11'de simülasyonla yapılacak.
    const prior = UNIFORM_PRIOR;
    const same = clipBelief(beliefFromProbability(0.64), EPS);
    const r = same; // referans da aynı raporu veriyor

    // İlk agent prior'dan same'e taşıyor
    const first = scoreCEM(r, same, prior);
    expect(first).toBeCloseTo(kl(r, prior), 12);
    expect(first).toBeGreaterThan(0);

    // Geri kalan herkes aynı yerde duruyor
    for (let i = 0; i < 5; i++) {
      expect(scoreCEM(r, same, same)).toBeCloseTo(0, 12);
    }
  });
});
