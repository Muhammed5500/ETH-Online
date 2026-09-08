/**
 * SKC self-resolving prediction market — temel tipler.
 *
 * Kaynak: Srinivasan, Karger, Chen — "Self-Resolving Prediction Markets for
 * Unverifiable Outcomes" (arXiv 2306.04305).
 *
 * Bu paket saf TypeScript'tir: ağ çağrısı, dosya erişimi ve ortam değişkeni
 * okumaz. Mekanizmanın doğruluğu burada testlerle kanıtlanır, zincire ADIM
 * 12+ ile bağlanır.
 */

/**
 * İkili sonuç üzerindeki inanç. `[P(Y=0), P(Y=1)]`, toplamı 1.
 *
 * Paper ikili sonuçla çalışıyor (Ω_Y = {0,1}). Kategorik sonuçlar için
 * 1-vs-all, sürekli sonuçlar için ayrıklaştırma öneriyor — ikisi de kapsam dışı.
 */
export type Belief = readonly [number, number];

/** Market parametreleri. Hepsi protokol seviyesinde ayarlanabilir, hardcode değil. */
export interface MarketParams {
  /**
   * Sabit ücret alan son agent sayısı.
   *
   * Paper'daki `k`: referans agent'ın sahip olduğu, agent t'nin erişemediği
   * bağımsız sinyal sayısı. Teorem 1/4 bunun alt sınırını veriyor.
   * `kcalc.ts` hesaplıyor (ADIM 10).
   */
  readonly k: number;

  /** Hedeflenen skorlanan agent sayısı. `alpha = 1/(T+k)` ilişkisini kurar. */
  readonly T: number;

  /** Her rapordan sonra marketin kapanma olasılığı. */
  readonly alpha: number;

  /**
   * Rapor kırpma sınırı. Raporlar `[epsilon, 1-epsilon]` aralığına kırpılır.
   *
   * Zorunlu: paper Ek C.2'deki switching equilibrium'un matematiği tam olarak
   * `log(0) = ∞`. Kırpma olmadan tek bir agent sınırsız skor üretebilir.
   */
  readonly epsilon: number;

  /** Skor ölçek/likidite parametresi. Asker'ın maksimum maliyeti `b·log2`. */
  readonly b: number;

  /** Son k agent'a ödenen sabit ücret. */
  readonly R: number;

  /** Bonding window kapanışında gereken minimum agent sayısı. Altındaysa iptal + iade. */
  readonly minPoolSize: number;

  /** Her agent'ın yatırdığı teminat. Negatif skorları karşılar. */
  readonly bondAmount: number;
}

/** Bir agent'ın tek raporu. */
export interface Report {
  readonly agentId: string;
  /** 1'den başlar. Marketteki kaçıncı rapor olduğu. */
  readonly position: number;
  /** Kırpılmış hali — skorlamada bu kullanılır. */
  readonly belief: Belief;
  /** Agent'ın gönderdiği ham hali. Kırpma denetlenebilsin diye saklanır. */
  readonly rawBelief: Belief;
  readonly timestamp: number;
  /** HCS mesaj referansı veya kanıt özeti (ADIM 13'te doldurulur). */
  readonly evidenceRef?: string;
}

export type MarketStatus =
  /** Agent'lar teminat yatırıyor, henüz rapor yok. */
  | 'bonding'
  /** Raporlar geliyor. */
  | 'running'
  /** Durdu, settlement bekliyor. */
  | 'closed'
  /** Ödemeler hesaplandı ve dağıtıldı. */
  | 'settled'
  /** N < minPoolSize — hiç başlamadı, herkese tam iade. */
  | 'cancelled';

/** Marketin neden kapandığı. Denetim ve README için önemli. */
export type ClosedReason =
  /** Durma zarı tuttu — normal kapanış. */
  | 'stopping-rule'
  /**
   * Havuz tükendi, zorla kapatıldı.
   *
   * Sonlu havuzda bu `(1-alpha)^(N-1)` olasılıkla olur. N=20, alpha=1/8 ile %7.9.
   * Mekanizma durma zamanının tahmin edilemez olmasını gerektiriyor; son
   * pozisyonda bu koşul sağlanmıyor. Bu yüzden ayrıca işaretleniyor.
   */
  | 'pool-exhausted';

export interface MarketState {
  readonly id: string;
  readonly question: string;
  readonly params: MarketParams;
  status: MarketStatus;
  /** `q^(0)` — market açılışındaki prior. Varsayılan `[0.5, 0.5]`. */
  readonly prior: Belief;
  /** Teminat yatırmış, henüz çekilmemiş agent'lar. */
  bondedAgents: string[];
  /** Çekilmiş agent'lar, çekilme sırasıyla. */
  drawnAgents: string[];
  reports: Report[];
  /** Kapanışta terminal agent'ın raporu. Herkes buna göre skorlanır. */
  referenceReport?: Report;
  closedReason?: ClosedReason;
  /** Timeout nedeniyle düşürülen agent'lar. Bond'ları slash edildi. */
  timedOutAgents: string[];
}

export interface Payout {
  readonly agentId: string;
  readonly position: number;
  /**
   * `scored`  — CE-MSR ile skorlandı, miktar negatif olabilir.
   * `flat-fee` — son k agent, sabit `R` aldı.
   */
  readonly kind: 'scored' | 'flat-fee';
  /** Ödeme miktarı. `scored` için negatif olabilir, bond'dan kesilir. */
  readonly amount: number;
  /** Ölçeklenmemiş ham `S_CEM` değeri. Denetim için. */
  readonly scoreRaw?: number;
  /** Bond'u aşan negatif skor kırpıldıysa, kırpılan miktar. */
  readonly clippedBy?: number;
}

export interface Settlement {
  readonly marketId: string;
  /** Referans agent'ın raporu. Herkesin skoru buna göre. */
  readonly reference: Belief;
  readonly payouts: readonly Payout[];
  /** Agent'lara giden net toplam (negatifler dahil). */
  readonly totalToAgents: number;
  /** Soru sorana geri dönen miktar. Slash edilen para da buraya akar. */
  readonly askerRefund: number;
  /** Negatif skorlardan kesilen toplam. Diğer agent'lara DAĞITILMAZ. */
  readonly slashed: number;
  /** Asker'ın yatırdığı deposit. Muhasebe denetimi için. */
  readonly deposit: number;
}

/**
 * Durma zarı ve agent çekimi için rastgelelik kaynağı.
 *
 * Testte deterministik (`SeededRandom`, `ScriptedRandom`), üretimde Hedera HCS
 * running hash'inden türetiliyor (ADIM 14). `label` hangi kararın alındığını
 * belirtir — denetimde işe yarar.
 */
export interface RandomSource {
  /** `[0, 1)` aralığında değer üretir. */
  next(label: string): number;
}
