import { describe, expect, it } from 'vitest';
import { beliefFromProbability, DEFAULT_PARAMS, UNIFORM_PRIOR } from '../src/config.js';
import { Market } from '../src/market.js';
import { maxTotalPayout } from '../src/scoring.js';
import { computeSettlement, requiredDeposit } from '../src/settlement.js';
import type { MarketParams, RandomSource } from '../src/types.js';
import { LabelledRandom, SeededRandom } from './helpers.js';

const DRAW = 0.0;
const NO_STOP = 0.99;
const STOP = 0.0;

function params(over: Partial<MarketParams> = {}): MarketParams {
  return { ...DEFAULT_PARAMS, ...over };
}

/**
 * n rapor gelip kapanan bir market kurar.
 * `stopAt` pozisyonunda durma zarı tutar.
 */
function playMarket(opts: {
  poolSize: number;
  prices: readonly number[];
  over?: Partial<MarketParams>;
  rng?: RandomSource;
}): Market {
  const p = params({ minPoolSize: opts.poolSize, ...opts.over });
  const stopAt = opts.prices.length;
  const rng =
    opts.rng ??
    new LabelledRandom({ 'draw-': DRAW, 'stop-': NO_STOP, [`stop-${stopAt}`]: STOP });

  const m = Market.create({ id: 'm', question: 'organik mi?', params: p }, rng);
  for (let i = 1; i <= opts.poolSize; i++) m.addBondedAgent(`agent-${String(i).padStart(2, '0')}`);
  m.closeBonding();

  for (const price of opts.prices) {
    if (m.status !== 'running') break;
    const a = m.drawNextAgent();
    if (!a) break;
    m.submitReport(a, beliefFromProbability(price));
    m.rollStoppingDice();
  }
  return m;
}

describe('requiredDeposit', () => {
  it('uniform prior ile b·log2 + k·R', () => {
    const p = params();
    expect(requiredDeposit(p, UNIFORM_PRIOR)).toBeCloseTo(p.b * Math.log(2) + p.k * p.R, 12);
  });

  it('b ile doğrusal ölçekleniyor', () => {
    const a = requiredDeposit(params({ b: 1, R: 0 }), UNIFORM_PRIOR);
    const c = requiredDeposit(params({ b: 3, R: 0 }), UNIFORM_PRIOR);
    expect(c).toBeCloseTo(3 * a, 12);
  });
});

describe('ödeme yapısı', () => {
  it('son k agent sabit ücret, geri kalanı skorlanıyor', () => {
    const m = playMarket({ poolSize: 20, prices: [0.6, 0.55, 0.7, 0.65, 0.8, 0.75, 0.78] });
    const s = computeSettlement(m.getState());

    expect(s.payouts).toHaveLength(7);
    const kinds = s.payouts.map((p) => p.kind);
    // k=3 -> ilk 4 skorlanır, son 3 sabit ücret
    expect(kinds).toEqual([
      'scored', 'scored', 'scored', 'scored',
      'flat-fee', 'flat-fee', 'flat-fee',
    ]);
    for (const p of s.payouts.filter((x) => x.kind === 'flat-fee')) {
      expect(p.amount).toBe(DEFAULT_PARAMS.R);
    }
  });

  it('n <= k ise herkes sabit ücret alıyor', () => {
    const m = playMarket({ poolSize: 20, prices: [0.6, 0.7] });
    const s = computeSettlement(m.getState());
    expect(s.payouts).toHaveLength(2);
    expect(s.payouts.every((p) => p.kind === 'flat-fee')).toBe(true);
    expect(s.scoreTotal).toBeCloseTo(2 * DEFAULT_PARAMS.R, 12);
  });

  it('referans agent da sabit ücret grubunda (son pozisyon)', () => {
    const m = playMarket({ poolSize: 20, prices: [0.6, 0.55, 0.7, 0.65, 0.8] });
    const s = computeSettlement(m.getState());
    const last = s.payouts[s.payouts.length - 1]!;
    expect(last.kind).toBe('flat-fee');
    expect(last.position).toBe(m.getState().referenceReport!.position);
  });

  it('doğru yöne iten kazanıyor, yanlış yöne iten kaybediyor', () => {
    // Referans 0.85 civarı olacak. İlk agent 0.5 -> 0.7 (doğru yön),
    // ikinci 0.7 -> 0.3 (yanlış yön).
    const m = playMarket({
      poolSize: 20,
      prices: [0.7, 0.3, 0.8, 0.85, 0.85, 0.85, 0.85],
    });
    const s = computeSettlement(m.getState());
    const first = s.payouts[0]!;
    const second = s.payouts[1]!;
    expect(first.kind).toBe('scored');
    expect(second.kind).toBe('scored');
    expect(first.amount).toBeGreaterThan(0);
    expect(second.amount).toBeLessThan(0);
  });
});

describe('DEĞİŞMEZ — bütçe sınırı', () => {
  it('100 rastgele markette skorlu ödemeler b·log2 aşmıyor', () => {
    for (let seed = 0; seed < 100; seed++) {
      const rng = new SeededRandom(seed);
      const prices: number[] = [];
      const n = 4 + Math.floor(rng.next('n') * 10);
      for (let i = 0; i < n; i++) prices.push(0.02 + rng.next(`p${i}`) * 0.96);

      const m = playMarket({ poolSize: 20, prices });
      const s = computeSettlement(m.getState());
      if (!s.reference) continue;

      const scoredTotal = s.payouts
        .filter((p) => p.kind === 'scored')
        .reduce((a, p) => a + p.amount, 0);
      const bound = maxTotalPayout(DEFAULT_PARAMS.b, UNIFORM_PRIOR, s.reference);
      expect(scoredTotal).toBeLessThanOrEqual(bound + 1e-9);
      expect(scoredTotal).toBeLessThanOrEqual(DEFAULT_PARAMS.b * Math.log(2) + 1e-9);
    }
  });
});

describe('DEĞİŞMEZ — muhasebe kapanıyor', () => {
  it('100 rastgele markette giriş = çıkış', () => {
    for (let seed = 200; seed < 300; seed++) {
      const rng = new SeededRandom(seed);
      const prices: number[] = [];
      const n = 1 + Math.floor(rng.next('n') * 12);
      for (let i = 0; i < n; i++) prices.push(0.02 + rng.next(`p${i}`) * 0.96);

      const m = playMarket({ poolSize: 20, prices });
      const s = computeSettlement(m.getState());

      const inflow = s.deposit + s.totalBonds;
      const outflow = s.totalToAgents + s.askerRefund;
      expect(inflow).toBeCloseTo(outflow, 9);
    }
  });

  it('timeout varken de muhasebe kapanıyor', () => {
    const rng = new LabelledRandom({ 'draw-': DRAW, 'stop-': NO_STOP, 'stop-5': STOP });
    const m = Market.create(
      { id: 'm', question: 'q', params: params({ minPoolSize: 20 }) },
      rng,
    );
    for (let i = 1; i <= 20; i++) m.addBondedAgent(`a${i}`);
    m.closeBonding();

    // İki agent timeout, sonra 5 rapor
    for (let i = 0; i < 2; i++) m.handleTimeout(m.drawNextAgent()!);
    for (const p of [0.6, 0.55, 0.7, 0.65, 0.8]) {
      if (m.status !== 'running') break;
      const a = m.drawNextAgent()!;
      m.submitReport(a, beliefFromProbability(p));
      m.rollStoppingDice();
    }

    const s = computeSettlement(m.getState());
    expect(s.timeoutSlash).toBeCloseTo(2 * DEFAULT_PARAMS.bondAmount, 12);
    expect(s.deposit + s.totalBonds).toBeCloseTo(s.totalToAgents + s.askerRefund, 9);
  });
});

describe('DEĞİŞMEZ — negatif para agentlara dağıtılmıyor', () => {
  it('scoreSlash tamamen askerRefunda akıyor', () => {
    const m = playMarket({
      poolSize: 20,
      prices: [0.9, 0.05, 0.9, 0.05, 0.95, 0.95, 0.95],
    });
    const s = computeSettlement(m.getState());
    expect(s.scoreSlash).toBeGreaterThan(0);

    // Asker'ın iadesi: deposit - pozitif ödemeler + slash edilenler
    const positive = s.payouts.reduce((a, p) => a + Math.max(0, p.amount), 0);
    expect(s.askerRefund).toBeCloseTo(
      s.deposit - positive + s.scoreSlash + s.timeoutSlash,
      9,
    );

    // Asıl garanti: soru soranın cebinden deposit'ten fazlası çıkmıyor.
    // (Pozitif ödemelerin TOPLAMI deposit'i aşabilir, çünkü negatiflerle
    // dengeleniyor. Anlamlı olan askerRefund >= 0.)
    expect(s.askerRefund).toBeGreaterThanOrEqual(-1e-9);
  });
});

describe('DEĞİŞMEZ — kayıp teminatı aşamıyor', () => {
  it('agresif ters hamlelerde bile hiçbir kayıp teminatı aşmıyor', () => {
    // Eskiden bu senaryo settlement'ta kırpılıyordu ve KIRPMA TELESKOPLAMAYI
    // BOZUYORDU: büyük kayıp kırpılınca karşı taraftaki büyük kazancı
    // dengeleyen para kayboluyor, fark soru sorana yıkılıyordu.
    // Artık hamle limiti rapor anında uygulanıyor, kırpmaya gerek yok.
    const m = playMarket({
      poolSize: 20,
      prices: [0.99, 0.01, 0.99, 0.01, 0.99, 0.99],
      over: { b: 50, bondAmount: 0.5 },
    });
    const s = computeSettlement(m.getState());
    for (const p of s.payouts) {
      expect(p.amount).toBeGreaterThanOrEqual(-0.5 - 1e-9);
    }
  });

  it('hamle limiti uygulanınca bütçe sınırı korunuyor', () => {
    // Bu tam olarak eski tasarımın çöktüğü senaryo.
    const m = playMarket({
      poolSize: 20,
      prices: [0.99, 0.01, 0.99, 0.99, 0.99, 0.99],
      over: { b: 50, bondAmount: 0.5 },
    });
    const s = computeSettlement(m.getState());
    const scoredTotal = s.payouts
      .filter((p) => p.kind === 'scored')
      .reduce((a, p) => a + p.amount, 0);
    expect(scoredTotal).toBeLessThanOrEqual(50 * Math.log(2) + 1e-9);
  });

  it('rapor hamle limitine kırpılıyor, ham değer korunuyor', () => {
    const m = playMarket({ poolSize: 20, prices: [0.999], over: { b: 1, bondAmount: 1 } });
    const rep = m.getState().reports[0]!;
    // prior 0.5, c = e^-1 = 0.368 -> izinli üst sınır 1 - 0.5*0.368 = 0.816
    expect(rep.belief[1]).toBeLessThan(0.999);
    expect(rep.belief[1]).toBeCloseTo(1 - 0.5 * Math.exp(-1), 6);
    expect(rep.rawBelief[1]).toBeCloseTo(0.999, 9);
  });

  it('büyük teminat daha geniş hamleye izin veriyor', () => {
    const small = playMarket({ poolSize: 20, prices: [0.99], over: { b: 1, bondAmount: 0.5 } });
    const large = playMarket({ poolSize: 20, prices: [0.99], over: { b: 1, bondAmount: 3 } });
    const sp = small.getState().reports[0]!.belief[1];
    const lp = large.getState().reports[0]!.belief[1];
    expect(lp).toBeGreaterThan(sp);
  });
});

describe('dejenere durumlar', () => {
  it('hiç rapor gelmeden herkes timeout olursa referanssız settlement', () => {
    const rng = new LabelledRandom({ 'draw-': DRAW, 'stop-': NO_STOP });
    const m = Market.create(
      { id: 'm', question: 'q', params: params({ k: 1, T: 1, alpha: 0.5, minPoolSize: 3 }) },
      rng,
    );
    for (let i = 1; i <= 3; i++) m.addBondedAgent(`a${i}`);
    m.closeBonding();
    for (let i = 0; i < 3; i++) {
      const a = m.drawNextAgent();
      if (!a) break;
      m.handleTimeout(a);
    }

    const s = computeSettlement(m.getState());
    expect(s.reference).toBeUndefined();
    expect(s.payouts).toHaveLength(0);
    expect(s.timeoutSlash).toBeCloseTo(3 * DEFAULT_PARAMS.bondAmount, 12);
    expect(s.bondsReturned).toBe(0);
    // Asker deposit'ini ve slash edilen teminatları alıyor
    expect(s.askerRefund).toBeCloseTo(s.deposit + s.timeoutSlash, 9);
    expect(s.deposit + s.totalBonds).toBeCloseTo(s.totalToAgents + s.askerRefund, 9);
  });

  it('cancelled markette settlement reddediliyor', () => {
    const m = Market.create(
      { id: 'm', question: 'q', params: params({ minPoolSize: 20 }) },
      new SeededRandom(1),
    );
    m.addBondedAgent('a1');
    m.closeBonding();
    expect(m.status).toBe('cancelled');
    expect(() => computeSettlement(m.getState())).toThrowError(/kapanmış markette/);
  });

  it('running markette settlement reddediliyor', () => {
    const rng = new LabelledRandom({ 'draw-': DRAW, 'stop-': NO_STOP });
    const m = Market.create(
      { id: 'm', question: 'q', params: params({ minPoolSize: 20 }) },
      rng,
    );
    for (let i = 1; i <= 20; i++) m.addBondedAgent(`a${i}`);
    m.closeBonding();
    expect(() => computeSettlement(m.getState())).toThrowError(/kapanmış markette/);
  });

  it('hiç çekilmeyen agentlar teminatını geri alıyor', () => {
    const m = playMarket({ poolSize: 20, prices: [0.6, 0.7, 0.65, 0.68] });
    const s = computeSettlement(m.getState());
    // 20 agent bond yatırdı, 4'ü rapor verdi, 16'sı hiç çekilmedi
    expect(s.bondsReturned).toBeCloseTo(20 * DEFAULT_PARAMS.bondAmount, 12);
    expect(s.timeoutSlash).toBe(0);
  });
});
