/**
 * Market state machine — paper §6.1'in uygulaması.
 *
 * Akış:
 *   bonding -> (N >= minPoolSize) -> running -> closed -> settled
 *           -> (N <  minPoolSize) -> cancelled
 *
 * Her turda: agent çek -> rapor al -> durma zarı at. Zar tutarsa kapan,
 * havuz tükenirse zorla kapan.
 *
 * Bu dosyada zorlanan dört kural mekanizmanın doğruluğu için kritik:
 *
 *   1. Bir agent bir markete EN FAZLA BİR KEZ katılır. Aksi halde agent hem
 *      erken rapor verip hem referans olabilir ve kendi eski skorunu maksimize
 *      eden referans raporu yazar (self-dealing).
 *   2. Sıra ÖNCEDEN hesaplanmaz, her turda taze rastgelelikle tek agent çekilir.
 *      Önceden yayınlanırsa son sıradaki agent referans olacağını bilir.
 *   3. Timeout durma zarını ATLAR. Aksi halde timeout'lar marketi erken kapatır.
 *   4. Referans HER ZAMAN terminal (son) agent'tır. Rolling window kullanılırsa
 *      paper Teorem 8'deki switching equilibrium oluşur: sonsuz ödeme,
 *      sınırsız zarar.
 */
import { assertValidParams, normalizeBelief, UNIFORM_PRIOR } from './config.js';
import { clipBelief, clipToAllowedMove } from './scoring.js';
import type {
  Belief,
  MarketParams,
  MarketState,
  RandomSource,
  Report,
} from './types.js';

export interface CreateMarketOptions {
  readonly id: string;
  readonly question: string;
  readonly params: MarketParams;
  /** Varsayılan uniform. */
  readonly prior?: Belief;
}

/** Boş bir market state'i üretir. Doğrulamayı da çalıştırır. */
export function createMarketState(opts: CreateMarketOptions): MarketState {
  assertValidParams(opts.params);
  return {
    id: opts.id,
    question: opts.question,
    params: opts.params,
    status: 'bonding',
    prior: opts.prior ? normalizeBelief(opts.prior) : UNIFORM_PRIOR,
    bondedAgents: [],
    drawnAgents: [],
    reports: [],
    timedOutAgents: [],
  };
}

export class Market {
  /** Bu pozisyon için durma zarı atıldı mı. Aynı rapora iki zar atılmasın. */
  private lastDiceRollPosition = 0;

  constructor(
    private readonly state: MarketState,
    private readonly rng: RandomSource,
  ) {}

  static create(opts: CreateMarketOptions, rng: RandomSource): Market {
    return new Market(createMarketState(opts), rng);
  }

  // ---------------------------------------------------------------- bonding

  /**
   * Bonding aşamasında agent ekler.
   *
   * Aynı agent iki kez eklenemez — bu, "bir agent bir markete en fazla bir kez
   * katılır" kuralının ilk savunma hattı.
   */
  addBondedAgent(agentId: string): void {
    if (this.state.status !== 'bonding') {
      throw new Error(
        `Bonding kapandı (durum: ${this.state.status}). Yeni agent eklenemez.`,
      );
    }
    if (this.state.bondedAgents.includes(agentId)) {
      throw new Error(`Agent ${agentId} zaten teminat yatırmış.`);
    }
    this.state.bondedAgents.push(agentId);
  }

  /**
   * Teminat kaydını geri alır — ödeme yerleşmediyse.
   *
   * NEDEN VAR. x402 katmanı handler'ı ödemeden ÖNCE çalıştırıyor: doğrula ->
   * handler -> settle. Settle patladığında istemci 402 alıyor ama handler'ın
   * yazdığı teminat kaydı yerinde kalıyor. O agent havuza parasız girmiş olur
   * ve settlement ona teminat iadesi öder — hazine tam bir bond kadar açık
   * verir. 2026-09-12'de zincir üstünde iki agent'ta gerçekleşti, fark tam
   * 2 HBAR (docs/step-log.md).
   *
   * Yalnızca bonding aşamasında geçerli. Market koşmaya başladıysa agent
   * çekilmiş olabilir ve kaydı silmek, mekanizmanın kim katıldı kaydını
   * bozar; o durumda geri alma değil, insan müdahalesi gerekir.
   */
  removeBondedAgent(agentId: string): void {
    if (this.state.status !== 'bonding') {
      throw new Error(
        `Teminat kaydı sadece bonding aşamasında geri alınabilir (şu an: ${this.state.status}). ` +
          `Market başladıktan sonra agent listesinden kimse silinemez.`,
      );
    }
    const i = this.state.bondedAgents.indexOf(agentId);
    if (i === -1) {
      throw new Error(`Agent ${agentId} bu markette teminat yatırmamış, geri alınacak kayıt yok.`);
    }
    this.state.bondedAgents.splice(i, 1);
  }

  /**
   * Bonding window'unu kapatır.
   *
   * `N < minPoolSize` ise market hiç başlamaz: `cancelled`, herkese tam iade.
   * Küçük havuzda mekanizma anlamsız — havuz sürekli tükenir ve durma zamanının
   * tahmin edilemezliği kaybolur.
   */
  closeBonding(): void {
    if (this.state.status !== 'bonding') {
      throw new Error(`closeBonding sadece bonding aşamasında çağrılabilir.`);
    }
    if (this.state.bondedAgents.length < this.state.params.minPoolSize) {
      this.state.status = 'cancelled';
      return;
    }
    this.state.status = 'running';
  }

  // ---------------------------------------------------------------- running

  /**
   * Sıradaki agent'ı çeker.
   *
   * Kalan teminatlı agent'lardan taze rastgelelikle SEÇER. Sırayı önceden
   * hesaplamaz. Çekilen agent havuzdan çıkarılır, bir daha çekilemez.
   */
  drawNextAgent(): string | null {
    if (this.state.status !== 'running') {
      throw new Error(`drawNextAgent sadece running durumunda çağrılabilir (şu an: ${this.state.status}).`);
    }
    if (this.state.pendingAgentId) {
      throw new Error(
        `Agent ${this.state.pendingAgentId} hâlâ rapor bekliyor. ` +
          `Önce submitReport veya handleTimeout çağrılmalı.`,
      );
    }
    if (this.state.bondedAgents.length === 0) return null;

    const position = this.state.reports.length + 1;
    const u = this.rng.next(`draw-${position}`);
    const idx = Math.min(this.state.bondedAgents.length - 1, Math.floor(u * this.state.bondedAgents.length));
    const agentId = this.state.bondedAgents[idx]!;

    this.state.bondedAgents.splice(idx, 1);
    this.state.drawnAgents.push(agentId);
    this.state.pendingAgentId = agentId;
    return agentId;
  }

  /**
   * Çekilen agent'ın raporunu kaydeder.
   *
   * Kırpma BURADA uygulanır. Agent ham değerini gönderir, protokol kırpar ve
   * ikisini de saklar — kırpmanın denetlenebilir olması için.
   */
  submitReport(agentId: string, rawBelief: Belief): Report {
    if (this.state.status !== 'running') {
      throw new Error(`submitReport sadece running durumunda çağrılabilir (şu an: ${this.state.status}).`);
    }
    if (this.state.pendingAgentId !== agentId) {
      throw new Error(
        `Sıra ${agentId}'de değil. Bekleyen agent: ${this.state.pendingAgentId ?? 'yok'}.`,
      );
    }

    const normalized = normalizeBelief(rawBelief);
    const { epsilon, b, bondAmount } = this.state.params;

    // İki aşamalı kırpma:
    //   1. epsilon — log(0) saldırısını kapatır (paper Ek C.2)
    //   2. hamle limiti — teminatın taşıyabileceğinden fazla oynatmayı engeller
    //
    // İkincisi olmadan bir agent teminatını aşan kayıp üretebilir; kaybı
    // settlement'ta kırpmak ise teleskoplamayı bozup soru soranın bütçe
    // garantisini yok ediyor. Sorunu burada, kaynağında engelliyoruz.
    const epsilonClipped = clipBelief(normalized, epsilon);
    const belief = clipToAllowedMove(epsilonClipped, this.currentPrice(), b, bondAmount, epsilon);

    const report: Report = {
      agentId,
      position: this.state.reports.length + 1,
      belief,
      rawBelief: normalized,
      timestamp: Date.now(),
    };
    this.state.reports.push(report);
    delete this.state.pendingAgentId;
    return report;
  }

  /**
   * Rapordan HEMEN SONRA çağrılır. `alpha` olasılıkla marketi kapatır.
   *
   * Kapanmazsa ve havuz da tükendiyse zorla kapatır. O durumda `closedReason`
   * `pool-exhausted` olur: son agent kendisinin sonuncu olduğunu bilebilirdi,
   * yani durma zamanının tahmin edilemezliği ihlal edilmiştir. Bu, README'de
   * raporlanan bilinen bir kısıt.
   *
   * @returns market kapandıysa true
   */
  rollStoppingDice(): boolean {
    if (this.state.status !== 'running') {
      throw new Error(`rollStoppingDice sadece running durumunda çağrılabilir.`);
    }
    if (this.state.pendingAgentId) {
      throw new Error(`Rapor beklenirken durma zarı atılamaz.`);
    }
    const position = this.state.reports.length;
    if (position === 0) {
      throw new Error(`Henüz rapor yok, durma zarı atılamaz.`);
    }
    if (position === this.lastDiceRollPosition) {
      throw new Error(`Pozisyon ${position} için durma zarı zaten atıldı.`);
    }
    this.lastDiceRollPosition = position;

    const u = this.rng.next(`stop-${position}`);
    if (u < this.state.params.alpha) {
      this.close('stopping-rule');
      return true;
    }
    if (this.state.bondedAgents.length === 0) {
      this.close('pool-exhausted');
      return true;
    }
    return false;
  }

  /**
   * Bekleyen agent zamanında cevap vermedi.
   *
   * Bond slash edilir, agent listeden düşer. **Durma zarı ATILMAZ** — timeout
   * bir tur değildir. Aksi halde cevap vermeyen agent'lar marketi erken
   * kapatabilir ve bu manipüle edilebilir bir kanal olurdu.
   */
  handleTimeout(agentId: string): void {
    if (this.state.status !== 'running') {
      throw new Error(`handleTimeout sadece running durumunda çağrılabilir.`);
    }
    if (this.state.pendingAgentId !== agentId) {
      throw new Error(
        `${agentId} rapor beklemiyor. Bekleyen: ${this.state.pendingAgentId ?? 'yok'}.`,
      );
    }
    this.state.timedOutAgents.push(agentId);
    delete this.state.pendingAgentId;

    // Timeout sonrası havuz boşaldıysa market devam edemez.
    // Hiç rapor gelmeden herkes timeout olduysa referans agent da yoktur;
    // settlement bu dejenere durumu ele almak zorunda (ADIM 9).
    if (this.state.bondedAgents.length === 0) {
      this.close('pool-exhausted');
    }
  }

  // ----------------------------------------------------------------- closing

  private close(reason: MarketState['closedReason']): void {
    this.state.status = 'closed';
    this.state.closedReason = reason;
    delete this.state.pendingAgentId;
    // Referans HER ZAMAN terminal agent. Rolling window kullanmak paper
    // Teorem 8'deki sonsuz ödemeli switching equilibrium'u açar.
    const last = this.state.reports[this.state.reports.length - 1];
    if (last) this.state.referenceReport = last;
  }

  /**
   * Kapanmış marketi `settled` olarak işaretler.
   *
   * Durum geçişi burada, çünkü state machine bu sınıfın sorumluluğu.
   * Orchestrator'ın `getState()` üzerinden `status` yazması, ödemeler
   * dağıtılmadan da bir marketi settled gösterebilirdi.
   */
  markSettled(): void {
    if (this.state.status !== 'closed') {
      throw new Error(
        `Sadece kapanmış market settled olabilir (şu an: ${this.state.status}).`,
      );
    }
    this.state.status = 'settled';
  }

  // ---------------------------------------------------------------- sorgular

  /** Marketin şu anki fiyatı: son rapor, yoksa prior. */
  currentPrice(): Belief {
    const last = this.state.reports[this.state.reports.length - 1];
    return last ? last.belief : this.state.prior;
  }

  /** Havuz tükendi mi (çekilebilecek agent kalmadı mı). */
  isPoolExhausted(): boolean {
    return this.state.bondedAgents.length === 0;
  }

  get status(): MarketState['status'] {
    return this.state.status;
  }

  get reportCount(): number {
    return this.state.reports.length;
  }

  getState(): Readonly<MarketState> {
    return this.state;
  }
}
