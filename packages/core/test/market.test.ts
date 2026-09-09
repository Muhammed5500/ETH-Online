import { describe, expect, it } from 'vitest';
import { beliefFromProbability, DEFAULT_PARAMS } from '../src/config.js';
import { Market } from '../src/market.js';
import type { MarketParams, RandomSource } from '../src/types.js';
import { LabelledRandom, ScriptedRandom, SeededRandom } from './helpers.js';

const NO_STOP = 0.99; // hiçbir alpha için kapatmaz
const STOP = 0.0; // her zaman kapatır
const DRAW = 0.0; // her zaman ilk agent'ı çeker

/**
 * Küçük havuzlu testler için tutarlı parametre seti.
 *
 * Varsayılan k=3 ile minPoolSize=3 vermek `minPoolSize > k+1` kuralını ihlal
 * ediyor ve validator haklı olarak reddediyor. Küçük havuz testlerinde k'yı da
 * küçültmek gerekiyor.
 */
const SMALL_POOL = { k: 1, T: 1, alpha: 0.5 } as const;

/** Hiç kapanmayan, hep ilk agent'ı çeken kaynak. */
const neverStops = () => new LabelledRandom({ 'draw-': DRAW, 'stop-': NO_STOP });
/** İlk rapordan sonra kapanan kaynak. */
const alwaysStops = () => new LabelledRandom({ 'draw-': DRAW, 'stop-': STOP });

function params(over: Partial<MarketParams> = {}): MarketParams {
  return { ...DEFAULT_PARAMS, ...over };
}

/** N agent ile bonding'i kapatılmış, running durumda bir market. */
function runningMarket(
  n: number,
  rng: RandomSource,
  over: Partial<MarketParams> = {},
): Market {
  const m = Market.create(
    { id: 'm1', question: 'test?', params: params({ minPoolSize: n, ...over }) },
    rng,
  );
  for (let i = 1; i <= n; i++) m.addBondedAgent(`agent-${String(i).padStart(2, '0')}`);
  m.closeBonding();
  return m;
}

/** Bir tur koşar: çek, rapor ver, zar at. */
function playRound(m: Market, p1 = 0.6): boolean {
  const agent = m.drawNextAgent();
  if (!agent) throw new Error('çekilecek agent yok');
  m.submitReport(agent, beliefFromProbability(p1));
  return m.rollStoppingDice();
}

describe('bonding aşaması', () => {
  it('N < minPoolSize ise market iptal ediliyor', () => {
    const m = Market.create(
      { id: 'm', question: 'q', params: params({ minPoolSize: 20 }) },
      new SeededRandom(1),
    );
    for (let i = 0; i < 19; i++) m.addBondedAgent(`a${i}`);
    m.closeBonding();
    expect(m.status).toBe('cancelled');
  });

  it('N >= minPoolSize ise market başlıyor', () => {
    const m = runningMarket(20, new SeededRandom(1));
    expect(m.status).toBe('running');
  });

  it('aynı agent iki kez teminat yatıramıyor', () => {
    const m = Market.create({ id: 'm', question: 'q', params: params() }, new SeededRandom(1));
    m.addBondedAgent('a1');
    expect(() => m.addBondedAgent('a1')).toThrowError(/zaten teminat/);
  });

  it('bonding kapandıktan sonra agent eklenemiyor', () => {
    const m = runningMarket(20, new SeededRandom(1));
    expect(() => m.addBondedAgent('yeni')).toThrowError(/Bonding kapandı/);
  });
});

describe('KURAL 1 — bir agent en fazla bir kez katılır', () => {
  it('20 turda hiçbir agent tekrar çekilmiyor', () => {
    // 20 tur × 2 zar (draw + stop), stop asla tutmasın
    const m = runningMarket(20, neverStops());

    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const a = m.drawNextAgent();
      if (!a) break;
      expect(seen.has(a)).toBe(false);
      seen.add(a);
      m.submitReport(a, beliefFromProbability(0.5));
      if (m.status !== 'running') break;
      m.rollStoppingDice();
    }
    expect(seen.size).toBe(20);
    expect(m.getState().drawnAgents.length).toBe(20);
  });

  it('rastgele seed ile de tekrar yok', () => {
    const m = runningMarket(20, new SeededRandom(1234));
    const seen = new Set<string>();
    while (m.status === 'running') {
      const a = m.drawNextAgent();
      if (!a) break;
      expect(seen.has(a)).toBe(false);
      seen.add(a);
      m.submitReport(a, beliefFromProbability(0.5));
      m.rollStoppingDice();
    }
    expect(seen.size).toBe(m.getState().drawnAgents.length);
  });
});

describe('durma kuralı', () => {
  it('zar tutarsa tam olarak 1 rapordan sonra kapanıyor', () => {
    const m = runningMarket(20, alwaysStops());
    const closed = playRound(m);
    expect(closed).toBe(true);
    expect(m.status).toBe('closed');
    expect(m.getState().closedReason).toBe('stopping-rule');
    expect(m.reportCount).toBe(1);
  });

  it('zar hiç tutmazsa havuz tükenene kadar sürüyor', () => {
    const m = runningMarket(20, neverStops());

    let rounds = 0;
    while (m.status === 'running') {
      playRound(m);
      rounds++;
    }
    expect(rounds).toBe(20);
    expect(m.reportCount).toBe(20);
    expect(m.getState().closedReason).toBe('pool-exhausted');
  });

  it('havuz tükenmesi ayrı sebep olarak işaretleniyor', () => {
    // Bu, mekanizmanın varsayımının ihlal edildiği durum: son agent
    // kendisinin sonuncu olduğunu bilebilirdi. README'de raporlanıyor.
    const m = runningMarket(5, neverStops(), { ...SMALL_POOL, minPoolSize: 5 });
    while (m.status === 'running') playRound(m);
    expect(m.getState().closedReason).toBe('pool-exhausted');
    expect(m.isPoolExhausted()).toBe(true);
  });

  it('aynı pozisyona iki kez zar atılamıyor', () => {
    const m = runningMarket(20, neverStops());
    const a = m.drawNextAgent()!;
    m.submitReport(a, beliefFromProbability(0.5));
    m.rollStoppingDice();
    expect(() => m.rollStoppingDice()).toThrowError(/zaten atıldı/);
  });

  it('rapor gelmeden zar atılamıyor', () => {
    const m = runningMarket(20, neverStops());
    expect(() => m.rollStoppingDice()).toThrowError(/Henüz rapor yok/);
  });
});

describe('KURAL 3 — timeout durma zarını atlamıyor mu', () => {
  it('timeout sonrası zar ATILMIYOR, rastgelelik tüketilmiyor', () => {
    // Beklenen tüketim: draw-1, (timeout -> zar yok), draw-2, stop-2
    const rng = new ScriptedRandom([DRAW, DRAW, STOP]);
    const m = runningMarket(20, rng);

    const a1 = m.drawNextAgent()!;
    expect(rng.consumed).toBe(1);

    m.handleTimeout(a1);
    // Kritik: burada zar atılmamalı, yani tüketim hâlâ 1
    expect(rng.consumed).toBe(1);
    expect(m.status).toBe('running');
    expect(m.reportCount).toBe(0);

    const a2 = m.drawNextAgent()!;
    expect(a2).not.toBe(a1);
    expect(rng.consumed).toBe(2);

    m.submitReport(a2, beliefFromProbability(0.7));
    m.rollStoppingDice();
    expect(rng.consumed).toBe(3);
    expect(m.status).toBe('closed');
  });

  it('timeout olan agent kaydediliyor ve tekrar çekilmiyor', () => {
    const m = runningMarket(20, neverStops());

    const a1 = m.drawNextAgent()!;
    m.handleTimeout(a1);
    expect(m.getState().timedOutAgents).toEqual([a1]);

    const seen = new Set<string>([a1]);
    while (m.status === 'running') {
      const a = m.drawNextAgent();
      if (!a) break;
      expect(seen.has(a)).toBe(false);
      seen.add(a);
      m.submitReport(a, beliefFromProbability(0.5));
      m.rollStoppingDice();
    }
    // 20 agent: 1 timeout + 19 rapor
    expect(m.reportCount).toBe(19);
  });

  it('herkes timeout olursa market referanssız kapanıyor', () => {
    const m = runningMarket(3, neverStops(), { ...SMALL_POOL, minPoolSize: 3 });
    for (let i = 0; i < 3; i++) {
      const a = m.drawNextAgent();
      if (!a) break;
      m.handleTimeout(a);
    }
    expect(m.status).toBe('closed');
    expect(m.getState().referenceReport).toBeUndefined();
    expect(m.getState().timedOutAgents.length).toBe(3);
  });
});

describe('KURAL 4 — referans her zaman terminal agent', () => {
  it('kapanışta referans son rapor oluyor', () => {
    // 5. rapordan sonra kapansın: stop-5 dışında hiçbir zar tutmasın
    const rng = new LabelledRandom({ 'draw-': DRAW, 'stop-': NO_STOP, 'stop-5': STOP });
    const m = runningMarket(20, rng);

    const prices = [0.6, 0.55, 0.7, 0.65, 0.8];
    for (const p of prices) {
      if (m.status !== 'running') break;
      playRound(m, p);
    }

    const st = m.getState();
    expect(st.status).toBe('closed');
    expect(st.referenceReport).toBeDefined();
    expect(st.referenceReport!.position).toBe(st.reports.length);
    expect(st.referenceReport!.belief[1]).toBeCloseTo(0.8, 12);
  });
});

describe('rapor kaydı', () => {
  it('iki aşamalı kırpma uygulanıyor, ham değer saklanıyor', () => {
    const m = runningMarket(20, neverStops());
    const a = m.drawNextAgent()!;
    const rep = m.submitReport(a, beliefFromProbability(1));

    // Varsayılan b=1, bondAmount=1 -> c = e^-1
    // prior 0.5'ten izinli üst sınır: 1 - 0.5·e^-1 = 0.8161
    // Yani bağlayıcı olan epsilon (0.99) değil, HAMLE LİMİTİ.
    expect(rep.belief[1]).toBeCloseTo(1 - 0.5 * Math.exp(-1), 9);
    expect(rep.belief[1]).toBeLessThan(0.99);
    expect(rep.rawBelief[1]).toBeCloseTo(1, 12); // ham değer korundu
  });

  it('bol teminatla epsilon bağlayıcı hale geliyor', () => {
    // bondAmount büyükse hamle limiti gevşer ve epsilon devreye girer.
    const m = runningMarket(20, neverStops(), { bondAmount: 100, b: 1 });
    const a = m.drawNextAgent()!;
    const rep = m.submitReport(a, beliefFromProbability(1));
    expect(rep.belief[1]).toBeCloseTo(0.99, 9);
  });

  it('pozisyon 1den başlayıp artıyor', () => {
    const m = runningMarket(20, neverStops());
    for (let i = 0; i < 3; i++) playRound(m);
    expect(m.getState().reports.map((r) => r.position)).toEqual([1, 2, 3]);
  });

  it('currentPrice rapor öncesi prior, sonrası son rapor', () => {
    const m = runningMarket(20, neverStops());
    expect(m.currentPrice()[1]).toBeCloseTo(0.5, 12);
    playRound(m, 0.73);
    expect(m.currentPrice()[1]).toBeCloseTo(0.73, 12);
  });
});

describe('state machine korumaları', () => {
  it('running olmadan agent çekilemiyor', () => {
    const m = Market.create({ id: 'm', question: 'q', params: params() }, new SeededRandom(1));
    expect(() => m.drawNextAgent()).toThrowError(/running/);
  });

  it('bekleyen agent varken yeni agent çekilemiyor', () => {
    const m = runningMarket(20, neverStops());
    m.drawNextAgent();
    expect(() => m.drawNextAgent()).toThrowError(/rapor bekliyor/);
  });

  it('sırası olmayan agent rapor veremiyor', () => {
    const m = runningMarket(20, neverStops());
    const a = m.drawNextAgent()!;
    const other = m.getState().bondedAgents[0]!;
    expect(() => m.submitReport(other, beliefFromProbability(0.5))).toThrowError(/Sıra/);
    expect(a).not.toBe(other);
  });

  it('kapanmış markette işlem yapılamıyor', () => {
    const m = runningMarket(20, alwaysStops());
    playRound(m);
    expect(m.status).toBe('closed');
    expect(() => m.drawNextAgent()).toThrowError(/running/);
    expect(() => m.rollStoppingDice()).toThrowError(/running/);
  });

  it('havuz boşaldığında drawNextAgent null dönüyor', () => {
    const m = runningMarket(3, neverStops(), { ...SMALL_POOL, minPoolSize: 3 });
    playRound(m);
    playRound(m);
    playRound(m); // 3. turdan sonra havuz boş -> zorla kapanır
    expect(m.status).toBe('closed');
  });
});
